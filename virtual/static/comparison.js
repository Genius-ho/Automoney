'use strict';
let comparisonState=null,comparisonWorking=false,comparisonError=null,strategyC=null,strategyD=null,strategyF=null,strategyK=null,strategyUS={},threeYear=null;
const SERIES=[['a','#1b64da'],['b','#8b5cf6'],['c','#0f9d76'],['d0','#f08c00'],['d2','#c2410c'],['d3','#be185d'],['f','#0b7285'],['k','#343a40'],['g','#d6336c'],['h','#5c940d'],['i','#7048e8']];
const US_SIDES=['g','h','i'];
const D_VARIANTS=['d0','d2','d3'];
function setComparisonWorking(active){
  comparisonWorking=active;
  if(active)comparisonError=null;
  $('comparison-start').disabled=active;$('comparison-settle').disabled=active;
  $('comparison-start').textContent=active?'두 전략 분석 중…':comparisonState?.started_day?'비교 계속하기':'A·B 비교 시작';
  $('comparison-progress').hidden=!active;
  for(const side of ['a','b'])$('comparison-'+side+'-state').textContent=active?'분석 중':comparisonState?.accounts[side].enabled?'자동 실행':'신규 매수 중지';
  if(!active&&comparisonState)renderComparison(comparisonState);
}
function showComparisonProgress(percent,message){
  $('comparison-progress').hidden=false;$('comparison-progress').value=percent;
  $('comparison-status').textContent=message+' · '+percent+'%';
}
function showComparisonError(message){comparisonError=message;$('comparison-status').textContent='작업 실패 · '+message;}
function renderComparison(state){
  if(!state?.accounts)return;
  comparisonState=state;
  if(!comparisonWorking)$('comparison-start').textContent=state.started_day?'비교 계속하기':'A·B 비교 시작';
  $('comparison-start-date').textContent=state.started_day?'시작 '+(state.started_at?.slice(0,10)??state.started_day)+' · 최초 기준일 '+state.started_day:'비교 시작 전';
  const cfg=state.config;
  const holding=account=>(account.config?.holding_mode??cfg.holding_mode)==='trading_sessions'?'매수 후 10거래일':'매수 후 달력 14일';
  const aCount=state.accounts.a.scan?.universe?.rows?.length??100,bCount=state.b_universe?.rows?.length??state.accounts.b.scan?.universe?.rows?.length??100;
  $('comparison-a-scope').textContent='코스피 시가총액 상위 '+aCount+'종목 · '+holding(state.accounts.a)+' · 종목당 1천만원';
  $('comparison-b-scope').textContent=(state.b_universe?.label??'시가총액 상위 '+bCount+'종목')+' · '+holding(state.accounts.b)+' · 종목당 1천만원';
  $('comparison-scope').textContent='6개 가상 계좌 · 각 10억원 · A '+aCount+'종목 · B '+bCount+'종목 · C '+(strategyC?.metrics?.holding_count??'—')+'종목 · D ETF 8종 · 같은 날 같은 가격으로 비교';
  $('comparison-selection-title').textContent='A '+aCount+' · B '+bCount+'종목 선정 비교';
  $('comparison-holding-rule').textContent='매주 선정 · 다음 거래일 종가 매수 · 종가 -3% 손절 / +5% 익절. 만기: A '+holding(state.accounts.a)+' / B '+holding(state.accounts.b)+'. 계좌 안의 중복 종목은 건너뜁니다.';
  $('comparison-b-target').textContent='다음 거래일 종가에 산 뒤 -3% 손절·+5% 익절·'+holding(state.accounts.b)+' 만기를 적용했을 때 비용을 빼고 이익이 남았는가?';
  $('comparison-costs').textContent='공통 비용: 매수 '+cfg.buy_fee_pct+'% · 매도 '+cfg.sell_fee_pct+'% · 거래세 '+cfg.sell_tax_pct+'% · 슬리피지 '+cfg.slippage_pct+'%';
  for(const side of ['a','b']){
    const account=state.accounts[side],m=account.metrics;
    $('comparison-'+side+'-total').innerHTML='<small>총 수익률</small><strong'+financialTone('수익률',m.return_pct)+'>'+(m.return_pct>0?'+':'')+esc(performancePct(m.return_pct))+'</strong>';
    $('comparison-'+side+'-state').textContent=account.enabled?'자동 실행':'신규 매수 중지';
  }
  renderAccountsSummary();
  const c=state.comparison;
  $('comparison-difference').textContent=c.return_difference_pct==null?'비교 보류':'B − A 수익률 '+number(c.return_difference_pct,2)+'%p';
  $('comparison-verdict').textContent=c.message;
  renderComparisonEvidence(state);
  if(!comparisonWorking)$('comparison-status').textContent=state.started_day?(state.enabled?'자동 비교 실행 중':'신규 매수 중지')+' · A 예약 '+state.accounts.a.metrics.pending_count+' / B 예약 '+state.accounts.b.metrics.pending_count+'종목':'시작하면 동일한 100종목을 두 전략으로 분석하고 다음 거래일 종가 매수를 예약합니다.';
  if(state.incomplete_day)$('comparison-status').textContent=state.incomplete_day+' 가격 누락 · 두 계좌 정산·신규 선정 보류 · '+(state.settlement_errors??[]).map(e=>e.name+' ('+e.code+')').join(', ')+' · 종가 정산으로 재시도하세요.';
  if(comparisonError)$('comparison-status').textContent='작업 실패 · '+comparisonError;
  const a=new Map(state.accounts.a.equity.map(p=>[p.date,p])),b=new Map(state.accounts.b.equity.map(p=>[p.date,p]));
  const extra={c:strategyC,...Object.fromEntries(D_VARIANTS.map(v=>[v,strategyD?.[v]])),f:strategyF,k:strategyK,g:strategyUS.g,h:strategyUS.h,i:strategyUS.i};
  const maps=Object.fromEntries(Object.entries(extra).map(([k,st])=>[k,new Map((st?.equity??[]).map(p=>[p.date,p]))]));
  const points=[...new Set([...a.keys(),...b.keys(),...Object.values(maps).flatMap(m=>[...m.keys()])])].sort().map(date=>{
    const x=a.get(date),y=b.get(date);
    const row={date,a:x&&!x.stale_positions?(x.value/cfg.capital-1)*100:null,b:y&&!y.stale_positions?(y.value/cfg.capital-1)*100:null};
    for(const [k,m] of Object.entries(maps)){const z=m.get(date);row[k]=z?(z.value/extra[k].config.capital-1)*100:null;}
    return row;
  });
  drawComparisonChart(points);
  table('comparison-daily',['날짜','A','B','C','D0','D2','D3','F','K','G','H','I'],points.slice(-10).reverse().map(p=>[p.date,...SERIES.map(([k])=>performancePct(p[k]))]));
  renderComparisonSelections();renderComparisonActivity();
}
function renderComparisonEvidence(state){
  const b=state.accounts.b,a=state.accounts.a,rows=b.candidates;
  const rules=state.selection_rules||{},v3=rules.version===3,v4=rules.version===4;
  const threshold=rules.probability_threshold??.6,thresholdText=number(threshold*100)+'%',minimum=rules.min_validation_signals??20;
  const edgeText=number((rules.edge_over_base??0)*100)+'%p',fdrText=number((rules.fdr_q??0)*100)+'%';
  const rule=v4?'전체 종목을 한 모델로 학습한 이번 수익 확률 상위 '+rules.top_k+'종목(20일 거래대금 하위 '+number(rules.liquidity_cut*100)+'% 제외)에 포함':v3?'이번 수익 확률 ≥ 그 종목 기본 발생률+'+edgeText+'(최소 '+thresholdText+'), 겹치지 않는 과거 검증 거래 ≥'+rules.min_independent_trades+'건·항상 매수보다 높은 적중률과 순수익, 전체 종목 다중검정(FDR '+fdrText+') 통과를 모두 충족':
    '이번 수익 확률 ≥'+thresholdText+'이고, 과거 검증 신호 ≥'+minimum+'개·기본 발생률보다 높은 적중률·양수이면서 전체 검증 평균보다 높은 순수익을 모두 충족';
  $('comparison-b-rule').textContent='다음 종가 매수 후 손절·익절·만기·비용을 적용한 이익 여부를 학습합니다. '+rule+'해야 매수합니다.';
  $('comparison-b-entry-rule').textContent=rule;
  $('comparison-b-details').textContent=v4?'B v4: 다음 거래일 종가 매수 후 손절·익절·10거래일 만기와 비용을 적용한 순수익을 학습합니다. 종목마다 따로 학습하던 v3와 달리 전체 종목의 최근 5년 자료를 한 모델로 학습하고, 매주 수익 확률 상위 '+rules.top_k+'종목을 고릅니다.':v3?'다음 거래일 종가 매수 후 손절·익절·만기와 비용을 적용한 순수익을 학습합니다. 정답이 확정된 최근 자료까지 재학습하고, 종목마다 평소 성공 빈도보다 확실히 높은지와 과거 독립 거래의 통계적 유의성을 확인해 선정합니다.':
    '다음 거래일 종가 매수 후 손절·익절·만기와 비용을 적용한 순수익을 학습합니다. 정답이 확정된 최근 자료까지 재학습하고 보정 수익 확률 ≥'+thresholdText+'와 과거 검증 조건으로 선정합니다.';
  $('comparison-b-gate-detail').textContent=v4?'B v4 검증: 종목별 통계 검정 대신 전략 전체를 과거 주간 순위 매매로 시간순 검증했습니다'+(rules.research?.summary?' · '+rules.research.summary:'')+'. 매주 일정 수를 사므로 0종목 대기는 생기지 않지만, 과거 우위가 앞으로의 수익을 보장하지 않습니다.':v3?'B v3 검증 조건: 최근 세 검증 구간(약 2.4년)에서 신호를 실제처럼 순서대로 매매해 이전 거래가 끝난 뒤에만 다음 거래를 잡습니다. 이 독립 거래가 '+rules.min_independent_trades+'건 이상이고 적중률·평균 순수익이 항상 매수보다 높아야 하며, 평균 순수익의 단측 t검정 p값을 분석 종목 전체에 Benjamini-Hochberg(FDR '+fdrText+')로 보정해 통과해야 합니다.':
    'B의 검증 조건: 최근 두 검증 구간에서 '+thresholdText+' 이상 신호 '+minimum+'개 이상, 적중률이 전체 기본 발생률 초과, 신호 평균 순수익이 0과 전체 평균 순수익을 모두 초과. 겹치는 미래 기간이 있어 신호 수가 독립 거래 수를 뜻하지 않습니다.';
  const revision=state.selection_revisions?.at(-1);
  $('comparison-rule-history').textContent=(state.b_selection_blocked?state.b_selection_blocked+' ':'')+(revision?.reason?revision.changed_at.slice(0,10)+' · '+(revision.to_method&&revision.from_method!==revision.to_method?revision.from_method+' → '+revision.to_method+' · '+(revision.effective?revision.effective+' · ':''):'')+revision.reason:revision?
    revision.changed_at.slice(0,10)+' · B v2: 확률 기준 60% → 52%. 현재 약 5종목을 선정하도록 조정했고, 과거 검증 조건은 유지했습니다. 기존 B 선정 기록은 보존했습니다. 앞으로도 52%를 고정 적용하므로 후보 수는 매번 달라질 수 있습니다.':
    'B 기준 '+thresholdText+' · 현재 종목 수를 보고 조정한 실험 기준이며 성과 개선을 입증한 수치는 아닙니다.');
  const valid=rows.filter(r=>Number.isFinite(r.score)&&r.status!=='분석 제외');
  const scanV4=valid.some(r=>r.method==='pooled-rank-top-k-v4'),scanV3=!scanV4&&valid.some(r=>r.signal_today!==undefined);
  const above=scanV3?valid.filter(r=>r.signal_today===true):valid.filter(r=>r.score>=threshold),past=scanV3?valid.filter(r=>r.evidence_passed===true):valid.filter(r=>r.entry_allowed===true);
  const both=scanV3?valid.filter(r=>r.signal_today&&r.evidence_passed&&r.fdr_passed):valid.filter(r=>r.score>=threshold&&r.entry_allowed===true);
  const counts=scanV4?[['정상 분석',valid.length],['거래대금 기준 통과',valid.filter(r=>r.signal_today).length],['상위 '+(rules.top_k??'—')+' 선정',valid.filter(r=>r.eligible).length],['현재 매수 예약',b.metrics.pending_count]]:scanV3?[['정상 분석',valid.length],['이번 상대 확률 신호',above.length],['비중복 검증 통과',past.length],['다중검정 통과',valid.filter(r=>r.fdr_passed).length],['모두 충족',both.length],['현재 매수 예약',b.metrics.pending_count]]:
    [['정상 분석',valid.length],['이번 확률 ≥'+thresholdText,above.length],['과거 검증 조건 통과',past.length],['두 조건 모두 충족',both.length],['현재 매수 예약',b.metrics.pending_count]];
  $('comparison-b-funnel').innerHTML=counts.map(([label,value])=>'<div><small>'+esc(label)+'</small><b>'+value+'종목</b></div>').join('');
  const best=valid.reduce((current,row)=>!current||row.score>current.score?row:current,null);
  const excluded=rows.length-valid.length;
  $('comparison-b-reason').textContent=!rows.length?'분석 후 탈락 단계와 최고 확률을 표시합니다.':
    '기준일 '+(b.scan?.as_of??'—')+' · 최고 수익 확률 '+(best?best.name+' '+number(best.score*100,2)+'%':'계산 불가')+' · 분석 제외 '+excluded+'종목. '+
    (scanV4?'통합 수익 확률 순으로 상위 종목을 매수합니다. 중복 보유·예산·현금 조건에 따라 실제 예약 수는 줄어들 수 있습니다.':!above.length?(scanV3?'이번 상대 확률 기준을 넘는 종목이 없어 신규 매수하지 않습니다.':'이번 확률 '+thresholdText+' 이상인 종목이 없어 신규 매수하지 않습니다.'):!both.length?'이번 확률과 과거 검증 조건을 함께 통과한 종목이 없습니다.':'두 조건을 충족해도 중복 보유·예산·현금 조건에 따라 실제 예약 수는 줄어들 수 있습니다.');
  const m=b.metrics;
  $('comparison-evidence').textContent=!state.started_day?'비교 시작 전입니다.':state.incomplete_day||!state.comparison.comparable?'가격 누락 또는 평가 날짜 차이로 계좌 성과 비교를 보류합니다.':
    !m.trade_count&&!m.holding_count&&!m.pending_count?
      'B는 아직 매수·청산한 거래가 없어 현금 대기 상태입니다. A의 투자 결과와 B의 현금 대기를 계좌 수익률로 비교할 수 있지만, B의 매매 승률·예측력이 더 좋은지는 아직 평가할 수 없습니다.':
    !m.trade_count?'B에 예약 또는 보유 종목이 있지만 청산 거래는 아직 없습니다. 계좌 평가액은 비교할 수 있으며, 매매 결과 검증은 청산 후 시작됩니다.':
      '청산 거래 A '+a.metrics.trade_count+'건 / B '+m.trade_count+'건. 비용 차감 계좌 성과와 매매 결과를 함께 확인하세요. 소수 거래의 우열만으로 모델 예측력 차이를 확정할 수는 없습니다.';
}
function renderComparisonSelections(){
  if(!comparisonState)return;
  const accounts=comparisonState.accounts,all=new Map();
  for(const side of ['a','b'])for(const candidate of accounts[side].candidates){const row=all.get(candidate.code)||{};row[side]=candidate;all.set(candidate.code,row);}
  const filter=$('comparison-filter').value||'all';
  const selected=c=>c?.status==='매수 후보';
  const rows=[...all.values()].filter(({a,b})=>filter==='all'||filter==='either'&&(selected(a)||selected(b))||filter==='both'&&selected(a)&&selected(b)||filter==='b_only'&&!selected(a)&&selected(b)||filter==='below'&&!selected(a)&&!selected(b)||filter==='error'&&(a?.error||b?.error));
  $('comparison-selection-meta').textContent=rows.length+' / '+all.size+'종목 표시 · 기준일 '+(accounts.a.scan?.as_of??'분석 전')+' · '+(comparisonState.b_universe?'A와 B의 분석 범위·만기가 다릅니다. A의 기존 선정은 보존했고 B에는 동결 연구 결과를 적용했습니다. 이후 함께 실행하는 공통 종목은 같은 주가 사본을 사용합니다. B 구성종목 목록은 '+comparisonState.b_universe.retrieved_at?.slice(0,10)+' 기준으로 고정합니다.':'A와 B는 같은 목록·주가 사본을 사용합니다.');
  table('comparison-selections',['시장','순위','종목','A 과거 적중률','A 신호','A 결과','B 수익 확률','B 검증 적중률 / 기본','B 검증 평균 손익','B 결과 / 근거'],rows.map(({a,b})=>{
    const symbol=a??b,v=b?.validation;
    return [symbol.exchange,symbol.rank,symbol.name+' · '+symbol.code,pct(a?.score),a?.signal??'—',a?.error??a?.status??'—',pct(b?.score),b?.pool_rank?'통합 '+b.pool_rank+'위 / 기본 '+pct(b.pooled_base_rate):v?pct(v.selected_n===0?null:v.selected_hit_rate)+' / '+pct(v.base_rate):'—',v?performancePct(v.selected_n===0?null:v.selected_mean_return_pct):'—',[b?.status,b?.error??b?.reason].filter(Boolean).join(' · ')||'—'];
  }));
}
function renderComparisonActivity(){
  if(!comparisonState)return;
  const status={reserved:'매수 예약',held:'보유 중',sold:'매도 완료'};
  for(const side of ['a','b']){
    const account=comparisonState.accounts[side],prefix='comparison-'+side+'-';
    const priceDates=[...new Set(account.activity.map(r=>r.price_date).filter(Boolean))].sort();
    $(prefix+'next-scan').textContent='다음 재계산 '+(account.next_scan_day??'시작 후 확정')+' · '+(account.errors.length?'가격 확인 실패 '+account.errors.map(e=>e.name).join(', '):'종가 기준 · 18:10 자동 정산')+(priceDates.length?' · 표시 가격 '+priceDates[0]+(priceDates.length>1?'~'+priceDates.at(-1):'')+' 종가':'');
    table(prefix+'cycles',['차수','선정일','매수 예정일','만기 예정일','예약','보유','매도','확정 손익 (원)','상태'],account.cycle_summary.map(c=>[c.id+'차',c.signal_date,c.execution_day,c.expiry_date,c.pending,c.held,c.sold,number(c.realized_profit),c.cancelled&&!c.pending&&!c.held&&!c.sold?'예약 취소':c.status]));
    if(side==='b'&&!account.activity.length){
      const v=account.candidates.filter(c=>Number.isFinite(c.score)&&c.status!=='분석 제외'),v3=v.some(c=>c.signal_today!==undefined&&c.method!=='pooled-rank-top-k-v4');
      const n=f=>v.filter(f).length;
      $(prefix+'activity').innerHTML='<p class="comparison-empty">'+esc(v3?'이번 차수('+(account.scan?.as_of??'—')+' 기준) B 매수 0종목. '+v.length+'종목 분석 → 오늘 상대 확률 신호 '+n(c=>c.signal_today)+' → 과거 독립 거래 우위 '+n(c=>c.evidence_passed)+' → 두 조건 모두 '+n(c=>c.signal_today&&c.evidence_passed)+' → 다중검정(FDR '+number((comparisonState.selection_rules?.fdr_q??0)*100)+'%) 통과 '+n(c=>c.signal_today&&c.evidence_passed&&c.fdr_passed)+'종목. 우연과 구분되는 우위가 확인된 종목이 없어 현금으로 대기합니다. 다음 선정 '+(account.next_scan_day??'—')+'.':'예약·보유·매도 기록이 없습니다.')+'</p>';
      continue;
    }
    table(prefix+'activity',['차수','상태','종목','수량','매수일','매도일','평단가 (원)','현재가 (원)','매도가 (원)','손익 (원)','손익 %'],account.activity.map(r=>[r.cycle_id+'차',status[r.status],r.symbol.name+' · '+r.symbol.code,r.quantity??'—',r.buy_date+(r.status==='reserved'?' (예정)':''),r.sell_date+(r.status==='sold'?'':' (만기)'),number(r.average_price,2),number(r.current_price,2),number(r.sell_price,2),number(r.profit),performancePct(r.return_pct)]));
  }
}
function drawComparisonChart(points){
  const canvas=$('comparison-chart'),context=canvas.getContext('2d');
  const ratio=window.devicePixelRatio||1,width=canvas.clientWidth||640,height=210;
  canvas.width=width*ratio;canvas.height=height*ratio;context.scale(ratio,ratio);context.clearRect(0,0,width,height);
  const values=points.flatMap(p=>SERIES.map(([k])=>p[k])).filter(v=>v!=null);
  if(!values.length){context.fillStyle='#697586';context.font='13px sans-serif';context.fillText('일별 정산 후 수익률 추이를 표시합니다.',20,40);return;}
  const low=Math.min(0,...values)-.1,high=Math.max(0,...values)+.1;
  const y=v=>height-28-(v-low)/(high-low)*(height-50),x=i=>55+i/Math.max(1,points.length-1)*(width-80);
  context.font='11px sans-serif';
  for(let i=0;i<4;i++){const v=low+(high-low)*i/3;context.strokeStyle='#e7ebf1';context.beginPath();context.moveTo(50,y(v));context.lineTo(width-15,y(v));context.stroke();context.fillStyle='#697586';context.fillText(number(v,2)+'%',0,y(v)+4);}
  for(const [side,color] of SERIES){context.strokeStyle=color;context.lineWidth=2;context.beginPath();let started=false;points.forEach((p,i)=>{if(p[side]==null){started=false;return;}if(!started){context.moveTo(x(i),y(p[side]));started=true;}else context.lineTo(x(i),y(p[side]));});context.stroke();}
  if(points.length===1){for(const [side,color,radius] of SERIES.map(([k,c],i)=>[k,c,7-i]))if(points[0][side]!=null){context.fillStyle=color;context.beginPath();context.arc(x(0),y(points[0][side]),radius,0,Math.PI*2);context.fill();}}
  context.fillStyle='#697586';context.fillText(points[0].date,55,height-5);if(points.length>1)context.fillText(points.at(-1).date,width-90,height-5);
}
function renderStrategyC(state){
  if(!state?.config)return;
  strategyC=state;const m=state.metrics;
  $('c-start').disabled=!!state.enabled;$('c-start').textContent=state.started_day?'C 다시 시작':'C 시작';
  $('c-state').textContent=state.enabled?'자동 실행':'신규 재조정 중지';
  $('comparison-c-total').innerHTML='<small>총 수익률</small><strong'+financialTone('수익률',state.metrics.return_pct)+'>'+(state.metrics.return_pct>0?'+':'')+esc(performancePct(state.metrics.return_pct))+'</strong>';
  $('c-status').textContent=(state.enabled?'자동 실행 · 18:20 정산':'신규 재조정 중지')+' · '+(state.message??'')+(state.errors?.length?' · 가격 확인 실패 '+state.errors.length+'종목':'');
  table('c-rebalances',['선정일','체결일','대상','상태','체결','가격 누락'],[...(state.pending?[{...state.pending,status:'예약'}]:[]),...state.rebalances.slice().reverse()].map(r=>[r.signal_date,r.execution_day,r.eligible_n+'종목',r.status==='filled'?'체결':r.status==='expired'?'기한 경과':r.status,r.trades??'—',r.missing_prices?.length??'—']));
  renderStrategyCHoldings();renderAccountsSummary();
  if(comparisonState)renderComparison(comparisonState);
}
function boughtAB(account){
  // Amount actually spent on purchases: allocation minus unspent remainder, for closed and open trades.
  return [...(account.trades??[]),...Object.values(account.positions??{})].reduce((s,t)=>s+(t.capital??0)-(t.cash_left??0),0);
}
function boughtRebalance(state){return (state.trades??[]).filter(t=>t.side==='BUY').reduce((s,t)=>s-t.amount,0);}
function signedWon(v){return v==null?'—':(v>0?'+':v<0?'−':'')+number(Math.abs(v))+'원';}
function wonAmount(v){return v?number(v)+'원':'0원';}
function ratio(p,b){return b?((p>0?'+':'')+number(p/b*100,2)+'%'):'—';}
function renderAccountsSummary(){
  const accounts=comparisonState?.accounts;
  if(!accounts)return;
  const ab=[accounts.a,accounts.b],rest=[strategyC,...D_VARIANTS.map(v=>strategyD?.[v]),strategyF,strategyK,strategyUS.g,strategyUS.h,strategyUS.i];
  const ret=m=>m?(m.return_pct>0?'+':'')+performancePct(m.return_pct):'—';
  const realized=st=>number((st?.trades??[]).reduce((s,t)=>s+(t.realized_profit??0),0))+'원';
  const nextRebalance=st=>!st?'—':st.code?(st.enabled?(st.config.currency==='USD'?'매일 미국 종가':'매일 국내 종가')+(st.book?.next_cycle?' · V 갱신 '+st.book.next_cycle:''):st.started_day?'중지':'시작 전'):st.pending?st.pending.execution_day+' 종가 재조정':st.enabled?(st.next_scan_day??'시작 후 확정')+' 신호':'중지';
  const held=st=>!st?'—':st.metrics.holding_count+(st.pending?' / 재조정 예약 '+st.pending.eligible_n:'')+'종목';
  const date=m=>m?(m.valuation_date??'—')+(m.stale_positions?' · 누락 '+m.stale_positions:''):'—';
  const rows=[
    ['투자 방법','AI 예측 · 과거 적중률 상위 종목','AI 예측 · 통계 검증 통과 종목만','351종목 같은 비중 분산','7개 자산 같은 비중','위험균형 + 200일 추세','12개월 상위 3개 자산','C·D0·D3 변동성 역수 배분','코스피200 ETF 사서 보유','무한매수 V3.0 · 40분할 · +10%','밸류 리밸런싱 · 최초 50%','밸류 리밸런싱 · 박스권 지수'],
    ['투자 대상','코스피 시총 상위 100','코스피200·코스닥150','코스피200·코스닥150','국내 상장 ETF 8종','국내 상장 ETF 8종','국내 상장 ETF 8종','주식 351 + ETF 8종','KODEX 200','SOXL (미국)','TQQQ (미국)','KODEX 200'],
    ['매매 주기','매주 선정 · −3%/+5% · 14일','매주 선정 · −3%/+5% · 10거래일','매주 재조정','매월 재조정','매월 재조정','매월 재조정','매월 재조정','재조정 없음','매일 LOC·지정가','사다리 주문 · 금요일 2주 V 갱신','사다리 주문 · 금요일 2주 V 갱신'],
    ['총 수익률',...ab.map(x=>ret(x.metrics)),...rest.map(st=>ret(st?.metrics))],
    ['비용 차감 평가액',...ab.map(x=>number(x.metrics.net_equity)+'원'),...rest.map(st=>st?number(st.metrics.net_equity)+'원':'—')],
    ['최대 낙폭',...ab.map(x=>performancePct(x.metrics.max_drawdown_pct)),...rest.map(st=>st?performancePct(st.metrics.max_drawdown_pct):'—')],
    ['투자 비중',...ab.map(x=>performancePct(x.metrics.invested_pct)),...rest.map(st=>st?performancePct(st.metrics.invested_pct):'—')],
    ['누적 매수금액',...ab.map(x=>wonAmount(boughtAB(x))),...rest.map(st=>st?wonAmount(boughtRebalance(st)):'—')],
    ['손익 금액 (실현+평가)',...ab.map(x=>signedWon(x.metrics.profit)),...rest.map(st=>st?signedWon(st.metrics.profit):'—')],
    ['매수금액 대비',...ab.map(x=>ratio(x.metrics.profit,boughtAB(x))),...rest.map(st=>st?ratio(st.metrics.profit,boughtRebalance(st)):'—')],
    ['보유 종목',...ab.map(x=>x.metrics.holding_count+' / 예약 '+x.metrics.pending_count+'종목'),...rest.map(held)],
    ['확정 손익',...ab.map(x=>number(x.metrics.realized_profit)+'원'),...rest.map(st=>st?realized(st):'—')],
    ['다음 매매',...ab.map(x=>x.enabled?(x.next_scan_day??'시작 후 확정')+' 선정':'중지'),...rest.map(nextRebalance)],
    ['평가 날짜',...ab.map(x=>date(x.metrics)),...rest.map(st=>date(st?.metrics))]];
  $('comparison-summary-body').innerHTML=rows.map(([label,...values])=>'<tr><th scope="row">'+esc(label)+'</th>'+values.map(v=>'<td'+financialTone(label,v)+'>'+esc(v)+'</td>').join('')+'</tr>').join('');
}
function renderStrategyCHoldings(){
  const state=strategyC;if(!state)return;
  const query=($('c-holdings-search').value||'').trim().toLowerCase();
  const total=state.metrics.net_equity||state.config.capital;
  if(state.pending&&!Object.keys(state.positions).length){
    const rows=Object.entries(state.pending.targets).map(([code,w])=>({code,name:state.symbols[code]?.name??code,w}));
    const shown=rows.filter(r=>!query||r.name.toLowerCase().includes(query)||r.code.includes(query));
    $('c-holdings-meta').textContent='· '+state.pending.execution_day+' 종가 매수 예약 '+rows.length+'종목 (종목당 약 '+number(100/rows.length,2)+'%)';
    table('c-holdings',['종목','코드','목표 비중','상태'],shown.map(r=>[r.name,r.code,number(r.w*100,2)+'%','매수 예약']));
    return;
  }
  const rows=Object.entries(state.positions).map(([code,p])=>{
    const value=p.quantity*p.last_close,cost=p.avg_cost*p.quantity;
    return {code,name:p.symbol?.name??code,qty:p.quantity,avg:p.avg_cost,price:p.last_close,date:p.last_price_date,value,profit:value-cost,ret:(value/cost-1)*100};
  }).sort((x,y)=>y.value-x.value);
  const shown=rows.filter(r=>!query||r.name.toLowerCase().includes(query)||r.code.includes(query));
  $('c-holdings-meta').textContent='· '+rows.length+'종목'+(state.pending?' · 다음 재조정 '+state.pending.execution_day+' 종가 예약':'')+' · 손익은 매수 비용 포함, 매도 비용 제외';
  table('c-holdings',['종목','코드','수량','평단가 (원)','현재가 (원)','평가액 (원)','비중','손익 (원)','손익 %','가격 날짜'],shown.map(r=>[r.name,r.code,number(r.qty),number(r.avg,0),number(r.price,0),number(r.value),number(r.value/total*100,2)+'%',number(r.profit),performancePct(r.ret),r.date]));
}
$('c-holdings-search').addEventListener('input',renderStrategyCHoldings);
function renderStrategyD(state){
  if(!state?.d0)return;
  strategyD=state;
  const names={};for(const v of D_VARIANTS)for(const r of state[v].universe?.rows??[])names[r.code]=r.name;
  for(const v of D_VARIANTS){
    const st=state[v],m=st.metrics;
    $(v+'-state').textContent=st.enabled?'자동 실행':st.started_day?'신규 재조정 중지':'시작 전';
    $(v+'-total').innerHTML='<small>총 수익률</small><strong'+financialTone('수익률',m.return_pct)+'>'+(m.return_pct>0?'+':'')+esc(performancePct(m.return_pct))+'</strong>';
    $(v+'-message').textContent=st.message??'';
    const total=m.net_equity||st.config.capital;
    const rows=Object.entries(st.positions).map(([code,p])=>{const value=p.quantity*p.last_close,cost=p.avg_cost*p.quantity;
      return [p.symbol?.name??names[code]??code,code,number(p.quantity),number(p.avg_cost,0),number(p.last_close,0),number(value),number(value/total*100,1)+'%',(st.pending?number((st.pending.targets[code]??0)*100,1)+'%':'—'),number(value-cost),performancePct((value/cost-1)*100)];});
    if(st.pending)for(const [code,w] of Object.entries(st.pending.targets))if(!st.positions[code])rows.push([names[code]??code,code,'—','—','—','—','0%',number(w*100,1)+'%','—','—']);
    table(v+'-holdings',['ETF','코드','수량','평단가 (원)','현재가 (원)','평가액 (원)','현재 비중','목표 비중'+(st.pending?' ('+st.pending.execution_day+')':''),'손익 (원)','손익 %'],rows);
  }
  const any=D_VARIANTS.some(v=>state[v].enabled);
  $('d-start').disabled=D_VARIANTS.every(v=>state[v].enabled);
  $('d-status').textContent=(any?'자동 실행 · 18:25 정산':'시작 전 또는 중지')+' · '+D_VARIANTS.map((v,i)=>['D0','D2','D3'][i]+' '+state[v].metrics.holding_count+'개 보유').join(' · ');
  renderAccountsSummary();
  if(comparisonState)renderComparison(comparisonState);
}
async function refreshComparison(){
  try{strategyC=await api('/api/strategy-c');}catch(e){strategyC=null;}
  try{strategyD=await api('/api/strategy-d');}catch(e){strategyD=null;}
  try{strategyF=await api('/api/strategy-f');}catch(e){strategyF=null;}
  try{strategyK=await api('/api/strategy-k');}catch(e){strategyK=null;}
  for(const side of US_SIDES){try{strategyUS[side]=await api('/api/strategy-'+side);}catch(e){strategyUS[side]=null;}}
  if(!threeYear){try{threeYear=await (await fetch('/static/strategy-3y.json?v=20261013-money-01')).json();}catch(e){threeYear=null;}}
  renderComparison(await api('/api/comparison-paper'));
  if(strategyC)renderStrategyC(strategyC);
  if(strategyD)renderStrategyD(strategyD);
  if(strategyF)renderStrategyF(strategyF);
  if(strategyK)renderStrategyK(strategyK);
  for(const side of US_SIDES)if(strategyUS[side])renderStrategyUS(side,strategyUS[side]);
  renderThreeYear();
}
for(const [id,path] of [['d-start','start'],['d-settle','reconcile']])$(id).onclick=handle(async()=>{
  if(busy)throw new Error('진행 중인 작업이 끝난 뒤 실행하세요.');
  $('d-status').textContent='D 작업 준비 중 · ETF 8종 종가를 확인합니다.';
  const job=await api('/api/strategy-d/'+path,'POST');await poll(job.id,renderStrategyD);await refreshComparison();
});
$('d-stop').onclick=handle(async()=>renderStrategyD(await api('/api/strategy-d/stop','POST')));
for(const [id,path] of [['c-start','start'],['c-settle','reconcile']])$(id).onclick=handle(async()=>{
  if(busy)throw new Error('진행 중인 작업이 끝난 뒤 실행하세요.');
  $('c-status').textContent='C 작업 준비 중 · 351종목 종가를 확인합니다.';
  const job=await api('/api/strategy-c/'+path,'POST');await poll(job.id,renderStrategyC);await refreshComparison();
});
$('c-stop').onclick=handle(async()=>renderStrategyC(await api('/api/strategy-c/stop','POST')));
$('comparison-filter').onchange=renderComparisonSelections;
$('comparison-selection-toggle').onclick=()=>{
  const body=$('comparison-selection-body'),button=$('comparison-selection-toggle');
  body.hidden=!body.hidden;button.textContent=body.hidden?'펼치기':'숨기기';button.setAttribute('aria-expanded',String(!body.hidden));
};
for(const [id,path] of [['comparison-start','start'],['comparison-settle','reconcile']])$(id).onclick=handle(async()=>{
  if(busy)throw new Error('진행 중인 작업이 끝난 뒤 실행하세요.');
  busy=true;setComparisonWorking(true);showComparisonProgress(0,'두 전략 작업을 준비합니다');
  try{const job=await api('/api/comparison-paper/'+path,'POST');await poll(job.id,renderComparison,{comparison:true});}
  catch(e){showComparisonError(e.message);throw e;}
  finally{busy=false;setComparisonWorking(false);await refreshComparison();}
});
$('comparison-stop').onclick=handle(async()=>{renderComparison(await api('/api/comparison-paper/stop','POST'));$('comparison-status').textContent='신규 매수 중지 · 진행 중 분석의 예약은 저장하지 않습니다. 보유분 정산은 계속합니다.';});
window.addEventListener('resize',()=>{if(comparisonState)renderComparison(comparisonState);});

function showAccountPanel(side){
  document.querySelectorAll('#comparison-history [data-account]').forEach(b=>{const on=b.dataset.account===side;b.classList.toggle('active',on);b.setAttribute('aria-selected',String(on));});
  for(const s of ['a','b','c','d','f',...US_SIDES])$('account-panel-'+s).hidden=s!==side;
  if(side==='f')renderStrategyF(strategyF);
}
document.querySelectorAll('#comparison-history [data-account]').forEach(b=>b.onclick=()=>showAccountPanel(b.dataset.account));

function renderStrategyF(state){
  if(!state?.config)return;
  strategyF=state;const m=state.metrics;
  $('f-state').textContent=state.enabled?'자동 실행':state.started_day?'신규 재조정 중지':'시작 전';
  $('f-total').innerHTML='<small>총 수익률</small><strong'+financialTone('수익률',m.return_pct)+'>'+(m.return_pct>0?'+':'')+esc(performancePct(m.return_pct))+'</strong>';
  $('f-message').textContent=state.message??'';
  $('f-start').disabled=!!state.enabled;
  $('f-status').textContent=(state.enabled?'자동 실행 · 18:35 정산':'시작 전 또는 중지')+' · 보유 '+m.holding_count+'개'+(state.pending?' · '+state.pending.execution_day+' 종가 재조정 예약':'');
  const q=($('f-holdings-search').value||'').trim().toLowerCase(),names=Object.fromEntries((state.universe?.rows??[]).map(r=>[r.code,r.name]));
  const total=m.net_equity||state.config.capital;
  let rows=Object.entries(state.positions).map(([code,p])=>{const value=p.quantity*p.last_close,cost=p.avg_cost*p.quantity;return {code,name:p.symbol?.name??names[code]??code,value,cells:[number(p.quantity),number(p.avg_cost,0),number(p.last_close,0),number(value),number(value/total*100,2)+'%',(state.pending?number((state.pending.targets[code]??0)*100,2)+'%':'—'),number(value-cost),performancePct((value/cost-1)*100)]};});
  if(state.pending)for(const [code,w] of Object.entries(state.pending.targets))if(!state.positions[code])rows.push({code,name:names[code]??code,value:w*1e12,cells:['—','—','—','—','0%',number(w*100,2)+'%','—','—']});
  rows=rows.filter(r=>!q||r.name.toLowerCase().includes(q)||r.code.includes(q)).sort((a,b)=>b.value-a.value);
  table('f-holdings',['종목·ETF','코드','수량','평단가 (원)','현재가 (원)','평가액 (원)','현재 비중','목표 비중','손익 (원)','손익 %'],rows.map(r=>[r.name,r.code,...r.cells]));
  renderAccountsSummary();
  if(comparisonState)renderComparison(comparisonState);
}
$('f-holdings-search').addEventListener('input',()=>renderStrategyF(strategyF));
for(const [id,path] of [['f-start','start'],['f-settle','reconcile']])$(id).onclick=handle(async()=>{
  if(busy)throw new Error('진행 중인 작업이 끝난 뒤 실행하세요.');
  $('f-status').textContent='F 작업 준비 중 · 주식 351종목과 ETF 8종 종가를 확인합니다.';
  const job=await api('/api/strategy-f/'+path,'POST');await poll(job.id,renderStrategyF);await refreshComparison();
});
$('f-stop').onclick=handle(async()=>renderStrategyF(await api('/api/strategy-f/stop','POST')));
const THREE_COLORS={A:'#1b64da',B:'#8b5cf6',C:'#0f9d76',D0:'#f08c00',D2:'#c2410c',D3:'#be185d',F:'#0b7285','E (참고·미운영)':'#868e96',KOSPI200:'#212529'};
function renderThreeYear(){
  if(!threeYear?.summary)return;
  const order=['A','B','C','D0','D2','D3','F','E (참고·미운영)','KOSPI200'].filter(k=>threeYear.summary[k]);
  $('three-year-window').textContent=threeYear.window[0]+' ~ '+threeYear.window[1];
  const sg=v=>v==null?'—':(v>0?'+':'')+number(v*100,1)+'%';
  const won=v=>v==null?'—':(v>0?'+':v<0?'−':'')+(Math.abs(v)>=1e8?number(Math.abs(v)/1e8,2)+'억원':number(Math.abs(v)/1e4,0)+'만원');
  const amt=v=>v==null?'—':number(v/1e8,2)+'억원';
  table('three-year-table',['전략','투입 자금 (평균 / 최대)','누적 매수금액','손익 금액','이익 합 / 손실 합','투입 자금 대비','계좌(10억) 기준 3년','연평균','최대 낙폭','샤프','매매'],order.map(k=>{const r=threeYear.summary[k];
    const full=r.bought_krw==null;
    return [k==='KOSPI200'?'KOSPI200 단순 보유':k,full?'10억 전액':number(r.avg_deployed_krw/1e4,0)+'만 / '+number(r.max_deployed_krw/1e4,0)+'만원',
      full?'—':amt(r.bought_krw),won(r.pnl_krw),r.gain_krw==null?'—':won(r.gain_krw)+' / '+won(r.loss_krw),
      sg(r.return_on_deployed)+(full?'':' (매수금액 대비 '+sg(r.return_on_bought)+')'),sg(r.total_return),sg(r.cagr),number(r.mdd*100,1)+'%',r.sharpe==null?'—':number(r.sharpe,2),
      r.trades==null?'—':r.trades+'건 · 승률 '+(r.win_rate==null?'—':pct(r.win_rate))];}));
  $('three-year-legend').innerHTML=order.map(k=>'<span><i class="swatch" style="background:'+THREE_COLORS[k]+'"></i>'+esc(k)+'</span>').join('');
  const canvas=$('three-year-chart'),ctx=canvas.getContext('2d'),ratio=window.devicePixelRatio||1,width=canvas.clientWidth||640,height=240;
  canvas.width=width*ratio;canvas.height=height*ratio;ctx.scale(ratio,ratio);ctx.clearRect(0,0,width,height);
  const dates=threeYear.weekly.dates,series=threeYear.weekly.series;
  const vals=order.flatMap(k=>series[k]??[]).filter(v=>v!=null).map(v=>v*100);
  const low=Math.min(0,...vals),high=Math.max(0,...vals);
  const y=v=>height-26-(v-low)/(high-low||1)*(height-44),x=i=>56+i/Math.max(1,dates.length-1)*(width-72);
  ctx.font='11px sans-serif';
  for(let i=0;i<5;i++){const v=low+(high-low)*i/4;ctx.strokeStyle='#e7ebf1';ctx.beginPath();ctx.moveTo(52,y(v));ctx.lineTo(width-12,y(v));ctx.stroke();ctx.fillStyle='#697586';ctx.fillText(number(v,0)+'%',0,y(v)+4);}
  for(const k of order){const s=series[k];if(!s)continue;ctx.strokeStyle=THREE_COLORS[k];ctx.lineWidth=k==='KOSPI200'?1.5:2;ctx.setLineDash(k==='KOSPI200'||k.startsWith('E')?[4,3]:[]);ctx.beginPath();let on=false;
    s.forEach((v,i)=>{if(v==null){on=false;return;}const px=x(i),py=y(v*100);if(!on){ctx.moveTo(px,py);on=true;}else ctx.lineTo(px,py);});ctx.stroke();}
  ctx.setLineDash([]);ctx.fillStyle='#697586';ctx.fillText(dates[0],56,height-6);ctx.fillText(dates.at(-1),width-80,height-6);
}
window.addEventListener('resize',()=>renderThreeYear());

function renderStrategyK(state){
  if(!state?.config)return;
  strategyK=state;
  $('k-state').textContent=state.enabled?'자동 실행':state.started_day?'중지':'시작 전';
  $('k-start').disabled=!!state.enabled;
  $('k-status').textContent=(state.enabled?'자동 실행 · 18:40 정산':'시작 전 또는 중지')+' · '+(state.message??'');
  renderAccountsSummary();
  if(comparisonState)renderComparison(comparisonState);
}
for(const [id,path] of [['k-start','start'],['k-settle','reconcile']])$(id).onclick=handle(async()=>{
  if(busy)throw new Error('진행 중인 작업이 끝난 뒤 실행하세요.');
  $('k-status').textContent='K 작업 준비 중 · KODEX 200 종가를 확인합니다.';
  const job=await api('/api/strategy-k/'+path,'POST');await poll(job.id,renderStrategyK);await refreshComparison();
});
$('k-stop').onclick=handle(async()=>renderStrategyK(await api('/api/strategy-k/stop','POST')));

function usd(v,digits=2){return v==null?'—':'$'+number(v,digits);}
function renderStrategyUS(side,state){
  if(!state?.config)return;
  strategyUS[side]=state;const m=state.metrics,us=state.config.currency==='USD';
  const money=(v,d=2)=>v==null?'—':us?usd(v,d):number(v,0)+'원';
  $(side+'-state').textContent=state.enabled?'자동 실행':state.started_day?'주문 중지':'시작 전';
  $(side+'-start').disabled=!!state.enabled;
  $(side+'-total').innerHTML='<small>총 수익률'+(us?' (원화 · 달러 '+esc(m.return_usd_pct==null?'—':(m.return_usd_pct>0?'+':'')+performancePct(m.return_usd_pct))+')':'')+'</small><strong'+financialTone('수익률',m.return_pct)+'>'+(m.return_pct>0?'+':'')+esc(performancePct(m.return_pct))+'</strong>';
  $(side+'-status').textContent=(state.enabled?'자동 실행 · '+(us?'매일 07:30 미국 종가 정산':'매일 18:45 국내 종가 정산'):state.started_day?'주문 중지':'시작 전')+' · '+(state.message??'')+(state.errors?.length?' · '+state.errors.map(e=>e.error).join(', '):'');
  $(side+'-message').textContent=state.started_day?('시작 '+state.started_day+(us?' · 시작 환율 '+number(state.fx_start,2)+'원 · 초기 '+usd(state.capital_usd,0)+' (10억원) · 현재 환율 '+number(state.fx,2)+'원':' · 초기 10억원')+' · '+state.message):state.message;
  const lv=state.levels,b=state.book,cfg=state.config,held=[['보유 수량',number(state.shares)+'주'],['현금 (Pool)',money(state.cash,0)],['평가액',money(m.net_equity_usd,0)],['종가',money(state.last_close)]];
  const rows=side==='g'?(lv?[['사이클',b.cycle+'회차 · 시작 '+b.cycle_start],['T (진행 회차)',number(lv.t,2)+' / '+cfg.splits],['1회 매수금',usd(b.unit,0)],['평단',usd(state.avg)],['별%',number(lv.star_pct,2)+'%'],['별지점 (1/4 매도 LOC)',usd(lv.star_price)],['매수 LOC',(lv.t<cfg.splits/2?'평단 '+usd(state.avg)+' · 별지점−0.01 '+usd(lv.star_price-.01):'별지점−0.01 '+usd(lv.star_price-.01))],['목표가 (3/4 지정가)',usd(lv.target_price)],...held]:held):
    (lv?[['주기',b.cycle+'주기 · 시작 '+b.cycle_start+' · V 갱신 '+b.cycle_end+' 종가'],['V',money(lv.v,0)],['하단 밴드',money(lv.low,0)],['상단 밴드',money(lv.high,0)],
      ['매수 사다리','다음 '+money(lv.next_buy)+' · 남은 '+number(lv.buy_left)+'칸 (1주씩, Q0 '+number(b.q0)+'주)'],['매도 사다리','다음 '+money(lv.next_sell)+' · 남은 '+number(lv.sell_left)+'칸 (1주씩)'],...held]:held);
  table(side+'-levels',['항목','값'],rows);
  if(side==='g')table('g-cycles',['사이클','시작','종료','시작 자금','종료 현금','수익률'],(b.history??[]).slice().reverse().map(c=>[c.cycle+'회차',c.start,c.end,usd(c.seed,0),usd(c.end_cash,0),performancePct(c.return_pct)]));
  else table(side+'-cycles',['주기','시작','갱신일','평가액','Pool','V 이전','V 이후','매수·매도 칸'],(b.history??[]).slice().reverse().map(c=>[c.cycle+'주기',c.start,c.end,money(c.evaluation,0),money(c.pool,0),money(c.v_before,0),money(c.v_after,0),(c.bought??0)+' / '+(c.sold??0)]));
  table(side+'-trades',['날짜','구분','수량','가격','금액','실현 손익','근거'],state.trades.slice(-60).reverse().map(t=>[t.date,t.side==='BUY'?'매수':'매도',number(t.quantity),money(t.price),money(Math.abs(t.amount_usd),0),t.realized_profit_usd==null?'—':money(t.realized_profit_usd,0),t.reason]));
  renderAccountsSummary();
  if(comparisonState)renderComparison(comparisonState);
}
for(const side of US_SIDES){
  for(const [id,path] of [[side+'-start','start'],[side+'-settle','reconcile']])$(id).onclick=handle(async()=>{
    if(busy)throw new Error('진행 중인 작업이 끝난 뒤 실행하세요.');
    $(side+'-status').textContent=side.toUpperCase()+' 작업 준비 중 · 일봉'+(side==='i'?'':'과 환율')+'을 확인합니다.';
    const job=await api('/api/strategy-'+side+'/'+path,'POST');await poll(job.id,st=>renderStrategyUS(side,st));await refreshComparison();
  });
  $(side+'-stop').onclick=handle(async()=>renderStrategyUS(side,await api('/api/strategy-'+side+'/stop','POST')));
}
