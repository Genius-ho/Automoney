// Exercise the actual application script against the elements in its HTML.
// This checks event handling; ui-smoke.cjs separately checks real rendering.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {test} = require('node:test');
const html = fs.readFileSync('static/index.html', 'utf8');
const script = fs.readFileSync('static/app.js', 'utf8')+'\n'+fs.readFileSync('static/comparison.js','utf8');

function screen(fetchOverride) {
  const nodes = new Map();
  function element(id='',value='') {
    return {id,value,textContent:'',innerHTML:'',hidden:false,style:{},dataset:{},
      classList:{toggle(){}},children:[],append(...children){this.children.push(...children);},replaceChildren(){this.children=[];this.innerHTML='';},attributes:{},setAttribute(name,value){this.attributes[name]=value;},listeners:{},addEventListener(name,fn){this.listeners[name]=fn;},
      clientWidth:640,getContext(){return new Proxy({}, {get:(_,key)=>key==='createLinearGradient'?
        ()=>({addColorStop(){}}):()=>{}});}};
  }
  for (const match of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const value=match[0].match(/\bvalue="([^"]*)"/)?.[1] || '';
    nodes.set(match[1],element(match[1],value));
  }
  for(const match of html.matchAll(/<select\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)){
    nodes.get(match[1]).value=match[2].match(/value="([^"]+)"/)?.[1]??'';
  }
  const nav=Array.from(html.matchAll(/data-tab="([^"]+)"/g),match=>({...element(),dataset:{tab:match[1]}}));
  const paper={enabled:false,symbol:null,cash:10000000,position:null,orders:[],trades:[],message:'off'};
  const universe={enabled:false,config:{capital:100000000,criterion:'probability',buy_fee_pct:.015,sell_fee_pct:.015,sell_tax_pct:.2,slippage_pct:.05},cash:100000000,budget:1000000,mark_equity:100000000,return_pct:0,positions:{},pending:{},trades:[],equity:[],candidates:[],errors:[],scan:null,message:'off'};
  const defaults={horizon:10,target_pct:2,threshold_pct:60,years:10,capital:10000000,
    buy_fee_pct:.015,sell_fee_pct:.015,sell_tax_pct:.2,slippage_pct:.05,fill_buffer_pct:.05};
  const document={getElementById:id=>nodes.get(id)||null,createElement:()=>element(),
    querySelectorAll:selector=>selector==='nav button'?nav:selector==='.tab'?
      ['analyze','paper','comparison','portfolio'].map(id=>nodes.get(id)).filter(Boolean):[]};
  const context={document,window:{devicePixelRatio:1,addEventListener(){}},
    requestAnimationFrame:fn=>fn(),setInterval(){},setTimeout,clearTimeout,
    fetch:async(path,options={})=>{
      let data;
      if(path==='/api/settings')data=defaults;
      else if(path.startsWith('/api/symbols')) data={candidates:[{code:'005930',name:'삼성전자',market:'KR'}]};
      else if(path==='/api/paper')data=paper;
      else if(path==='/api/universe-paper')data=universe;
      else if(path==='/api/comparison-paper')data=null;
      else if(path==='/api/jobs')data=[];
      else if(path==='/api/kelly'){
        const body=JSON.parse(options.body);
        const fraction=body.loss==null?body.probability-(1-body.probability)/body.payoff:
          body.probability/body.loss-(1-body.probability)/body.payoff;
        data={raw_fraction:fraction,long_only_fraction:Math.max(0,Math.min(1,fraction))};
      } else data=null;
      return {ok:true,json:async()=>data};
    }};
  if(fetchOverride){const original=context.fetch;context.fetch=(path,options)=>fetchOverride(path,options,original);}
  vm.createContext(context);vm.runInContext(script,context);
  return {nodes,context};
}

function comparisonFixture(){
  const config={capital:1e9,buy_fee_pct:.015,sell_fee_pct:.015,sell_tax_pct:.2,slippage_pct:.05};
  const account=()=>({enabled:true,metrics:{net_equity:1e9,return_pct:0,max_drawdown_pct:0,realized_profit:0,trade_count:0,win_rate:null,pending_count:1,holding_count:0,invested_pct:0,valuation_date:'2026-10-08',stale_positions:0},equity:[],candidates:[],cycle_summary:[],activity:[],errors:[],next_scan_day:'2026-10-19',scan:{as_of:'2026-10-08'}});
  return {enabled:true,started_day:'2026-10-08',config,accounts:{a:account(),b:account()},comparison:{comparable:true,return_difference_pct:0,message:'체결·청산 기록 대기'}};
}

test('both account histories stay visible at the top and selection list can be hidden',async()=>{
  const {nodes,context}=screen();await new Promise(resolve=>setTimeout(resolve,0));
  const state=comparisonFixture();
  const row=name=>({cycle_id:3,status:'reserved',symbol:{name,code:'000001'},buy_date:'2026-10-12',sell_date:'2026-10-26'});
  state.accounts.a.activity=[row('A 예약종목')];state.accounts.b.activity=[row('B 최신종목')];
  state.accounts.b.config={holding_mode:'trading_sessions'};
  state.b_universe={label:'코스피200·코스닥150 고정 구성종목',rows:Array.from({length:351},(_,i)=>({code:String(i)}))};
  context.layoutFixture=state;vm.runInContext('renderComparison(layoutFixture)',context);
  assert.equal(nodes.has('comparison-account'),false);
  assert.match(nodes.get('comparison-a-activity').innerHTML,/A 예약종목/);
  assert.match(nodes.get('comparison-b-activity').innerHTML,/B 최신종목/);
  assert.ok(html.indexOf('id="comparison-history"')<html.indexOf('id="comparison-b-funnel"'));
  assert.match(nodes.get('comparison-selection-title').textContent,/351종목/);
  assert.match(nodes.get('comparison-b-scope').textContent,/10거래일/);
  assert.doesNotMatch(nodes.get('comparison-selection-meta').textContent,/같은 목록/);
  nodes.get('comparison-selection-toggle').onclick();
  assert.equal(nodes.get('comparison-selection-body').hidden,true);
  assert.equal(nodes.get('comparison-selection-toggle').attributes['aria-expanded'],'false');
  vm.runInContext('renderComparison(layoutFixture)',context);
  assert.equal(nodes.get('comparison-selection-body').hidden,true);
  nodes.get('comparison-selection-toggle').onclick();
  assert.equal(nodes.get('comparison-selection-body').hidden,false);
});

test('comparison screen distinguishes two score meanings and filters B-only candidates',async()=>{
  const {nodes,context}=screen();await new Promise(resolve=>setTimeout(resolve,0));
  const state=comparisonFixture();
  state.accounts.a.candidates=[{code:'005930',name:'삼성전자',exchange:'KOSPI',rank:1,score:.5,signal:0,status:'기준 미달'}];
  state.accounts.b.candidates=[{code:'005930',name:'삼성전자',exchange:'KOSPI',rank:1,score:.7,status:'매수 후보',reason:'검증 우위 통과',validation:{selected_hit_rate:.65,base_rate:.4,selected_mean_return_pct:1}}];
  context.compareFixture=state;vm.runInContext('renderComparison(compareFixture)',context);
  assert.match(nodes.get('comparison-selections').innerHTML,/A 과거 적중률/);
  assert.match(nodes.get('comparison-selections').innerHTML,/B 수익 확률/);
  assert.equal(nodes.get('comparison-start').textContent,'비교 계속하기');
  nodes.get('comparison-filter').value='b_only';nodes.get('comparison-filter').onchange();
  assert.match(nodes.get('comparison-selections').innerHTML,/삼성전자/);
  nodes.get('comparison-filter').value='both';nodes.get('comparison-filter').onchange();
  assert.doesNotMatch(nodes.get('comparison-selections').innerHTML,/삼성전자/);
  state.comparison={comparable:false,return_difference_pct:null,message:'가격 누락'};
  state.incomplete_day='2026-10-12';state.settlement_errors=[{name:'삼성전자',code:'005930'}];
  vm.runInContext('renderComparison(compareFixture)',context);
  assert.equal(nodes.get('comparison-difference').textContent,'비교 보류');
  assert.match(nodes.get('comparison-status').textContent,/2026-10-12 가격 누락.*삼성전자.*재시도/);
});

test('comparison job shows the current strategy and stock then renders both accounts',async()=>{
  const state=comparisonFixture();let polls=0;
  const {nodes,context}=screen(async(path,options,original)=>{
    if(path==='/api/jobs/compare')return {ok:true,json:async()=>++polls===1?{status:'running',message:'B · 삼성전자 · 학습',progress:65}:{status:'done',message:'완료',progress:100,result:state}};
    return original(path,options);
  });
  await new Promise(resolve=>setTimeout(resolve,0));
  context.setTimeout=fn=>{assert.match(nodes.get('comparison-status').textContent,/B · 삼성전자/);assert.equal(nodes.get('comparison-start').disabled,true);fn();};
  await vm.runInContext("poll('compare',renderComparison,{comparison:true})",context);
  assert.equal(nodes.get('comparison-start').disabled,false);
  assert.match(nodes.get('comparison-summary-body').innerHTML,/비용 차감 평가액<\/th><td[^>]*>1,000,000,000원<\/td><td[^>]*>1,000,000,000원/);
  assert.match(nodes.get('comparison-status').textContent,/A 예약 1 \/ B 예약 1종목/);
});

test('comparison explains zero current candidates separately from historical validation',async()=>{
  const {nodes,context}=screen();await new Promise(resolve=>setTimeout(resolve,0));
  const state=comparisonFixture();state.accounts.b.metrics.pending_count=0;
  state.accounts.b.candidates=[{name:'기업은행',score:.5909135889,entry_allowed:true,status:'기준 미달'},
    {name:'자료 부족',score:null,status:'분석 제외',error:'history'}];
  context.evidenceFixture=state;vm.runInContext('renderComparison(evidenceFixture)',context);
  const funnel=nodes.get('comparison-b-funnel').innerHTML;
  assert.match(funnel,/이번 확률 ≥60%<\/small><b>0종목/);
  assert.match(funnel,/과거 검증 조건 통과<\/small><b>1종목/);
  assert.match(nodes.get('comparison-b-reason').textContent,/기업은행 59\.09%.*분석 제외 1종목/);
  assert.match(nodes.get('comparison-evidence').textContent,/현금 대기.*예측력이 더 좋은지는 아직 평가할 수 없습니다/);
  assert.match(html,/A와 B는 무엇을 다르게 배우나요/);
  assert.match(html,/96원 → 106원/);
});

test('comparison separates pending trades and completed trade evidence',async()=>{
  const {nodes,context}=screen();await new Promise(resolve=>setTimeout(resolve,0));
  const state=comparisonFixture();context.evidenceFixture=state;
  vm.runInContext('renderComparison(evidenceFixture)',context);
  assert.match(nodes.get('comparison-evidence').textContent,/청산 거래는 아직 없습니다/);
  state.accounts.b.metrics.trade_count=3;state.accounts.a.metrics.trade_count=5;
  vm.runInContext('renderComparison(evidenceFixture)',context);
  assert.match(nodes.get('comparison-evidence').textContent,/청산 거래 A 5건 \/ B 3건/);
  state.incomplete_day='2026-10-12';
  vm.runInContext('renderComparison(evidenceFixture)',context);
  assert.match(nodes.get('comparison-evidence').textContent,/계좌 성과 비교를 보류/);
});

test('comparison uses the saved B threshold and displays the revision history',async()=>{
  const {nodes,context}=screen();await new Promise(resolve=>setTimeout(resolve,0));
  const state=comparisonFixture();
  state.selection_rules={probability_threshold:.52,min_validation_signals:20};
  state.improved_method='trade-outcome-oof-v2-p52';
  state.selection_revisions=[{changed_at:'2026-10-11T12:00:00',from_method:'trade-outcome-oof-v1',to_method:state.improved_method}];
  state.accounts.b.candidates=[{name:'기업은행',score:.59,entry_allowed:true,status:'매수 후보'},
    {name:'경계 종목',score:.52,entry_allowed:true,status:'매수 후보'},
    {name:'미달 종목',score:.5199,entry_allowed:true,status:'기준 미달'}];
  context.thresholdFixture=state;vm.runInContext('renderComparison(thresholdFixture)',context);
  assert.match(nodes.get('comparison-b-funnel').innerHTML,/이번 확률 ≥52%<\/small><b>2종목/);
  assert.match(nodes.get('comparison-b-rule').textContent,/52%/);
  assert.match(nodes.get('comparison-rule-history').textContent,/2026-10-11.*60%.*52%/);
  state.selection_rules.probability_threshold=.6;
  vm.runInContext('renderComparison(thresholdFixture)',context);
  assert.match(nodes.get('comparison-b-funnel').innerHTML,/이번 확률 ≥60%<\/small><b>0종목/);
});

test('a single fuzzy analysis candidate requires clicking the suggested name',async()=>{
  const {nodes,context}=screen(async(path,options,original)=>path.startsWith('/api/symbols?')?
    {ok:true,json:async()=>({candidates:[{code:'005930',name:'삼성전자',market:'KR',match_type:'fuzzy'}]})}:original(path,options));
  await new Promise(resolve=>setTimeout(resolve,0));
  nodes.get('query').value='삼성저낮';await vm.runInContext('search()',context);
  assert.equal(vm.runInContext('selected',context),null);
  assert.match(nodes.get('selected-symbol').textContent,/비슷한/);
  assert.match(nodes.get('candidates').children[0].textContent,/유사/);
  nodes.get('candidates').children[0].onclick();
  assert.equal(vm.runInContext('selected.code',context),'005930');
});

test('unified ETF portfolio search labels suggestions before adding alongside Korean stocks',async()=>{
  let requested;
  const {nodes,context}=screen(async(path,options,original)=>{
    if(path.startsWith('/api/symbols?')){requested=path;return {ok:true,json:async()=>({candidates:[{code:'IBIT',name:'iShares Bitcoin Trust ETF',market:'US',asset_type:'ETF',match_type:'fuzzy'}]})};}
    return original(path,options);
  });
  await new Promise(resolve=>setTimeout(resolve,0));
  vm.runInContext("addPortfolioSymbol({code:'005930',name:'삼성전자',market:'KR'})",context);
  nodes.get('portfolio-query').value='비트코인 이티에프';await vm.runInContext('searchPortfolio()',context);
  assert.doesNotMatch(requested,/market=/);
  assert.equal(vm.runInContext('portfolioSymbols.length',context),1);
  const candidate=nodes.get('portfolio-candidates').children[0];
  assert.match(candidate.textContent,/ETF/);assert.match(candidate.textContent,/유사/);
  await candidate.onclick();assert.equal(vm.runInContext('portfolioSymbols[1].code',context),'IBIT');
  assert.equal(nodes.get('portfolio-candidates').children.length,0);
});

test('late search responses cannot overwrite a newer stock selection or portfolio query',async()=>{
  const responses=[];
  const {nodes,context}=screen();
  await new Promise(resolve=>setTimeout(resolve,0));
  context.fetch=()=>new Promise(resolve=>responses.push(resolve));
  const reply=(i,code,name)=>responses[i]({ok:true,json:async()=>({candidates:[{code,name,market:'KR'}]})});
  nodes.get('query').value='005930';const older=vm.runInContext('search()',context);
  nodes.get('query').value='000660';const newer=vm.runInContext('search()',context);
  reply(1,'000660','SK하이닉스');await newer;
  reply(0,'005930','삼성전자');await older;
  assert.equal(vm.runInContext('selected.code',context),'000660');
  nodes.get('portfolio-query').value='삼성';const stale=vm.runInContext('searchPortfolio()',context);
  nodes.get('portfolio-query').value='현대';reply(2,'005930','삼성전자');await stale;
  assert.equal(nodes.get('portfolio-candidates').children.length,0);
});

test('100-stock paper view distinguishes score and shows positions and exit reason',async()=>{
  const {nodes,context}=screen();
  await vm.runInContext('refreshUniversePaper()',context);
  assert.match(nodes.get('universe-cards').innerHTML,/종목당 예산/);
  vm.runInContext(`renderUniversePaper({enabled:true,config:{capital:100000000,criterion:'precision'},cash:90000000,budget:1000000,mark_equity:101000000,return_pct:1,positions:{a:{symbol:{name:'셀트리온',code:'068270'},quantity:3,buy_date:'2026-10-07',entry_close:100,last_close:104,last_price_date:'2026-10-08',holding_days:1}},pending:{},equity:[],errors:[],scan:{criterion:'precision',as_of:'2026-10-08',analyzed:100,eligible:10,errors:0},candidates:[{name:'셀트리온',code:'068270',exchange:'KOSPI',rank:1,score:.7,close:104,status:'매수 후보'}],trades:[{symbol:{name:'a'},quantity:1,buy_date:'2026-10-01',sell_date:'2026-10-08',reason:'stop_loss',net_return_pct:-4,profit:-100}],message:'ready'})`,context);
  assert.match(nodes.get('universe-candidates').innerHTML,/과거 적중률/);
  assert.match(nodes.get('universe-positions').innerHTML,/셀트리온/);
  assert.match(nodes.get('universe-trades').innerHTML,/손절/);
  assert.equal(nodes.get('universe-capital').disabled,true);
});

test('universe metric help explains fold precision and the current binary signal on click',async()=>{
  const {nodes,context}=screen();
  await new Promise(resolve=>setTimeout(resolve,0));
  const state=await vm.runInContext("api('/api/universe-paper')",context);
  state.config.criterion='precision';
  state.candidates=[{name:'삼성전자',code:'005930',exchange:'KOSPI',rank:1,status:'매수 후보',score:.7,signal:1}];
  context.helpState=state;
  vm.runInContext('renderUniversePaper(helpState)',context);
  assert.match(nodes.get('universe-candidates').innerHTML,/aria-label="과거 적중률 설명"/);
  assert.match(nodes.get('universe-candidates').innerHTML,/aria-label="신호 설명"/);
  const trigger={dataset:{metricHelp:'precision'},setAttribute(name,value){this[name]=value;}};
  nodes.get('universe-candidates').listeners.click({target:{closest:()=>trigger}});
  assert.equal(nodes.get('universe-metric-help').hidden,false);
  assert.match(nodes.get('universe-metric-help-text').textContent,/실제로 목표를 달성한 수.*상승 신호를 낸 수/);
  assert.match(nodes.get('universe-metric-help-text').textContent,/단순 평균/);
  assert.equal(trigger['aria-expanded'],'true');
  trigger.dataset.metricHelp='signal';
  nodes.get('universe-candidates').listeners.click({target:{closest:()=>trigger}});
  assert.match(nodes.get('universe-metric-help-text').textContent,/60% 이상이면 1/);
  assert.match(nodes.get('universe-metric-help-text').textContent,/60% 이상.*신호.*1/);
  nodes.get('universe-metric-help').listeners.keydown({key:'Escape'});
  assert.equal(nodes.get('universe-metric-help').hidden,true);
});

test('old saved scans disclose the previous threshold without changing their signals',async()=>{
  const {nodes,context}=screen();
  await new Promise(resolve=>setTimeout(resolve,0));
  const state=await vm.runInContext("api('/api/universe-paper')",context);
  state.config.criterion='precision';
  state.scan={criterion:'precision',as_of:'2026-10-08',analyzed:100,eligible:1,errors:0};
  state.candidates=[{name:'종목',code:'005930',status:'매수 후보',score:.7,signal:1}];context.helpState=state;
  vm.runInContext('renderUniversePaper(helpState)',context);
  assert.match(nodes.get('universe-score-note').textContent,/기존 50%.*새 분석부터 60%/);
  vm.runInContext("openUniverseMetricHelp('signal')",context);
  assert.match(nodes.get('universe-metric-help-text').textContent,/50%.*저장/);
  assert.equal(vm.runInContext('universeCandidates[0].signal',context),1);
  state.scan.signal_threshold=.6;
  vm.runInContext('renderUniversePaper(helpState)',context);
  assert.doesNotMatch(nodes.get('universe-score-note').textContent,/기존 50%/);
});

test('calibrated probability help follows the displayed result criterion',async()=>{
  const {nodes,context}=screen();
  await new Promise(resolve=>setTimeout(resolve,0));
  const state=await vm.runInContext("api('/api/universe-paper')",context);
  state.config.criterion='precision';state.scan={criterion:'probability',as_of:'2026-10-08',analyzed:100,eligible:1,errors:0};
  state.candidates=[{name:'종목',code:'005930',status:'매수 후보',score:.7,signal:null}];context.helpState=state;
  vm.runInContext('renderUniversePaper(helpState)',context);
  assert.match(nodes.get('universe-candidates').innerHTML,/data-metric-help="probability"/);
  vm.runInContext("openUniverseMetricHelp('probability')",context);
  assert.match(nodes.get('universe-metric-help-text').textContent,/로지스틱 회귀/);
  vm.runInContext("openUniverseMetricHelp('signal')",context);
  assert.match(nodes.get('universe-metric-help-text').textContent,/—.*계산하지/);
});

test('selected stock determines the capital currency shown to the user',()=>{
  const {nodes,context}=screen();
  vm.runInContext("choose({code:'AAPL',name:'Apple',market:'US'})",context);
  assert.ok(nodes.get('capital-label'),'Currency label must exist');
  assert.match(nodes.get('capital-label').textContent,/USD/);
  vm.runInContext("choose({code:'005930',name:'삼성전자',market:'KR'})",context);
  assert.match(nodes.get('capital-label').textContent,/원/);
});

test('financial result colors distinguish gains and losses without coloring probabilities',()=>{
  const {nodes,context}=screen();
  vm.runInContext("table('trade-table',['종목','손익 금액','손익 %','적중률'],[['A','1,200','3.15%','70%'],['B','-800','-2%','40%']]);cards('holdout-cards',[['수익률','5%'],['적중률','80%']])",context);
  const view=nodes.get('trade-table').innerHTML;
  assert.match(view,/<td[^>]* class="up">1,200<\/td>/);assert.match(view,/<td[^>]* class="down">-800<\/td>/);
  assert.match(view,/<td[^>]* class="up">3.15%<\/td>/);assert.match(view,/<td[^>]* class="down">-2%<\/td>/);
  assert.match(view,/<td[^>]*>70%<\/td>/);assert.match(nodes.get('holdout-cards').innerHTML,/<b class="up">5%<\/b>/);
});

test('trade overview displays scheduled dates and real execution profit without inventing pending prices',async()=>{
  const {nodes,context}=screen();
  await new Promise(resolve=>setTimeout(resolve,0));
  context.activityState=await vm.runInContext("api('/api/universe-paper')",context);
  context.activityState.activity=[
    {symbol:{name:'예약 종목',code:'005930'},status:'reserved',buy_date:'2026-10-12',sell_date:'2026-10-26',quantity:null,average_price:null,current_price:70000,price_date:'2026-10-08',sell_price:null,profit:null,return_pct:null},
    {symbol:{name:'보유 종목',code:'000660'},status:'held',buy_date:'2026-10-12',sell_date:'2026-10-26',quantity:9,average_price:100,current_price:104,price_date:'2026-10-13',sell_price:null,profit:-19.8,return_pct:-1.98},
    {symbol:{name:'매도 종목',code:'068270'},status:'sold',buy_date:'2026-10-12',sell_date:'2026-10-14',quantity:9,average_price:100,current_price:null,price_date:null,sell_price:110,profit:31.5,return_pct:3.15}
  ];
  vm.runInContext('renderUniversePaper(activityState)',context);
  const view=nodes.get('universe-pending').innerHTML;
  assert.match(view,/평단가/);assert.match(view,/현재가/);assert.match(view,/매도가/);assert.match(view,/손익 금액/);
  assert.match(view,/2026-10-12\s*\(예정\)/);assert.match(view,/2026-10-26\s*\(만기 예정\)/);
  assert.match(view,/예약 종목.*70,000/s);assert.match(view,/보유 종목.*-1.98%/s);
  assert.match(view,/매도 완료.*매도 종목/s);assert.match(view,/3.15%/);
  assert.doesNotMatch(view,/NaN|undefined/);
});

test('job completion waits for asynchronous result rendering',async()=>{
  const {context}=screen();
  context.fetch=async()=>({ok:true,json:async()=>({status:'done',message:'done',progress:100,result:{}})});
  await vm.runInContext("completed=false;poll('example',async()=>{await new Promise(resolve=>setTimeout(resolve,10));completed=true})",context);
  assert.equal(context.completed,true);
});

test('paper job shows progress beside controls and blocks repeated start until done',async()=>{
  const {nodes,context}=screen();
  await new Promise(resolve=>setTimeout(resolve,0));
  let finish;
  context.fetch=()=>new Promise(resolve=>{finish=()=>resolve({ok:true,json:async()=>({status:'done',progress:100,message:'done',result:{enabled:true,pending:{a:{execution_day:'2026-10-12'}}}})});});
  const waiting=vm.runInContext("poll('paper-job',async()=>{}, {universe:true})",context);
  assert.equal(nodes.get('universe-start').disabled,true);
  assert.match(nodes.get('universe-start').textContent,/분석/);
  assert.match(nodes.get('universe-action-status').textContent,/분석/);
  finish();await waiting;
  assert.equal(nodes.get('universe-start').disabled,false);
  assert.match(nodes.get('universe-action-status').textContent,/1종목.*2026-10-12/);
});

test('fast skipped scan keeps its explanation beside the clicked controls after refresh',async()=>{
  const {nodes,context}=screen();
  await new Promise(resolve=>setTimeout(resolve,0));
  const state=await vm.runInContext("api('/api/universe-paper')",context);
  const result={...state,scan_execution:{status:'skipped',message:'이번 차수 선정 완료 · 새 주가 조회·재학습 생략 · 다음 재계산 2026-10-19'}};
  context.fetch=async path=>({ok:true,json:async()=>path.startsWith('/api/jobs/')?{status:'done',message:'완료',progress:100,result}:state});
  await vm.runInContext("poll('fast',refreshUniversePaper,{universe:true})",context);
  assert.ok(nodes.has('universe-job-status'));
  assert.match(nodes.get('universe-job-status').textContent,/재학습 생략.*2026-10-19/);
  assert.equal(nodes.get('universe-job-panel').hidden,false);
  await vm.runInContext('refreshUniversePaper()',context);
  assert.match(nodes.get('universe-job-status').textContent,/재학습 생략/);
});

test('current universe stock and stage stay visible until completion',async()=>{
  const {nodes,context}=screen();
  await new Promise(resolve=>setTimeout(resolve,0));
  let calls=0,finish;
  context.fetch=async()=>{
    if(calls++===0)return {ok:true,json:async()=>({status:'running',message:'12/100 · 삼성전자 (005930) · 완료 일봉 조회',progress:12})};
    return new Promise(resolve=>{finish=()=>resolve({ok:true,json:async()=>({status:'done',message:'완료',progress:100,result:{}})});});
  };
  context.setTimeout=fn=>setTimeout(fn,0);
  const waiting=vm.runInContext("poll('slow',async()=>{}, {universe:true})",context);
  while(!finish)await new Promise(resolve=>setTimeout(resolve,0));
  const message=nodes.get('universe-job-status')?.textContent;
  finish();await waiting;
  assert.match(message??'',/12\/100.*삼성전자.*완료 일봉 조회/);
  assert.equal(nodes.get('universe-job-progress').value,100);
  assert.match(nodes.get('universe-job-status').textContent,/완료/);
});

test('a resumed paper job refreshes reservations when its result completes',async()=>{
  const {nodes,context}=screen();
  await new Promise(resolve=>setTimeout(resolve,0));
  const state=await vm.runInContext("api('/api/universe-paper')",context);
  state.enabled=true;
  state.pending={a:{symbol:{name:'예약 종목'},signal_date:'2026-10-08',execution_day:'2026-10-12',score:.7,config:state.config}};
  state.activity=[{symbol:{name:'예약 종목',code:'005930'},status:'reserved',buy_date:'2026-10-12',sell_date:'2026-10-26',quantity:null,average_price:null,current_price:null,price_date:null,sell_price:null,profit:null,return_pct:null}];
  context.fetch=async()=>({ok:true,json:async()=>state});
  await vm.runInContext("finishSavedJob('universe-paper',{})",context);
  assert.match(nodes.get('universe-pending').innerHTML,/예약 종목/);
  assert.match(nodes.get('universe-pending').innerHTML,/2026-10-12/);
});

test('candidate filter changes visible rows and export scope without changing the account',async()=>{
  const {nodes,context}=screen();
  await new Promise(resolve=>setTimeout(resolve,0));
  const state=await vm.runInContext("api('/api/universe-paper')",context);
  state.candidates=['매수 후보','기준 미달','1주 예산 부족','분석 제외','매수 후보'].map((status,i)=>({code:String(i),name:'종목'+i,exchange:'KOSPI',rank:i+1,status,score:.7}));
  context.viewState=state;
  vm.runInContext('renderUniversePaper(viewState)',context);
  nodes.get('universe-filter').value='candidate';nodes.get('universe-filter').onchange();
  const filtered=nodes.get('universe-candidates').innerHTML;
  assert.match(filtered,/종목0/);assert.match(filtered,/종목4/);
  assert.doesNotMatch(filtered,/종목1|종목2|종목3/);
  assert.match(nodes.get('universe-filter-count').textContent,/2.*5/);
  assert.match(nodes.get('universe-export').href,/result_filter=candidate/);
  assert.equal(state.candidates.length,5);
  nodes.get('universe-filter').value='below';nodes.get('universe-filter').onchange();
  assert.match(nodes.get('universe-candidates').innerHTML,/종목1/);
  assert.doesNotMatch(nodes.get('universe-candidates').innerHTML,/종목0/);
});

test('phase two adds portfolio navigation with backtests still inside stock analysis',()=>{
  const {nodes}=screen();
  const tabs=Array.from(html.matchAll(/data-tab="([^"]+)"/g),m=>m[1]);
  assert.deepEqual(tabs,['analyze','paper','comparison','portfolio','quant']);
  assert.ok(html.indexOf('id="validation"')>html.indexOf('id="analyze"'));
  assert.ok(html.indexOf('id="validation"')<html.indexOf('id="paper"'));
  assert.equal(nodes.has('portfolio'),true);assert.equal(nodes.has('batch'),false);
});

test('portfolio selection prevents duplicates and clears weights after changing inputs',async()=>{
  const {nodes,context}=screen();
  await new Promise(resolve=>setTimeout(resolve,0));
  vm.runInContext("addPortfolioSymbol({code:'005930',name:'삼성전자',market:'KR'});addPortfolioSymbol({code:'005930',name:'삼성전자',market:'KR'});addPortfolioSymbol({code:'000660',name:'SK하이닉스',market:'KR'})",context);
  assert.equal(vm.runInContext('portfolioSymbols.length',context),2);
  nodes.get('portfolio-result').hidden=false;
  nodes.get('portfolio-capital').listeners.input();
  assert.equal(nodes.get('portfolio-result').hidden,true);
  vm.runInContext("addPortfolioSymbol({code:'AMD',name:'AMD',market:'US'})",context);
  assert.equal(vm.runInContext('portfolioSymbols.length',context),3);
});

test('portfolio submits selected stocks with its own capital and shows allocation details',async()=>{
  const {nodes,context}=screen();
  await new Promise(resolve=>setTimeout(resolve,0));
  vm.runInContext("addPortfolioSymbol({code:'005930',name:'삼성전자',market:'KR'});addPortfolioSymbol({code:'000660',name:'SK하이닉스',market:'KR'})",context);
  nodes.get('portfolio-capital').value='1000000';nodes.get('portfolio-years').value='5';
  const requests=[];
  const result={currency:'KRW',capital:1000000,annual_return:.1,annual_volatility:.2,sharpe:.4,common_rows:100,as_of:'2026-10-08',start:'2021-10-08',samples:20000,risk_free:.02,total_purchase_cost:999000,remaining_cash:1000,warnings:[],note:'sample',allocations:[{symbol:{name:'삼성전자',code:'005930'},weight:.6,allocation:600000,close:70000,quantity:8,purchase_cost:560000,buy_fee:84},{symbol:{name:'SK하이닉스',code:'000660'},weight:.4,allocation:400000,close:200000,quantity:1,purchase_cost:200000,buy_fee:30}]};
  context.fetch=async(path,options={})=>{requests.push([path,options]);return {ok:true,json:async()=>path==='/api/portfolio'?{id:'job'}:{status:'done',progress:100,result}};};
  await nodes.get('portfolio-form').onsubmit({preventDefault(){}});
  const request=JSON.parse(requests.find(([p])=>p==='/api/portfolio')[1].body);
  assert.equal(request.capital,1000000);assert.equal(request.years,5);assert.equal(request.symbols.length,2);
  assert.equal(request.currency,'KRW');
  assert.equal(request.min_weight_pct,5);assert.equal(request.max_weight_pct,40);
  assert.equal(nodes.get('portfolio-result').hidden,false);
  assert.match(nodes.get('portfolio-allocation').innerHTML,/60%|60.0%/);
  assert.match(nodes.get('portfolio-allocation').innerHTML,/600,000/);
  assert.match(nodes.get('portfolio-summary').innerHTML,/10%|10.0%/);
  assert.equal(nodes.get('portfolio-fields').disabled,false);
});

test('half Kelly renders cash separately and does not normalize stock weights to one hundred percent',async()=>{
  const {nodes,context}=screen();await new Promise(resolve=>setTimeout(resolve,0));
  context.halfResult={currency:'KRW',capital:1000000,annual_return:.1,annual_volatility:.2,sharpe:.4,
    common_rows:100,as_of:'2026-10-08',start:'2021-10-08',samples:20000,risk_free:.02,
    total_purchase_cost:490000,remaining_cash:510000,reserve_cash:500000,cash_weight:.5,
    portfolio_strategy:'half-kelly-v1',sizing:{full_fraction:1,half_fraction:.5,observations:99,note:'historical'},
    constraints:{min_weight_pct:5,effective_max_weight_pct:40},warnings:[],note:'sample',
    allocations:[{symbol:{name:'First',code:'1'},mix_weight:.4,weight:.2,allocation:200000,close:10000,quantity:19,purchase_cost:190000,buy_fee:0},
      {symbol:{name:'Second',code:'2'},mix_weight:.6,weight:.3,allocation:300000,close:10000,quantity:30,purchase_cost:300000,buy_fee:0}]};
  vm.runInContext('renderPortfolio(halfResult)',context);
  assert.match(nodes.get('portfolio-weight-total').textContent,/주식 50%.*현금 50%/);
  assert.match(nodes.get('portfolio-kelly').textContent,/하프 켈리.*50%/);
  assert.match(nodes.get('portfolio-allocation').innerHTML,/전체 자금 비중/);
  assert.match(nodes.get('portfolio-cash').textContent,/실제 현금 비중 51%/);
  nodes.get('portfolio-min_weight_pct').listeners.input();
  assert.equal(nodes.get('portfolio-result').hidden,true);
});

test('restoring a legacy portfolio keeps its selected stocks but requires a half Kelly recalculation',async()=>{
  const {nodes,context}=screen();await new Promise(resolve=>setTimeout(resolve,0));
  context.legacy={symbols:[{code:'1',name:'Old',market:'KR'}],settings:{capital:2000000,years:4},allocations:[]};
  vm.runInContext('restorePortfolio(legacy)',context);
  assert.equal(nodes.get('portfolio-result').hidden,true);
  assert.equal(Number(nodes.get('portfolio-capital').value),2000000);
  assert.match(nodes.get('portfolio-status').textContent,/하프 켈리.*다시 계산/);
});

test('reload resumes portfolio inputs and removes old allocations even if the new job fails',async()=>{
  const old={currency:'KRW',symbols:[{code:'005930',name:'Old',market:'KR'}],settings:{capital:1000000,years:5},allocations:[],weights:{},warnings:[]};
  const request={symbols:[{code:'AAPL',name:'Apple',market:'US'},{code:'AMD',name:'AMD',market:'US'}],capital:20000,years:3,buy_fee_pct:.02,slippage_pct:.1};
  const {nodes,context}=screen(async(path,options,original)=>{
    const data=path==='/api/portfolio/latest'?old:path==='/api/jobs'?[{id:'resumed',kind:'portfolio',status:'running'}]:path==='/api/jobs/resumed'?{status:'failed',message:'Failed',error:'Price unavailable',request}:undefined;
    return data===undefined?original(path,options):{ok:true,json:async()=>data};
  });
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(nodes.get('portfolio-result').hidden,true);
  assert.equal(nodes.has('portfolio-market'),false);
  assert.equal(Number(nodes.get('portfolio-capital').value),100000000);
  assert.match(nodes.get('portfolio-currency-note').textContent,/이전 달러.*원화/);
  assert.equal(Number(nodes.get('portfolio-years').value),3);
  assert.equal(vm.runInContext('portfolioSymbols[1].code',context),'AMD');
  assert.match(nodes.get('portfolio-status').textContent,/계산 실패.*Price unavailable/);
  assert.equal(nodes.get('portfolio-fields').disabled,false);
});

test('weekly cycle screen shows next recalculation and cycle identity with duplicate filter',async()=>{
  const {nodes,context}=screen();
  await new Promise(resolve=>setTimeout(resolve,0));
  context.cycleState=await vm.runInContext("api('/api/universe-paper')",context);
  Object.assign(context.cycleState,{next_scan_day:'2026-10-19',cycle_summary:[{id:1,signal_date:'2026-10-08',execution_day:'2026-10-12',expiry_date:'2026-10-26',reserved_count:10,skipped_duplicate_count:0,pending:10,held:0,sold:0,realized_profit:0,status:'진행 중'}],activity:[{cycle_id:1,status:'reserved',symbol:{name:'예약',code:'005930'},buy_date:'2026-10-12',sell_date:'2026-10-26'}],candidates:[{status:'중복 제외',name:'중복 종목',code:'000660'}]});
  vm.runInContext('renderUniversePaper(cycleState)',context);
  assert.match(nodes.get('universe-cycle-schedule').textContent,/2026-10-19/);
  assert.match(nodes.get('universe-cycles').innerHTML,/1차/);
  assert.match(nodes.get('universe-pending').innerHTML,/1차/);
  nodes.get('universe-filter').value='duplicate';nodes.get('universe-filter').onchange();
  assert.match(nodes.get('universe-candidates').innerHTML,/중복 종목/);
  assert.match(nodes.get('universe-export').href,/result_filter=duplicate/);
});

test('default analysis settings satisfy the HTML number constraints',()=>{
  for(const match of html.matchAll(/<input\b[^>]*type="number"[^>]*>/g)) {
    const attrs=Object.fromEntries(Array.from(match[0].matchAll(/([\w-]+)="([^"]*)"/g), m=>[m[1],m[2]]));
    const value=Number(attrs.value), min=Number(attrs.min ?? 0), step=attrs.step ?? '1';
    assert.ok(attrs.min===undefined || value>=min, attrs.id+': below minimum');
    assert.ok(attrs.max===undefined || value<=Number(attrs.max), attrs.id+': above maximum');
    if(step!=='any') {
      const steps=(value-(attrs.min===undefined?value:min))/Number(step);
      assert.ok(Math.abs(steps-Math.round(steps))<1e-7, attrs.id+': default has step mismatch');
    }
  }
});

function previousAnalysis(nodes,context) {
  vm.runInContext("currentResult={symbol:{code:'005930'}};selected={code:'005930',name:'삼성전자',market:'KR'}",context);
  nodes.get('result-name').textContent='삼성전자 · 005930';
  nodes.get('probability').textContent='63.4%';
  nodes.get('report-links').innerHTML='<a>previous report</a>';
  nodes.get('validation-content').hidden=false;
  nodes.get('validation-empty').hidden=true;
}

test('editing the symbol removes the previous analysis and validation results',()=>{
  const {nodes,context}=screen();
  previousAnalysis(nodes,context);
  nodes.get('query').listeners.input();
  assert.equal(nodes.get('probability').textContent,'—');
  assert.equal(nodes.get('report-links').innerHTML,'');
  assert.equal(nodes.get('validation-content').hidden,true);
  assert.equal(vm.runInContext('currentResult',context),null);
});

test('a failed new analysis does not leave previous probabilities on screen',async()=>{
  const {nodes,context}=screen();
  previousAnalysis(nodes,context);
  context.fetch=async(path)=>({ok:true,json:async()=>path==='/api/analyze'?{id:'failed'}:
    path==='/api/jobs/failed'?{status:'failed',progress:2,message:'작업 실패',error:'가격 조회 실패'}:{}});
  await nodes.get('analysis-form').onsubmit({preventDefault(){}});
  assert.equal(nodes.get('probability').textContent,'—');
  assert.equal(nodes.get('report-links').innerHTML,'');
  assert.equal(nodes.get('validation-content').hidden,true);
  assert.equal(nodes.get('notice').textContent,'가격 조회 실패');
});

test('analysis displays the calculated indicator values and model importance',()=>{
  const {nodes,context}=screen();
  context.result={symbol:{code:'005930',name:'합성 검증',market:'KR'},as_of:'2023-11-24',
    latest_probability:.63,selected:true,settings:{horizon:10,target_pct:2,threshold_pct:60},
    close:50000,indicative_target:51200,feature_count:2,sample_count:1000,
    warnings:[],chart:[],folds:[],variants:[],holdout:{bins:[]},
    latest_features:{rsi_14:50,return_5:.02},groups:{rsi:['rsi_14'],returns:['return_5']},
    feature_importance:[{feature:'rsi_14',importance:.7},{feature:'return_5',importance:.3}]};
  vm.runInContext('render(result)',context);
  assert.ok(nodes.get('feature-table'),'Indicator table must be reachable');
  assert.match(nodes.get('feature-table').innerHTML,/rsi_14/);
  assert.match(nodes.get('feature-table').innerHTML,/70%/);
  assert.match(nodes.get('feature-table').innerHTML,/0\.02/);
  assert.match(nodes.get('validation-description').textContent,/이전 확장 방식/);
  assert.match(nodes.get('simulation-description').textContent,/확률/);
});

test('original results distinguish mean fold precision from latest binary signal',()=>{
  const {nodes,context}=screen();
  context.result={analysis_method:'original-close-v1',symbol:{code:'000660',name:'SK하이닉스',market:'KR'},
    as_of:'2026-10-08',mean_precision:.4,latest_signal:1,settings:{horizon:10,target_pct:2},
    close:100,indicative_target:102,feature_count:11,sample_count:1000,valid_folds:5,
    warnings:[],chart:[],latest_features:{RSI:50},feature_importance:[],
    folds:[{fold:1,train_start:'a',train_end:'b',test_start:'c',test_end:'d',n:100,precision:0,selected_n:0,hits:0}]};
  vm.runInContext('render(result)',context);
  assert.equal(nodes.get('probability').textContent,'40%');
  assert.match(nodes.get('probability-label').textContent,/평균 적중률/);
  assert.match(nodes.get('selection').textContent,/상승 신호 있음/);
  assert.match(nodes.get('fold-table').innerHTML,/0%/);
  assert.equal(nodes.get('variant-section').hidden,true);
  assert.equal(nodes.get('calibration-section').hidden,true);
  assert.doesNotMatch(nodes.get('selection').textContent,/확률/);
  assert.match(nodes.get('validation-description').textContent,/5개/);
  assert.match(nodes.get('simulation-description').textContent,/0\/1/);
});

test('researched inputs are selectable and comparison remains precision based',()=>{
  const {nodes,context}=screen();
  assert.ok(nodes.get('feature_set'),'Input mode selector must exist');
  nodes.get('feature_set').value='expanded';
  assert.equal(vm.runInContext('settings().feature_set',context),'expanded');
  context.result={analysis_method:'original-close-v1',feature_set:'expanded',symbol:{code:'068270',name:'셀트리온',market:'KR'},
    analysis_window:{years:5,start:'2021-10-08',end:'2026-10-08',rows:1000},
    as_of:'2026-10-08',mean_precision:.45,latest_signal:0,settings:{horizon:5,target_pct:2,feature_set:'expanded'},
    close:100,indicative_target:102,feature_count:55,sample_count:1000,valid_folds:5,
    warnings:[],chart:[],latest_features:{macd_relative:.01,RSI:40},groups:{macd:['macd_relative'],original:['RSI']},
    folds:[],input_comparison:{same_dates:true,start:'a',end:'b',rows:1000,models:[
      {name:'원본 입력 · 공통 날짜',feature_count:11,mean_precision:.4,latest_signal:0,sample_count:1000},
      {name:'조사 지표 추가',feature_count:55,mean_precision:.45,latest_signal:0,sample_count:1000}]}};
  vm.runInContext('render(result)',context);
  assert.match(nodes.get('result-date').textContent,/입력 확장/);
  assert.match(nodes.get('validation-description').textContent,/최근 5년/);
  assert.match(nodes.get('data-meta').textContent,/2021-10-08 ~ 2026-10-08/);
  assert.equal(nodes.get('variant-section').hidden,false);
  assert.match(nodes.get('variant-table').innerHTML,/40%/);
  assert.match(nodes.get('variant-table').innerHTML,/45%/);
  assert.match(nodes.get('variant-title').textContent,/입력/);
  assert.doesNotMatch(nodes.get('variant-table').innerHTML,/Brier|확률/);
  assert.match(nodes.get('feature-table').innerHTML,/MACD/);
  nodes.get('feature_set').value='original';
  assert.equal(vm.runInContext('settings().feature_set',context),'original');
});

test('US simulation results disclose USD capital and preserve near total loss precision',()=>{
  const {nodes,context}=screen();
  context.usResult={symbol:{code:'AMD',name:'AMD',market:'US'},simulations:{buffer:{
    initial_capital:10000000,final_equity:25.972178506071188,return_pct:-99.99974027821494,
    max_drawdown_pct:99.99984541550918,trade_count:1675,target_hits:1310,open_position:null,trades:[]}}};
  vm.runInContext('renderTrading(usResult)',context);
  assert.match(nodes.get('simulation-table').innerHTML,/USD/);
  assert.match(nodes.get('simulation-table').innerHTML,/초기 자금/);
  assert.match(nodes.get('simulation-table').innerHTML,/10,000,000\.00/);
  assert.match(nodes.get('simulation-table').innerHTML,/25\.97/);
  assert.match(nodes.get('simulation-table').innerHTML,/-99\.99974%/);
  assert.doesNotMatch(nodes.get('simulation-table').innerHTML,/>-100%/);
});
