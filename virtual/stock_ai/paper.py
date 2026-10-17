from datetime import datetime, time
from zoneinfo import ZoneInfo
import pandas as pd
import exchange_calendars as xc
from .config import Settings,TRAINING_VERSION
from .costs import buy_position,target_price,settle

SEOUL=ZoneInfo('Asia/Seoul')


def symbol_identity(symbol):
    if symbol is None:return None
    return symbol.get('market'),symbol.get('code')


class PaperEngine:
    def __init__(self,store,provider,predictor=None):
        self.store,self.provider=store,provider
        if predictor is None:
            from .original_analysis import analyze
            def predictor(df,s,symbol):
                if hasattr(self.provider,'original_prices'):
                    raw,_=self.provider.original_prices(symbol['code'],symbol['market'])
                    df=raw.loc[raw.index <= df.index[-1]]
                market=None
                if s.feature_set=='expanded':
                    from .service import market_input
                    market,_=market_input(self.provider,symbol,s)
                return analyze(df,s,market=market,compare=False,symbol=symbol)
        self.predictor=predictor
        self.calendar=xc.get_calendar('XKRX')

    def status(self):
        return self.store.get('paper',{'enabled':False,'cash':10000000,'position':None,'pending':None,
                                      'symbol':None,'settings':Settings().model_dump(),'signal':None,
                                      'orders':[],'trades':[],'processed':[],'message':'가상 매매가 꺼져 있습니다.'})

    def configure(self,symbol,settings,enabled):
        if symbol.get('market')!='KR' or not str(symbol.get('code','')).isdigit():
            raise ValueError('자동 가상 매매는 한국 원화 종목만 지원합니다.')
        with self.store.transaction() as con:
            state=self.store.get('paper',self.status(),con)
            if state['symbol'] is None:
                state['cash']=settings.capital
            changed = symbol_identity(state['symbol']) != symbol_identity(symbol) or state['settings'] != settings.model_dump()
            if state.get('pending') and (changed or not enabled):
                pending_day = state['pending']['day']
                for order in state['orders']:
                    if order['day'] == pending_day and order['type'] == 'BUY_NEXT_OPEN' and order['status'] == 'reserved':
                        order['status'] = 'cancelled'
                state['pending'] = None
            state.update({'symbol':symbol,'settings':settings.model_dump(),'enabled':enabled})
            state['signal']=None
            state['message']='일봉 가상 체결: 08:00 예약, 장 마감 후 정산. 비용은 예시 설정입니다.'
            self.store.put('paper',state,con)
        return state

    def set_signal(self,signal,expected_symbol=None,expected_settings=None):
        with self.store.transaction() as con:
            state=self.store.get('paper',self.status(),con)
            if (not state['enabled'] or not state['symbol'] or
                (expected_symbol is not None and symbol_identity(state['symbol']) != symbol_identity(expected_symbol)) or
                (expected_settings is not None and state['settings'] != expected_settings)):
                return False
            state['signal']={**signal,'code':state['symbol']['code'],'settings':state['settings']}
            self.store.put('paper',state,con)
            return True

    def reserve(self,day=None,now=None):
        now=now or datetime.now(SEOUL)
        day=day or now.date().isoformat()
        if not self.calendar.is_session(day):
            return self.status()
        with self.store.transaction() as con:
            state=self.store.get('paper',self.status(),con)
            key='reserve:'+day
            if not state['enabled'] or self.store.get(key,False,con):
                return state
            # Orders cannot be created retrospectively after the open.
            if now.date().isoformat()!=day or now.time()>=time(9):
                state['message']='장 시작 이후 매수 예약을 소급 생성하지 않습니다. 다음 거래일 08:00에 예약합니다.'
                self.store.put('paper',state,con)
                return state
            if state['position']:
                sell_type = 'SELL_SWITCH_OPEN' if state['position']['symbol']['code'] != state['symbol']['code'] else 'SELL'
                state['orders'].append({'day':day,'type':sell_type,'code':state['position']['symbol']['code'],
                                        'target':state['position']['target'],'status':'reserved'})
            elif state.get('signal'):
                signal=state['signal']
                previous=str(self.calendar.previous_session(day).date())
                original=(signal.get('analysis_method')=='original-close-v1' and
                          signal.get('training_version')==TRAINING_VERSION)
                if not original:
                    state['message']='이전 방식 또는 학습 기간의 신호입니다. 최근 5년 기준의 다음 신호 갱신이 필요합니다.'
                if (signal['as_of']==previous and signal['code']==state['symbol']['code'] and
                    signal['settings']==state['settings'] and original and signal.get('latest_signal')==1):
                    state['pending']={'day':day,'symbol':state['symbol'],'settings':state['settings'],
                                      'probability':signal.get('probability'),
                                      'entry_signal':signal.get('latest_signal')}
                    state['orders'].append({'day':day,'type':'BUY_NEXT_OPEN','code':state['symbol']['code'],'status':'reserved'})
            state['orders']=state['orders'][-500:]
            self.store.put(key,True,con)
            self.store.put('paper',state,con)
            return state

    def reconcile(self,day=None):
        day=day or datetime.now(SEOUL).date().isoformat()
        state=self.status()
        if not state['enabled'] or not self.calendar.is_session(day) or day in state['processed']:
            return state
        symbol=(state.get('position') or {}).get('symbol') or (state.get('pending') or {}).get('symbol') or state['symbol']
        df,meta=self.provider.prices(symbol['code'],Settings(**state['settings']).years,'KR',completed_today=True)
        if pd.Timestamp(day) not in df.index:
            with self.store.transaction() as con:
                current=self.store.get('paper',state,con)
                current['message']=f'{day} 완료 일봉이 없습니다. 오래된 자료로 매매하지 않습니다.'
                self.store.put('paper',current,con)
            return current
        row=df.loc[pd.Timestamp(day)]
        with self.store.transaction() as con:
            state=self.store.get('paper',state,con)
            if day in state['processed'] or not state['enabled']:
                return state
            current_symbol = (state.get('position') or {}).get('symbol') or (state.get('pending') or {}).get('symbol') or state['symbol']
            if current_symbol['code'] != symbol['code']:
                return state
            pending=state.get('pending')
            entered=False
            if not state['position'] and pending and pending['day']==day:
                try:
                    position=buy_position(state['cash'],row.Open,Settings(**pending['settings']))
                    position.update({'symbol':pending['symbol'],'buy_date':day,'target':target_price(position),
                                     'probability':pending.get('probability'),
                                     'entry_signal':pending.get('entry_signal')})
                    state['position']=position
                    entered=True
                except ValueError as exc:
                    state['message']=str(exc)
                state['pending']=None
            position=state['position']
            if position:
                ps=Settings(**position['costs'])
                held=int(len(self.calendar.sessions_in_range(position['buy_date'],day)))
                reserved=entered or any(o['day']==day and o['type']=='SELL' and o['status']=='reserved' for o in state['orders'])
                switching=any(o['day']==day and o['type']=='SELL_SWITCH_OPEN' and
                              o['status']=='reserved' and o['code']==position['symbol']['code'] for o in state['orders'])
                hit=reserved and row.High>=position['target']*(1+ps.fill_buffer_pct/100)
                expired=held>=ps.horizon
                if switching or hit or expired:
                    exit_price=(float(row.Open)*(1-ps.slippage_pct/100) if switching else
                                position['target'] if hit else float(row.Close)*(1-ps.slippage_pct/100))
                    result=settle(position,exit_price)
                    state['cash']=result['cash']
                    state['trades'].append({'symbol':position['symbol'],'buy_date':position['buy_date'],'sell_date':day,
                                            'quantity':position['quantity'],'buy_price':position['entry_price'],
                                            'sell_price':exit_price,'target':position['target'],'buy_fee':position['buy_fee'],
                                            'reason':'switch' if switching else 'target' if hit else 'expiry','cash_before':position['capital'],
                                            'cash_after':result['cash'],**result})
                    state['position']=None
                state['mark_equity']=settle(state['position'],float(row.Close))['cash'] if state['position'] else state['cash']
            for order in state['orders']:
                if order['day']==day and order['status']=='reserved':
                    order['status']='settled'
            state['processed'].append(day)
            state['message']=f'{day} 정산 완료. 실제 주문은 전송하지 않습니다.'
            self.store.put('paper',state,con)
        # Compute next-session signals outside the database transaction.
        current=self.status()
        try:
            selected=current['symbol']
            if selected['code']!=symbol['code']:
                df,_=self.provider.prices(selected['code'],Settings(**current['settings']).years,'KR',completed_today=True)
            prediction=self.predictor(df,Settings(**current['settings']),selected)
            if prediction['as_of']==day:
                next_signal=({'latest_signal':prediction['latest_signal'],
                              'analysis_method':prediction['analysis_method']} if 'latest_signal' in prediction
                             else {'probability':prediction['latest_probability']})
                self.set_signal({**next_signal,'as_of':prediction['as_of']},
                                expected_symbol=selected,expected_settings=current['settings'])
        except Exception as exc:
            with self.store.transaction() as con:
                current=self.store.get('paper',self.status(),con)
                current['signal']=None
                current['message']+=f' 다음 신호 계산 실패: {exc}'
                self.store.put('paper',current,con)
        return self.status()
