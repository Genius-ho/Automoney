from contextlib import asynccontextmanager
from copy import deepcopy
from datetime import datetime
from pathlib import Path
from typing import Literal
from zoneinfo import ZoneInfo
import uuid
import re
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse,Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field,model_validator,model_serializer
from apscheduler.schedulers.background import BackgroundScheduler
from .config import Settings,TRAINING_VERSION
from .store import Store
from .data import DataProvider
from .symbols import SymbolResolver
from .paper import PaperEngine
from .universe_paper import UniversePaperEngine,UniverseSettings
from .paper_export import export_paper_workbook
from .comparison import ComparisonEngine
from .comparison_export import export_comparison
from .strategy_c import EqualWeightEngine
from .strategy_d import engines as allocation_engines
from .strategy_f import StrategyMixEngine
from .strategy_k import HoldIndexEngine
from .strategy_etf import InfiniteBuyEngine, ValueRebalanceEngine, IndexValueRebalanceEngine
from .service import JobService, analysis_job, batch_job, portfolio_job
from .portfolio import kelly,weight_limits

ROOT=Path(__file__).resolve().parent.parent


class Symbol(BaseModel):
    code:str=Field(pattern=r'^[A-Za-z0-9.^:_-]{1,30}$')
    name:str=Field(min_length=1,max_length=100)
    market:Literal['KR','US']='KR'
    name_en:str|None=Field(None,max_length=256)
    name_ko:str|None=Field(None,max_length=256)
    industry:str|None=Field(None,max_length=100)
    asset_type:Literal['stock','ETF']|None=None

    @model_serializer(mode='wrap')
    def serialize(self,handler):
        return {key:value for key,value in handler(self).items() if value is not None}


class AnalyzeRequest(BaseModel):
    symbol:Symbol
    settings:Settings=Field(default_factory=Settings)
    csv:str=Field('',max_length=10000000)


class PaperRequest(BaseModel):
    symbol:Symbol
    settings:Settings=Field(default_factory=Settings)
    enabled:bool


class UniversePaperRequest(BaseModel):
    config:UniverseSettings=Field(default_factory=UniverseSettings)
    enabled:bool


class PortfolioRequest(BaseModel):
    symbols:list[Symbol]=Field(min_length=2,max_length=10)
    years:int=Field(5,ge=1,le=20)
    capital:float=Field(100000000,gt=0,le=1e12,allow_inf_nan=False)
    currency:Literal['KRW','USD']|None=None
    buy_fee_pct:float=Field(.015,ge=0,le=5,allow_inf_nan=False)
    slippage_pct:float=Field(.05,ge=0,le=5,allow_inf_nan=False)
    min_weight_pct:float=Field(5,ge=0,le=50,allow_inf_nan=False)
    max_weight_pct:float=Field(40,ge=10,le=100,allow_inf_nan=False)

    @model_validator(mode='after')
    def compatible_symbols(self):
        for symbol in self.symbols:
            if symbol.market=='US':
                symbol.code=symbol.code.upper()
        if len({(s.market,s.code) for s in self.symbols})!=len(self.symbols):
            raise ValueError('중복 종목을 제거하세요.')
        weight_limits(len(self.symbols),self.min_weight_pct/100,self.max_weight_pct/100)
        return self


class KellyRequest(BaseModel):
    probability:float=Field(ge=0,le=1,allow_inf_nan=False)
    payoff:float=Field(gt=0,allow_inf_nan=False)
    loss:float|None=Field(None,gt=0,allow_inf_nan=False)


def create_app(data_dir=None,provider=None,scheduler=True):
    directory=Path(data_dir or ROOT/'stock_ai_data')
    store=Store(directory/'stock-ai.sqlite')
    provider=provider or DataProvider(directory/'prices')
    resolver=SymbolResolver(directory)
    def display_result(result):
        if not isinstance(result,dict):return result
        result=deepcopy(result)
        def enrich(symbol):
            if symbol.get('market')!='US':return symbol
            match=next((r for r in resolver.search(symbol['code'])
                        if r['code']==symbol['code'].upper() and r['market']=='US'),None)
            if not match:return symbol
            return {**symbol,**{key:match[key] for key in ('name','name_en','name_ko','industry','asset_type')
                               if match.get(key)}}
        if isinstance(result.get('symbol'),dict):result['symbol']=enrich(result['symbol'])
        if isinstance(result.get('symbols'),list):result['symbols']=[enrich(s) for s in result['symbols']]
        for row in result.get('allocations',[]):row['symbol']=enrich(row['symbol'])
        return result
    jobs=JobService(store)
    paper=PaperEngine(store,provider)
    universe_paper=UniversePaperEngine(store,provider)
    comparison=ComparisonEngine(store,provider)
    strategy_c=EqualWeightEngine(store,provider)
    strategy_d=allocation_engines(store,provider)
    strategy_f=StrategyMixEngine(store,provider)
    strategy_k=HoldIndexEngine(store,provider)
    etf_engines={'g':InfiniteBuyEngine(store,provider),'h':ValueRebalanceEngine(store,provider),'i':IndexValueRebalanceEngine(store,provider)}

    def strategy_d_status():
        return {v:e.status() for v,e in strategy_d.items()}

    def strategy_d_run(operation):
        def run(progress):
            for i,(v,e) in enumerate(strategy_d.items()):
                state=e.status()
                if operation=='start' or state['enabled'] or state['positions']:
                    step=lambda p,m,i=i:progress(int(i*33+p*.33),m)
                    e.start(progress=step) if operation=='start' else e.daily(progress=step)
            return strategy_d_status()
        return run
    clock=BackgroundScheduler(timezone='Asia/Seoul')

    def submit_job(kind, operation, request=None):
        try:
            return jobs.submit(kind, operation, request)
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc

    def scheduled(operation):
        try:
            jobs.submit('paper',lambda progress:operation())
        except ValueError:
            pass

    @asynccontextmanager
    async def lifespan(app):
        if scheduler:
            clock.add_job(lambda:scheduled(paper.reserve),'cron',hour=8,minute=0,id='reserve',
                          coalesce=True,max_instances=1,misfire_grace_time=1800)
            clock.add_job(lambda:scheduled(paper.reconcile),'cron',hour=18,minute=0,id='settle',
                          coalesce=True,max_instances=1,misfire_grace_time=3600)
            def daily_universe():
                state=universe_paper.status()
                if state['enabled'] or state['positions']:
                    try:
                        jobs.submit('universe-paper',lambda progress:universe_paper.daily(progress))
                    except ValueError:
                        pass
            clock.add_job(daily_universe,'cron',hour=18,minute=10,id='universe-settle',
                          coalesce=True,max_instances=1,misfire_grace_time=3600)
            def daily_comparison():
                state=comparison.status()
                if state['enabled'] or any(a['positions'] for a in state['accounts'].values()):
                    try:jobs.submit('comparison-paper',lambda progress:comparison.daily(progress=progress))
                    except ValueError:pass
            clock.add_job(daily_comparison,'cron',hour=18,minute=10,id='comparison-settle',
                          coalesce=True,max_instances=1,misfire_grace_time=3600)
            def daily_strategy_c():
                state=strategy_c.status()
                if state['enabled'] or state['positions']:
                    try:jobs.submit('strategy-c',lambda progress:strategy_c.daily(progress=progress))
                    except ValueError:pass
            clock.add_job(daily_strategy_c,'cron',hour=18,minute=20,id='strategy-c-settle',
                          coalesce=True,max_instances=1,misfire_grace_time=3600)
            def daily_strategy_d():
                if any(s['enabled'] or s['positions'] for s in strategy_d_status().values()):
                    try:jobs.submit('strategy-d',strategy_d_run('daily'))
                    except ValueError:pass
            clock.add_job(daily_strategy_d,'cron',hour=18,minute=25,id='strategy-d-settle',
                          coalesce=True,max_instances=1,misfire_grace_time=3600)
            def daily_strategy_f():
                state=strategy_f.status()
                if state['enabled'] or state['positions']:
                    try:jobs.submit('strategy-f',lambda progress:strategy_f.daily(progress=progress))
                    except ValueError:pass
            clock.add_job(daily_strategy_f,'cron',hour=18,minute=35,id='strategy-f-settle',
                          coalesce=True,max_instances=1,misfire_grace_time=3600)
            def daily_strategy_k():
                state=strategy_k.status()
                if state['enabled'] or state['positions']:
                    try:jobs.submit('strategy-k',lambda progress:strategy_k.daily(progress=progress))
                    except ValueError:pass
            clock.add_job(daily_strategy_k,'cron',hour=18,minute=40,id='strategy-k-settle',
                          coalesce=True,max_instances=1,misfire_grace_time=3600)
            def daily_etf(market):
                # US closes ~05:00-06:00 KST, Korea 15:30; missed sessions are replayed in order.
                for name,engine in etf_engines.items():
                    if engine.market!=market:continue
                    state=engine.status()
                    if state['enabled'] or state['shares']:
                        try:jobs.submit('strategy-'+name,lambda progress,engine=engine:engine.daily(progress=progress))
                        except ValueError:pass
            clock.add_job(lambda:daily_etf('US'),'cron',hour=7,minute=30,id='strategy-us-settle',
                          coalesce=True,max_instances=1,misfire_grace_time=3600)
            clock.add_job(lambda:daily_etf('KR'),'cron',hour=18,minute=45,id='strategy-kr-etf-settle',
                          coalesce=True,max_instances=1,misfire_grace_time=3600)
            clock.start()
            if datetime.now(ZoneInfo('Asia/Seoul')).hour>=7:
                daily_etf('US')
            if datetime.now(ZoneInfo('Asia/Seoul')).hour>=18 and paper.status()['enabled']:
                scheduled(paper.reconcile)
            if datetime.now(ZoneInfo('Asia/Seoul')).hour>=18:
                daily_universe()
                daily_comparison()
                daily_strategy_c()
                daily_strategy_d()
                daily_strategy_f()
                daily_strategy_k()
                daily_etf('KR')
        yield
        if clock.running:
            clock.shutdown(wait=False)
        jobs.close()

    app=FastAPI(title='주가 AI 연구실',lifespan=lifespan)
    app.state.store,app.state.jobs,app.state.paper=store,jobs,paper
    app.state.universe_paper=universe_paper
    app.state.comparison=comparison
    app.state.strategy_c=strategy_c
    app.mount('/static',StaticFiles(directory=ROOT/'static'),name='static')

    @app.get('/')
    def home():
        # Always revalidate the page so script/style version bumps reach the browser.
        return FileResponse(ROOT/'static'/'index.html',headers={'Cache-Control':'no-cache'})

    @app.get('/api/health')
    def health():
        return {'ok':True,'timezone':'Asia/Seoul','paper_only':True}

    @app.get('/api/settings')
    def settings():
        return store.get('settings',Settings().model_dump())

    @app.put('/api/settings')
    def update_settings(values:Settings):
        store.put('settings',values.model_dump())
        return values.model_dump()

    @app.get('/api/symbols')
    def symbols(q:str=Query(default='',max_length=100),market:Literal['KR','US']|None=None):
        return {'candidates':resolver.search(q,market)}

    @app.post('/api/symbols/refresh',status_code=202)
    def refresh_symbols(market:Literal['KR','US','ALL']='KR'):
        def operation(progress):
            progress(5,'종목 목록 갱신')
            for selected_market in (('KR','US') if market=='ALL' else (market,)):
                resolver.refresh(selected_market)
            return {'count':len(resolver.rows)}
        return {'id':submit_job('symbols',operation)}

    @app.post('/api/analyze',status_code=202)
    def submit_analysis(payload:AnalyzeRequest):
        identifier=uuid.uuid4().hex
        def operation(progress):
            result=analysis_job(payload.model_dump(),provider,directory/'reports',identifier,progress)
            store.put('latest_analysis',result)
            return result
        try:
            return {'id':submit_job('analysis',operation)}
        except ValueError as exc:
            raise HTTPException(409,str(exc))

    @app.post('/api/batch',status_code=202)
    def batch(values:Settings):
        identifier=uuid.uuid4().hex
        def operation(progress):
            result=batch_job(values,provider,directory/'reports',identifier,progress)
            store.put('latest_batch',result)
            return result
        return {'id':submit_job('batch',operation)}

    @app.get('/api/batch/latest')
    def latest_batch():
        return store.get('latest_batch')

    @app.get('/api/jobs')
    def list_jobs():
        return [{k:v for k,v in store.get(key).items() if k!='result'} for key in store.keys('job:')[:20]]

    @app.get('/api/jobs/{identifier}')
    def get_job(identifier:str):
        if not re.fullmatch('[a-f0-9]{32}',identifier) or not jobs.get(identifier):
            raise HTTPException(404,'작업을 찾을 수 없습니다.')
        return jobs.get(identifier)

    @app.get('/api/latest')
    def latest():
        return display_result(store.get('latest_analysis'))

    @app.get('/api/paper')
    def paper_status():
        return paper.status()

    @app.get('/api/universe-paper')
    def universe_paper_status():
        return universe_paper.status(include_activity=True)

    @app.get('/api/comparison-paper')
    def comparison_status():
        return comparison.status()

    @app.post('/api/comparison-paper/start',status_code=202)
    def start_comparison():
        with jobs.lock:
            was_enabled=comparison.metadata()['enabled']
            revision=comparison.enable()
            try:
                return {'id':submit_job('comparison-paper',lambda progress:comparison.run(progress=progress,expected_revision=revision))}
            except HTTPException:
                if not was_enabled and comparison.metadata()['revision']==revision:
                    comparison.stop()
                raise

    @app.post('/api/comparison-paper/stop')
    def stop_comparison():
        return comparison.stop()

    @app.post('/api/comparison-paper/reconcile',status_code=202)
    def reconcile_comparison():
        return {'id':submit_job('comparison-paper',lambda progress:comparison.daily(progress=progress))}

    @app.get('/api/strategy-c')
    def strategy_c_status():
        return strategy_c.status()

    @app.post('/api/strategy-c/start',status_code=202)
    def start_strategy_c():
        return {'id':submit_job('strategy-c',lambda progress:strategy_c.start(progress=progress))}

    @app.post('/api/strategy-c/stop')
    def stop_strategy_c():
        return strategy_c.stop()

    @app.post('/api/strategy-c/reconcile',status_code=202)
    def reconcile_strategy_c():
        return {'id':submit_job('strategy-c',lambda progress:strategy_c.daily(progress=progress))}

    @app.get('/api/strategy-d')
    def get_strategy_d():
        return strategy_d_status()

    @app.post('/api/strategy-d/start',status_code=202)
    def start_strategy_d():
        return {'id':submit_job('strategy-d',strategy_d_run('start'))}

    @app.post('/api/strategy-d/stop')
    def stop_strategy_d():
        for e in strategy_d.values():e.stop()
        return strategy_d_status()

    @app.post('/api/strategy-d/reconcile',status_code=202)
    def reconcile_strategy_d():
        return {'id':submit_job('strategy-d',strategy_d_run('daily'))}

    @app.get('/api/strategy-f')
    def get_strategy_f():
        return strategy_f.status()

    @app.post('/api/strategy-f/start',status_code=202)
    def start_strategy_f():
        return {'id':submit_job('strategy-f',lambda progress:strategy_f.start(progress=progress))}

    @app.post('/api/strategy-f/stop')
    def stop_strategy_f():
        return strategy_f.stop()

    @app.post('/api/strategy-f/reconcile',status_code=202)
    def reconcile_strategy_f():
        return {'id':submit_job('strategy-f',lambda progress:strategy_f.daily(progress=progress))}

    for name,engine in etf_engines.items():
        def routes(name=name,engine=engine):
            @app.get('/api/strategy-'+name)
            def get_us():
                return engine.status()

            @app.post('/api/strategy-'+name+'/start',status_code=202)
            def start_us():
                return {'id':submit_job('strategy-'+name,lambda progress:engine.start(progress=progress))}

            @app.post('/api/strategy-'+name+'/stop')
            def stop_us():
                return engine.stop()

            @app.post('/api/strategy-'+name+'/reconcile',status_code=202)
            def reconcile_us():
                return {'id':submit_job('strategy-'+name,lambda progress:engine.daily(progress=progress))}
        routes()

    @app.get('/api/strategy-k')
    def get_strategy_k():
        return strategy_k.status()

    @app.post('/api/strategy-k/start',status_code=202)
    def start_strategy_k():
        return {'id':submit_job('strategy-k',lambda progress:strategy_k.start(progress=progress))}

    @app.post('/api/strategy-k/stop')
    def stop_strategy_k():
        return strategy_k.stop()

    @app.post('/api/strategy-k/reconcile',status_code=202)
    def reconcile_strategy_k():
        return {'id':submit_job('strategy-k',lambda progress:strategy_k.daily(progress=progress))}

    @app.get('/api/comparison-paper/export.xlsx')
    def comparison_workbook():
        return Response(export_comparison(comparison.status()),
            media_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            headers={'Content-Disposition':'attachment; filename="stock-ai-comparison.xlsx"','Cache-Control':'no-store'})

    @app.get('/api/universe-paper/export.xlsx')
    def export_universe_paper(result_filter:Literal['all','candidate','below','budget','error','duplicate','cash']='all'):
        content=export_paper_workbook(universe_paper.status(),result_filter)
        stamp=datetime.now(ZoneInfo('Asia/Seoul')).strftime('%Y-%m-%d')
        return Response(content,media_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            headers={'Content-Disposition':f'attachment; filename="stock-ai-paper-{stamp}.xlsx"','Cache-Control':'no-store'})

    @app.post('/api/universe-paper/configure')
    def configure_universe_paper(payload:UniversePaperRequest):
        try:
            return universe_paper.configure(payload.config.model_dump(),payload.enabled)
        except ValueError as exc:
            raise HTTPException(400,str(exc)) from exc

    @app.post('/api/universe-paper/scan',status_code=202)
    def scan_universe_paper():
        return {'id':submit_job('universe-paper',lambda progress:universe_paper.scan(progress=progress))}

    @app.post('/api/universe-paper/reconcile',status_code=202)
    def reconcile_universe_paper():
        if datetime.now(ZoneInfo('Asia/Seoul')).hour<18:
            raise HTTPException(400,'종가 체결 정산은 한국 시간 18:00 이후 가능합니다.')
        return {'id':submit_job('universe-paper',lambda progress:universe_paper.daily(progress))}

    @app.post('/api/paper/configure')
    def configure_paper(payload:PaperRequest):
        try:
            state=paper.configure(payload.symbol.model_dump(),payload.settings,payload.enabled)
            latest=store.get('latest_analysis')
            if (latest and latest.get('analysis_method')=='original-close-v1' and
                latest.get('training_version')==TRAINING_VERSION and (latest.get('analysis_window') or {}).get('years')==5 and
                latest['symbol']['code']==payload.symbol.code and
                latest['settings']==payload.settings.model_dump()):
                paper.set_signal({'latest_signal':latest['latest_signal'],'analysis_method':latest['analysis_method'],
                                  'training_version':latest['training_version'],'as_of':latest['as_of']},
                                 expected_symbol=payload.symbol.model_dump(),expected_settings=payload.settings.model_dump())
                state=paper.status()
            return state
        except ValueError as exc:
            raise HTTPException(400,str(exc))

    @app.post('/api/paper/prepare',status_code=202)
    def prepare_paper():
        snapshot=paper.status()
        if not snapshot['symbol']:
            raise HTTPException(400,'먼저 종목과 비용을 설정하세요.')
        def operation(progress):
            symbol=snapshot['symbol']
            df,_=provider.prices(symbol['code'],Settings(**snapshot['settings']).years,'KR',completed_today=True)
            result=paper.predictor(df,Settings(**snapshot['settings']),symbol)
            current=paper.status()
            if current['symbol']==symbol and current['settings']==snapshot['settings']:
                paper.set_signal({'latest_signal':result['latest_signal'],'analysis_method':result['analysis_method'],
                                  'training_version':result['training_version'],'as_of':result['as_of']},
                                 expected_symbol=symbol,expected_settings=snapshot['settings'])
            return paper.status()
        return {'id':submit_job('paper',operation)}

    @app.post('/api/paper/reconcile',status_code=202)
    def reconcile_paper():
        if datetime.now(ZoneInfo('Asia/Seoul')).hour<18:
            raise HTTPException(400,'완료 일봉 정산은 한국 시간 18:00 이후 가능합니다.')
        return {'id':submit_job('paper',lambda progress:paper.reconcile())}

    @app.post('/api/portfolio',status_code=202)
    def portfolio(payload:PortfolioRequest):
        def operation(progress):
            result=portfolio_job(payload.model_dump(),provider,progress)
            store.put('latest_portfolio',result)
            return result
        return {'id':submit_job('portfolio',operation,payload.model_dump())}

    @app.get('/api/portfolio/latest')
    def latest_portfolio():
        return display_result(store.get('latest_portfolio'))

    @app.post('/api/kelly')
    def calculate_kelly(payload:KellyRequest):
        raw=kelly(payload.probability,payload.payoff,payload.loss)
        return {'raw_fraction':raw,'long_only_fraction':max(0,min(1,raw))}

    @app.get('/api/reports/{identifier}/{filename}')
    def report(identifier:str,filename:str):
        if not re.fullmatch(r'[a-f0-9]{32}(?:_\d{6})?',identifier):
            raise HTTPException(404,'보고서를 찾을 수 없습니다.')
        if filename not in ['result.json','report.md','predictions.csv','comparison.csv','folds.csv',
                             *[f'{kind}_{mode}.csv' for kind in ['trades','equity'] for mode in ['touch','buffer','stress']]]:
            raise HTTPException(404,'보고서 파일을 찾을 수 없습니다.')
        path=directory/'reports'/identifier/filename
        if not path.is_file():
            raise HTTPException(404,'보고서 파일을 찾을 수 없습니다.')
        return FileResponse(path,filename=filename)

    return app
