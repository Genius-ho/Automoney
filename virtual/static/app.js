'use strict';
const $=id=>document.getElementById(id);
let selected=null, currentResult=null, busy=false;
let stockSearchSequence=0,portfolioSearchSequence=0;
const keys=['horizon','target_pct','threshold_pct','years','capital','buy_fee_pct','sell_fee_pct','sell_tax_pct','slippage_pct','fill_buffer_pct'];
const esc=value=>String(value??'—').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number=(v,d=0)=>v==null?'—':Number(v).toLocaleString('ko-KR',{maximumFractionDigits:d});
const pct=v=>v==null?'사례 없음':number(v*100,1)+'%';
const money=(v,market)=>v==null?'—':Number(v).toLocaleString('ko-KR',{minimumFractionDigits:market==='US'?2:0,maximumFractionDigits:market==='US'?2:0});
const performancePct=v=>v==null?'—':number(v,Math.abs(v)>99.99&&Math.abs(v)<100?6:2)+'%';
const settings=()=>({...Object.fromEntries(keys.map(k=>[k,Number($(k).value)])),feature_set:$('feature_set').value});
function notice(message,error=false){$('notice').hidden=false;$('notice').textContent=message;$('notice').className=error?'error':'success';}
async function api(path,method='GET',body){
  const response=await fetch(path,{method,headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const data=await response.json();
  if(!response.ok)throw new Error(typeof data.detail==='string'?data.detail:JSON.stringify(data.detail??data));
  return data;
}
function tableColumnKind(header){
  if(/^(시장|순위|차수|상태|수량|신호|구간|거래|입력 수|선정 수|최초 예약|중복 제외|현재 예약|보유|매도 완료|미체결 종료)$/.test(header)||/수량$/.test(header))return 'compact';
  if(header==='종목')return 'symbol';
  if(/^(매수일|매도일|선정일|매수 예정일|만기 예정일|만기 예정일|가격 기준일|가격일|날짜)$/.test(header))return 'date';
  if(/적중률|예측 확률|^precision$|^기준 종가$|^평단가|^현재가|^매도가|^손익|^매수 종가|^최신 종가/.test(header))return 'number';
  return 'normal';
}
function table(id,headers,rows,help={}){
  const column=h=>' data-column="'+tableColumnKind(h)+'"';
  const helpButton=h=>help[h]?'<button type="button" class="metric-help-button" data-metric-help="'+esc(help[h])+'" aria-label="'+esc(h)+' 설명" aria-controls="universe-metric-help" aria-expanded="false">?</button>':'';
  $(id).innerHTML=rows.length?'<table><colgroup>'+headers.map(h=>'<col class="column-'+tableColumnKind(h)+'">').join('')+'</colgroup><thead><tr>'+headers.map(h=>'<th'+column(h)+'>'+esc(h)+helpButton(h)+'</th>').join('')+'</tr></thead><tbody>'+rows.map(row=>'<tr>'+row.map((c,i)=>'<td'+column(headers[i])+financialTone(headers[i],c)+'>'+esc(c)+'</td>').join('')+'</tr>').join('')+'</tbody></table>':'<div class="empty compact">표시할 기록이 없습니다.</div>';
}
function financialTone(label,value){
  if(!/(손익|수익률|등락률)/.test(label))return '';
  const amount=Number(String(value).replace(/,/g,'').replace(/%$/,''));
  return Number.isFinite(amount)&&amount!==0?' class="'+(amount>0?'up':'down')+'"':'';
}
function cards(id,items){$(id).innerHTML=items.map(([label,value])=>'<div class="card stat"><small>'+esc(label)+'</small><b'+financialTone(label,value)+'>'+esc(value)+'</b></div>').join('');}
function clearAnalysis(){
  currentResult=null;
  const empty={'result-name':'분석 결과','result-date':'조회 데이터 기준','probability':'—','close':'—','target':'—','feature-count':'—','source':'분석 후 표시','data-meta':'최근 5년의 일봉으로 학습·검증합니다.','selection':'분석하면 평균 적중률과 최신 상승 신호가 표시됩니다.','probability-label':'검증 구간 평균 적중률'};
  Object.entries(empty).forEach(([id,text])=>$(id).textContent=text);
  $('prob-fill').style.width='0%';$('selection').className='hint';
  $('report-links').innerHTML='';$('validation-content').hidden=true;$('validation-empty').hidden=false;
  $('feature-table').innerHTML='<div class="empty compact">분석 후 지표가 표시됩니다.</div>';
  $('warnings').replaceChildren();
  ['평균 적중률은 검증 구간 precision의 단순 평균입니다.','최신 상승 신호는 원본 모델의 0/1 판정입니다.','정답은 다음 기간의 종가 기준 목표 상승 여부입니다.'].forEach(text=>{const li=document.createElement('li');li.textContent=text;$('warnings').append(li);});
  chart('price-chart',[]);chart('equity-chart',[]);
}
function choose(symbol){clearAnalysis();selected=symbol;$('selected-symbol').textContent=symbolLabel(symbol)+(symbol.unverified?' · 이름 미확인':'');$('query').value=symbol.name;$('candidates').replaceChildren();$('capital-label').textContent='초기 거래 자금 ('+(symbol.market==='KR'?'원':'USD')+')';}
function symbolLabel(symbol){return symbol.name+(symbol.name_en&&symbol.name_en!==symbol.name?' ('+symbol.name_en+')':'')+' · '+symbol.code+' · '+(symbol.market==='KR'?'한국':'미국')+(symbol.industry?' · '+symbol.industry:'')+(symbol.asset_type==='ETF'?' · ETF':'')+(symbol.match_type==='fuzzy'?' · 유사 이름':'');}
async function search(){
  const query=$('query').value.trim(),sequence=++stockSearchSequence;
  const response=await api('/api/symbols?q='+encodeURIComponent(query));
  if(sequence!==stockSearchSequence||query!==$('query').value.trim())return;
  const candidates=response.candidates;
  selected=null;$('candidates').replaceChildren();
  if(candidates.length===1&&candidates[0].match_type!=='fuzzy'){choose(candidates[0]);return;}
  $('selected-symbol').textContent=candidates.some(s=>s.match_type==='fuzzy')?'비슷한 이름을 찾았습니다. 원하는 종목을 선택하세요.':candidates.length?'종목을 선택하세요.':'등록된 이름이 없습니다. 목록을 갱신하거나 종목코드를 입력하세요.';
  candidates.forEach(symbol=>{const b=document.createElement('button');b.type='button';b.textContent=symbolLabel(symbol);b.onclick=()=>choose(symbol);$('candidates').append(b);});
}
function activate(tab){document.querySelectorAll('.tab').forEach(e=>e.hidden=e.id!==tab);document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));if(tab==='paper')refreshPaper().catch(e=>notice(e.message,true));if(tab==='comparison')refreshComparison().catch(e=>notice(e.message,true));if(currentResult)requestAnimationFrame(()=>drawResults(currentResult));}
document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>activate(b.dataset.tab));
function chart(id,points,color){
  const canvas=$(id),ctx=canvas.getContext('2d'),width=canvas.clientWidth||640,height=220,dpr=window.devicePixelRatio||1;
  canvas.width=width*dpr;canvas.height=height*dpr;ctx.scale(dpr,dpr);ctx.clearRect(0,0,width,height);
  const left=64,right=16,top=20,bottom=30;
  ctx.strokeStyle='#edf0f3';ctx.lineWidth=1;ctx.font='11px sans-serif';ctx.fillStyle='#626d7b';
  for(let i=0;i<4;i++){const y=top+i*(height-top-bottom)/3;ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(width-right,y);ctx.stroke();}
  if(!points.length){ctx.fillText('분석 후 데이터가 표시됩니다.',left+12,100);return;}
  color=color??(points.at(-1).value>=points[0].value?'#f04452':'#3182f6');
  const values=points.map(p=>p.value),lo=Math.min(...values),hi=Math.max(...values),span=hi-lo||hi*.01||1;
  const xy=points.map((p,i)=>[left+i*(width-left-right)/Math.max(1,points.length-1),top+(hi-p.value)/span*(height-top-bottom)]);
  const gradient=ctx.createLinearGradient(0,top,0,height-bottom);gradient.addColorStop(0,color+'14');gradient.addColorStop(1,color+'00');
  ctx.beginPath();ctx.moveTo(xy[0][0],height-bottom);xy.forEach(([x,y])=>ctx.lineTo(x,y));ctx.lineTo(xy.at(-1)[0],height-bottom);ctx.closePath();ctx.fillStyle=gradient;ctx.fill();
  ctx.strokeStyle=color;ctx.lineWidth=2;ctx.beginPath();xy.forEach(([x,y],i)=>i?ctx.lineTo(x,y):ctx.moveTo(x,y));ctx.stroke();
  ctx.fillStyle='#626d7b';for(let i=0;i<4;i++)ctx.fillText(number(hi-span*i/3),4,top+i*(height-top-bottom)/3+4);
  ctx.fillText(points[0].date,left,height-7);ctx.textAlign='right';ctx.fillText(points.at(-1).date,width-right,height-7);ctx.textAlign='left';
}
function drawResults(r){chart('price-chart',r.chart.map(p=>({date:p.date,value:p.Close})));if(r.simulations?.buffer)chart('equity-chart',r.simulations.buffer.equity);}
function render(r){
  if(r.analysis_method==='original-close-v1')return renderOriginal(r);
  $('probability-label').textContent='이전 확장 방식 · 추정 확률';
  $('variant-section').hidden=false;$('calibration-section').hidden=false;
  $('variant-title').textContent='이전 확장 방식 · 지표 구성별 비교';
  $('variant-description').textContent='Brier·log loss는 낮을수록 좋습니다. 이전 확장 방식의 입력 구성별 검증 기록입니다.';
  $('validation-description').textContent='이전 확장 방식 저장 결과: 학습·확률 보정·최종 평가 및 입력 구성별 비교입니다.';
  $('simulation-description').textContent='이전 확장 방식의 검증 확률과 선정 기준을 사용한 가상 매매 기록입니다. 목표는 비용 차감 순수익입니다.';
  renderExpanded(r);
  $('result-date').textContent=r.as_of+' · 이전 확장 방식 저장 결과';
}
function renderOriginal(r){
  const expanded=r.feature_set==='expanded';
  const window=r.analysis_window;
  currentResult=r;$('result-name').textContent=r.symbol.name+' · '+r.symbol.code;
  $('result-date').textContent=r.as_of+(window?' · 최근 5년':' · 이전 전체 이력')+(expanded?' / 입력 확장':' / 원본 입력');
  $('feature-mode-tag').textContent=r.feature_count+'개 입력 · '+(expanded?'조사 지표 추가':'원본')+' · XGBoost';
  $('probability-label').textContent='검증 구간 평균 적중률';
  $('probability').textContent=pct(r.mean_precision);$('prob-fill').style.width=(r.mean_precision*100)+'%';
  $('selection').textContent=(r.latest_signal===1?'상승 신호 있음 (1)':'상승 신호 없음 (0)')+' · 다음 '+r.settings.horizon+'개 데이터 행 / 종가 상승 '+r.settings.target_pct+'% 목표';
  $('selection').className=r.latest_signal===1?'signal positive':'signal neutral';
  const currency=r.symbol.market==='KR'?'원':'USD';
  $('close').textContent=number(r.close,2)+' '+currency;$('target').textContent=number(r.indicative_target,2)+' '+currency;$('feature-count').textContent=r.feature_count+'개';
  $('source').textContent=r.data_source?.source??'CSV';
  $('data-meta').textContent=window?'최근 5년 · '+window.start+' ~ '+window.end+' · 학습·검증 '+number(r.sample_count)+'행':'이전 전체 이력 저장 결과 · 기준일 '+r.as_of+' · 지표 계산 후 '+number(r.sample_count)+'행';
  $('warnings').replaceChildren();r.warnings.forEach(w=>{const li=document.createElement('li');li.textContent=w;$('warnings').append(li);});
  $('report-links').innerHTML=r.report_id?['report.md','result.json','predictions.csv','folds.csv',...(r.input_comparison?['comparison.csv']:[]),'trades_buffer.csv'].map(file=>'<a href="/api/reports/'+esc(r.report_id)+'/'+file+'">'+esc(file)+'</a>').join(''):'';
  const importance=new Map((r.feature_importance??[]).map(f=>[f.feature,f.importance]));
  const groupNames={original:'원본',returns:'수익률',averages:'이동평균',rsi:'RSI',volatility:'변동성',bollinger:'볼린저',volume:'거래량',money_flow:'자금 흐름',macd:'MACD',directional:'방향성',oscillators:'오실레이터',donchian:'돈치안',market:'시장',bar_shape:'봉 모양'};
  table('feature-table',['지표 묶음','입력 특성','최신 입력값','마지막 모델 중요도'],Object.entries(r.latest_features??{}).map(([name,value])=>{
    const group=Object.entries(r.groups??{}).find(([,columns])=>columns.includes(name))?.[0];
    return [groupNames[group]??'원본',name,number(value,6),importance.has(name)?pct(importance.get(name)):'—'];
  }));
  $('validation-empty').hidden=true;$('validation-content').hidden=false;
  $('variant-section').hidden=true;$('calibration-section').hidden=true;
  if(r.input_comparison){
    $('variant-section').hidden=false;$('variant-title').textContent='원본 입력과 조사 지표 추가 비교';
    $('variant-description').textContent='두 모델은 같은 날짜와 종가 기준 정답, 같은 5개 검증 구간을 사용합니다. 지표 추가로 초기 계산 기간이 길어져 이전 단독 원본 결과와 기간이 다를 수 있습니다.';
    table('variant-table',['입력 구성','입력 수','공통 데이터 행','평균 적중률','최신 상승 신호'],r.input_comparison.models.map(m=>[m.name,m.feature_count,m.sample_count,pct(m.mean_precision),m.latest_signal===1?'있음 (1)':'없음 (0)']));
  }
  $('validation-description').textContent=(window?'최근 5년 ('+window.start+' ~ '+window.end+')의 일봉을':'이전 전체 이력 저장 결과를')+' 5개 시간순 구간에서 검증하고 구간별 precision을 단순 평균합니다. 각 구간 끝의 예측 기간만큼 정답을 제외합니다.';
  $('simulation-description').textContent='검증 구간의 0/1 신호만 사용한 별도 가상 매매입니다. AI 정답은 종가 상승 여부, 매매 목표는 비용 차감 순수익입니다. 목표 미달 시 보유 기간 마지막 거래일 종가로 청산합니다.';
  cards('holdout-cards',[['구간별 precision 단순 평균',pct(r.mean_precision)],['유효 검증 구간',r.valid_folds+' / 5'],['최신 상승 신호',r.latest_signal===1?'있음 (1)':'없음 (0)'],['검증 선정 사례 합계',number(r.folds.reduce((n,f)=>n+f.selected_n,0))]]);
  table('fold-table',['구간','학습 구간','검증 구간','평가 행','상승 신호 수','정답 수','precision','상태'],r.folds.map(f=>[f.fold,f.train_start+' ~ '+f.train_end,f.test_start+' ~ '+f.test_end,f.n,f.selected_n,f.hits,f.skipped?'—':pct(f.precision),f.skipped?'학습 정답 한 종류 · 제외':'평균에 포함']));
  renderTrading(r);drawResults(r);
}
function renderTrading(r){
  const names={touch:'호가 터치',buffer:'체결 여유',stress:'슬리피지 2배'};
  const market=r.symbol.market,currency=market==='US'?'USD':'원';
  table('simulation-table',['체결 모델','초기 자금 ('+currency+')','최종 평가액 ('+currency+')','수익률','최대 낙폭','거래','목표 청산','미청산'],Object.entries(r.simulations??{}).map(([k,s])=>[names[k],money(s.initial_capital??r.settings?.capital,market),money(s.final_equity,market),performancePct(s.return_pct),performancePct(s.max_drawdown_pct),s.trade_count,s.target_hits,s.open_position?'보유 중':'없음']));
  table('trade-table',['매수일','매도일','수량','매수가 ('+currency+')','매도가 ('+currency+')','순수익률','청산 사유'],(r.simulations?.buffer?.trades??[]).slice(-100).map(t=>[t.buy_date,t.sell_date,t.quantity,number(t.buy_price,2),number(t.sell_price,2),performancePct(t.net_return_pct),t.reason==='target'?'목표 도달':'기간 만료']));
}
function renderExpanded(r){
  currentResult=r;$('result-name').textContent=r.symbol.name+' · '+r.symbol.code;$('result-date').textContent=r.as_of+' 기준';
  $('probability').textContent=number(r.latest_probability*100,1)+'%';$('prob-fill').style.width=(r.latest_probability*100)+'%';
  $('selection').textContent=(r.selected?'선정 기준 통과':'선정 기준 미달')+' · '+r.settings.horizon+'거래일 / 순수익 '+r.settings.target_pct+'% / 확률 '+r.settings.threshold_pct+'% 이상';
  $('selection').className=r.selected?'signal positive':'signal neutral';
  const currency=r.symbol.market==='KR'?'원':'USD';$('close').textContent=number(r.close,2)+' '+currency;$('target').textContent=number(r.indicative_target,2)+' '+currency;$('feature-count').textContent=r.feature_count+'개';
  $('source').textContent=r.data_source?.source??'CSV';$('data-meta').textContent='기준일 '+r.as_of+' · 학습 가능 표본 '+number(r.sample_count)+'개 · 현재 일봉 제외';
  $('warnings').replaceChildren();r.warnings.forEach(w=>{const li=document.createElement('li');li.textContent=w;$('warnings').append(li);});
  $('report-links').innerHTML=r.report_id?['report.md','result.json','predictions.csv','comparison.csv','trades_buffer.csv'].map(file=>'<a href="/api/reports/'+esc(r.report_id)+'/'+file+'">'+esc(file)+'</a>').join(''):'';
  const groupNames={returns:'수익률',averages:'이동평균',rsi:'RSI',volatility:'변동성',bollinger:'볼린저',volume:'거래량',money_flow:'자금 흐름',macd:'MACD',directional:'방향성',oscillators:'오실레이터',donchian:'돈치안',market:'시장',bar_shape:'봉 모양'};
  const importance=new Map((r.feature_importance??[]).map(f=>[f.feature,f.importance]));
  table('feature-table',['지표 묶음','입력 특성','최신 입력값','모델 중요도'],Object.entries(r.latest_features??{}).sort((a,b)=>(importance.get(b[0])??0)-(importance.get(a[0])??0)).map(([name,value])=>{
    const group=Object.entries(r.groups??{}).find(([,features])=>features.includes(name))?.[0];
    return [groupNames[group]??group??'—',name,number(value,6),importance.has(name)?pct(importance.get(name)):'—'];
  }));
  $('validation-empty').hidden=true;$('validation-content').hidden=false;
  const h=r.holdout;
  cards('holdout-cards',[['최종 평가 선정 적중률',pct(h.selected_hit_rate)],['선정 사례',number(h.selected_n)+' / '+number(h.n)],['목표 도달 기본 빈도',pct(h.base_rate)],['최종 Brier',number(h.brier,4)]]);
  table('variant-table',['입력 구성','표본','Brier ↓','log loss ↓','선정 수','선정 적중률'],r.variants.map(v=>[v.name,v.n,number(v.brier,4),number(v.log_loss,4),v.selected_n,pct(v.selected_hit_rate)]));
  table('fold-table',['구간','학습 종료','보정 구간','평가 구간','평가 수','선정 적중률'],r.folds.map(f=>[f.fold,f.train_end,f.cal_start+' ~ '+f.cal_end,f.test_start+' ~ '+f.test_end,f.n,pct(f.selected_hit_rate)]));
  table('calibration-table',['예측 확률 구간','표본','실제 목표 도달','표본 상태'],h.bins.map(b=>[number(b.low*100)+'~'+number(b.high*100)+'%',b.n,pct(b.actual_rate),b.small_sample?'소표본':'관측 있음']));
  renderTrading(r);
  drawResults(r);
}
async function poll(id,onDone,options={}){
  busy=true;$('job-panel').hidden=false;
  if(options.comparison)setComparisonWorking(true);
  if(options.universe)setUniverseWorking(true,'100종목 분석·매수 예약을 준비하고 있습니다.');
  if(options.portfolio){clearPortfolioResult();setPortfolioWorking(true,'선택한 종목의 가격과 투자 비중을 계산하고 있습니다.');}
  let restoredInputs=false;
  try{
    while(true){
      const job=await api('/api/jobs/'+id);$('job-message').textContent=job.message;$('job-percent').textContent=job.progress+'%';$('job-progress').value=job.progress;
      if(options.portfolio&&!restoredInputs&&job.request){restorePortfolioInputs(job.request);restoredInputs=true;}
      if(options.universe)$('universe-action-status').textContent='진행 중 · '+job.message+' · '+job.progress+'%';
      if(options.universe)showUniverseJob(job.progress,'진행 중 · '+job.message+' · '+job.progress+'%');
      if(options.comparison)showComparisonProgress(job.progress,job.message);
      if(options.portfolio)$('portfolio-status').textContent='진행 중 · '+job.message+' · '+job.progress+'%';
      if(job.status==='failed')throw new Error(job.error);
      if(job.status==='done'){await onDone(job.result);if(options.universe){$('universe-action-status').textContent=universeExecutionStatus(job.result);showUniverseJob(100,job.result?.scan_execution?.message??'작업 완료 · '+universeExecutionStatus(job.result));}notice('작업이 완료되었습니다.');break;}
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
  }catch(e){notice(e.message,true);if(options.comparison)showComparisonError(e.message);if(options.universe){$('universe-action-status').textContent='작업 실패 · '+e.message;showUniverseJob($('universe-job-progress').value,'작업 실패 · '+e.message);}if(options.portfolio){clearPortfolioResult();$('portfolio-status').textContent='계산 실패 · '+e.message;}}finally{busy=false;$('job-panel').hidden=true;if(options.universe)setUniverseWorking(false);if(options.portfolio)setPortfolioWorking(false);if(options.comparison)setComparisonWorking(false);}
}
function handle(operation){return async event=>{if(event)event.preventDefault();try{await operation();}catch(e){notice(e.message,true);}};}
$('search').onclick=handle(search);
$('query').addEventListener('input',()=>{stockSearchSequence++;clearAnalysis();selected=null;$('candidates').replaceChildren();$('selected-symbol').textContent='찾기를 눌러 종목을 확인하세요.';});
$('feature_set').onchange=()=>clearAnalysis();
$('analysis-form').onsubmit=handle(async()=>{if(busy)throw new Error('진행 중인 작업이 끝난 뒤 실행하세요.');clearAnalysis();if(!selected)await search();if(!selected)throw new Error('종목 후보를 선택하세요.');const s=settings();await api('/api/settings','PUT',s);const response=await api('/api/analyze','POST',{symbol:selected,settings:s,csv:$('csv-text').value});await poll(response.id,render);});
$('csv-file').onchange=handle(async()=>{const file=$('csv-file').files[0];if(!file)return;if(file.size>10000000)throw new Error('CSV는 10MB 이하여야 합니다.');$('csv-text').value=await file.text();});
$('refresh-symbols').onclick=handle(async()=>{const response=await api('/api/symbols/refresh?market='+(selected?.market??'KR'),'POST');await poll(response.id,()=>notice('목록 갱신 완료. 다시 검색하세요.'));});
async function refreshLegacyPaper(){
  const p=await api('/api/paper');
  cards('paper-cards',[['자동 매매',p.enabled?'켜짐':'꺼짐'],['선택 종목',p.symbol?.name??'미설정'],['현금',number(p.position?p.position.cash_left:p.cash)+'원'],['평가액',number(p.mark_equity??p.cash)+'원']]);
  $('paper-position').textContent=p.position?p.position.symbol.name+' · '+p.position.quantity+'주 · 목표 '+number(p.position.target)+'원 · 매수 '+p.position.buy_date:'보유 종목 없음';
  if(p.signal)$('paper-position').textContent+=' / 다음 신호 '+('latest_signal' in p.signal?(p.signal.latest_signal===1?'상승 신호 있음 (1)':'상승 신호 없음 (0)'):'이전 확장 방식 '+pct(p.signal.probability))+' ('+p.signal.as_of+')';
  $('paper-message').textContent=p.message;
  table('paper-orders',['날짜','종목','주문','목표가','상태'],p.orders.slice(-30).reverse().map(o=>[o.day,o.code,o.type,number(o.target),o.status]));
  table('paper-trades',['종목','매수일','매도일','수량','순수익률','매도 후 자금'],p.trades.slice(-50).reverse().map(t=>[t.symbol.name,t.buy_date,t.sell_date,t.quantity,number(t.net_return_pct,2)+'%',number(t.cash_after)]));
}
let universeLoaded=false,universeWorking=false;
let universeCandidates=[],universeScoreLabel='보정 예측 확률';
const universeFilters={all:'전체',candidate:'매수 후보',below:'기준 미달',budget:'1주 예산 부족',error:'분석 제외',duplicate:'중복 제외',cash:'가용 현금 부족'};
function renderUniverseCandidates(){
  const filter=$('universe-filter').value||'all';
  const rows=filter==='all'?universeCandidates:universeCandidates.filter(c=>c.status===universeFilters[filter]);
  table('universe-candidates',['시장','순위','종목',universeScoreLabel,'신호','기준 종가','결과 / 제외 사유'],rows.map(c=>[c.exchange,c.rank,c.name+' · '+c.code,pct(c.score),c.signal==null?'—':c.signal,number(c.close),c.error??c.status]),{[universeScoreLabel]:universeScoreLabel==='과거 적중률'?'precision':'probability','신호':'signal'});
  $('universe-filter-count').textContent=universeFilters[filter]+' '+rows.length+'종목 / 전체 '+universeCandidates.length+'종목';
  $('universe-export').href='/api/universe-paper/export.xlsx?result_filter='+encodeURIComponent(filter);
}
const universeMetricHelp={
  precision:{title:'과거 적중률은 어떻게 계산하나요?',text:'최근 5년 일봉을 시간순 5개 구간으로 나눕니다. 각 구간은 앞선 데이터로 학습하고 뒤쪽 데이터로 검증합니다.\n\n정답 1: 기준일 종가보다 다음 10개 분석 일봉의 종가 중 한 번이라도 5% 이상 높으면 1, 아니면 0입니다. 지표 결측을 제외한 분석 데이터 행 기준이며 고가·장중 가격은 사용하지 않습니다. 구간 끝 10개 행은 미래 정답을 확인할 수 없어 제외합니다.\n\n구간별 적중률 = 실제로 목표를 달성한 수 ÷ 상승 신호를 낸 수 × 100\n예: 상승 신호 20번 중 14번 목표 달성 → 70%. 상승 신호가 없으면 해당 구간은 0%입니다.\n\n과거 검증의 상승 신호는 원본 방식인 모델 확률 50% 초과로 계산합니다. 최신 매수 신호의 60% 기준과 구분합니다. 표의 값은 유효 구간별 적중률의 단순 평균입니다. 모든 구간의 사례를 합쳐 계산한 값과 다를 수 있습니다. 학습 정답이 한 종류인 구간은 제외합니다. 이번 종목의 미래 상승 확률이나 실제 매매 수익률을 뜻하지 않습니다.'},
  signal:{title:'신호 0·1은 어떻게 나오나요?',text:'기준일의 주가·거래량·RSI·MACD 등 지표를 마지막 유효 검증 구간에서 학습한 XGBoost 모델에 넣습니다. 다섯 모델의 투표가 아니라 마지막 유효 모델의 판단입니다.\n\n모델이 계산한 목표 도달 확률이 60% 이상이면 1, 60% 미만이면 0으로 분류합니다. 이 내부 확률은 보정 예측 확률과 다릅니다.\n1 = 다음 10개 분석 일봉 중 종가 +5% 목표에 도달할 것으로 분류\n0 = 목표 도달로 분류하지 않음. 반드시 하락한다는 뜻은 아닙니다.\n\n과거 적중률 60% 이상이고 신호가 1이어야 매수 후보가 됩니다. 예산 부족·중복 보유 등의 조건도 별도로 적용합니다. 이 신호의 정답에는 매매 수수료·거래세·손절이 반영되지 않습니다.'},
  probability:{title:'보정 예측 확률은 어떻게 계산하나요?',text:'최근 5년 데이터에서 다음 10거래일 중 종가가 기준 종가보다 5% 이상 높아지는지를 정답으로 만듭니다. 먼저 앞선 학습 구간으로 XGBoost를 학습합니다. 이후 별도의 과거 보정 구간에서 모델 확률과 실제 정답의 관계를 로지스틱 회귀로 보정합니다. 미래 정답이 다음 구간과 겹치는 행은 제외합니다.\n\n최신 지표를 넣어 얻은 모델 확률을 이 보정 함수에 통과시킨 값입니다. 과거 적중률의 평균과 다른 계산입니다. 60% 이상이면 매수 후보이며, 예산·중복 등은 별도로 확인합니다. 예측 확률은 목표 달성을 보장하지 않습니다.'}
};
let universeHelpTrigger=null,universeLegacySignal=false;
function closeUniverseMetricHelp(){
  $('universe-metric-help').hidden=true;
  universeHelpTrigger?.setAttribute('aria-expanded','false');
  universeHelpTrigger?.focus?.();
}
function openUniverseMetricHelp(kind,trigger=null){
  const info=universeMetricHelp[kind];if(!info)return;
  universeHelpTrigger?.setAttribute('aria-expanded','false');universeHelpTrigger=trigger;
  const probabilitySignal=kind==='signal'&&universeScoreLabel!=='과거 적중률';
  $('universe-metric-help-title').textContent=probabilitySignal?'보정 확률 모드의 신호 표시':info.title;
  $('universe-metric-help-text').textContent=probabilitySignal?'신호 —는 이 모드에서 이진 신호를 별도로 계산하지 않는다는 뜻입니다. 신호 0과 다르며, 분석 실패를 뜻하지도 않습니다. 보정 예측 확률 60% 이상 여부로 후보를 선정합니다.':info.text;
  if(kind==='signal'&&universeLegacySignal)$('universe-metric-help-text').textContent+='\n\n현재 표는 기존 50% 초과 기준으로 저장된 결과입니다. 새 분석부터 60% 기준을 적용하며 기존 예약과 기록은 유지합니다.';
  $('universe-metric-help').hidden=false;trigger?.setAttribute('aria-expanded','true');
  $('universe-metric-help').focus?.({preventScroll:true});
  $('universe-metric-help').scrollIntoView?.({behavior:'smooth',block:'start'});
}
$('universe-candidates').addEventListener('click',event=>{const trigger=event.target.closest('[data-metric-help]');if(trigger)openUniverseMetricHelp(trigger.dataset.metricHelp,trigger);});
$('universe-metric-help-close').onclick=closeUniverseMetricHelp;
for(const id of ['universe-candidates','universe-metric-help'])$(id).addEventListener('keydown',event=>{if(event.key==='Escape')closeUniverseMetricHelp();});
function showUniverseJob(percent,message){
  $('universe-job-panel').hidden=false;
  $('universe-job-status').textContent=message;
  $('universe-job-progress').value=percent;
}
function setUniverseWorking(active,message){
  universeWorking=active;
  for(const id of ['universe-scan','universe-start','universe-settle'])$(id).disabled=active;
  $('universe-start').textContent=active?'분석·예약 중…':'가상 투자 시작';
  if(message){$('universe-action-status').textContent=message;showUniverseJob(0,message);}
}
function universeExecutionStatus(p){
  const pending=Object.values(p?.pending??{});
  if(pending.length)return '매수 예약 '+pending.length+'종목 · '+pending.map(v=>v.execution_day).sort()[0]+' 종가에 가상 매수합니다. 체결 전에는 현금과 보유 종목이 그대로입니다.';
  if(!p?.enabled)return '신규 매수 중지 상태입니다. 가상 투자 시작을 누르면 분석 후 다음 거래일 종가 매수를 예약합니다.';
  const held=Object.keys(p.positions??{}).length;
  return held?'자동 실행 중 · '+held+'종목 보유 · 매일 종가 손절·익절·만기 정산합니다.':'자동 실행 켜짐 · 현재 매수 예약 없음 · 분석 완료 후 조건을 통과한 종목을 예약합니다.';
}
const universeCostKeys=['buy_fee_pct','sell_fee_pct','sell_tax_pct','slippage_pct'];
let universeHoldingMode='calendar_days';
function universeConfig(){return {capital:Number($('universe-capital').value),criterion:$('universe-criterion').value,holding_mode:universeHoldingMode,...Object.fromEntries(universeCostKeys.map(k=>[k,Number($('universe-'+k).value)]))};}
function updateUniverseBudget(){$('universe-budget').textContent='종목당 예산 '+number(Number($('universe-capital').value)/100)+'원 · 총자금의 1/100 · 정수 주식 · 미투자금은 현금 유지';}
function renderUniversePaper(p){
  universeHoldingMode=p.config.holding_mode??'calendar_days';
  $('universe-cycle-schedule').textContent=(p.next_scan_day?'다음 차수 재계산: '+p.next_scan_day+' 종가 확인 후 · 다음 거래일 종가 매수':'시작 후 매주 한 차수씩 선정합니다.')+' · '+(universeHoldingMode==='calendar_days'?'매수 후 14일 이내 만기, 휴장일이면 직전 거래일':'매수 후 10거래일 만기')+' · 보유·예약 중인 종목은 다음 차수에서 제외';
  table('universe-cycles',['차수','선정일','매수 예정일','만기 예정일','최초 예약','중복 제외','현재 예약','보유','매도 완료','미체결 종료','확정 손익 (원)','상태'],(p.cycle_summary??[]).map(c=>[
    c.id+'차',c.signal_date,c.execution_day,c.expiry_date,c.reserved_count,c.skipped_duplicate_count,c.pending,c.held,c.sold,c.cancelled??0,number(c.realized_profit),c.status
  ]));
  if(!universeLoaded){$('universe-capital').value=p.config.capital;$('universe-criterion').value=p.config.criterion;universeCostKeys.forEach(k=>$('universe-'+k).value=p.config[k]);universeLoaded=true;updateUniverseBudget();}
  $('universe-capital').disabled=Object.keys(p.positions).length>0||p.trades.length>0;
  cards('universe-cards',[['신규 매수',p.enabled?'자동 실행':'중지'],['종목당 예산',number(p.budget)+'원'],['현금',number(p.cash)+'원'],['평가액 / 수익률',number(p.mark_equity)+'원 / '+performancePct(p.return_pct)]]);
  $('universe-message').textContent=p.message;
  if(!universeWorking)$('universe-action-status').textContent=universeExecutionStatus(p);
  const criterion=p.scan?.criterion??p.config.criterion;
  universeLegacySignal=criterion==='precision'&&!!p.scan&&p.scan.signal_threshold==null;
  universeScoreLabel=criterion==='precision'?'과거 적중률':'보정 예측 확률';
  $('universe-score-note').textContent=criterion==='precision'?'최근 5년 원본 5구간 검증의 평균 적중률 ≥60%이고 최신 상승 신호가 1이면 매수 후보입니다. 이번 예측 확률이 아닙니다.':'최근 5년을 시간순 학습·확률 보정하고, 다음 10거래일 중 종가 +5% 도달의 보정 확률 ≥60%를 매수 후보로 선정합니다. 기존 분석의 과거 적중률과 다른 값입니다.';
  if(criterion==='precision')$('universe-score-note').textContent+=' 새 분석의 최신 신호 1은 모델 내부 확률 60% 이상일 때만 표시합니다.';
  if(universeLegacySignal)$('universe-score-note').textContent+=' 현재 표는 기존 50% 초과 기준 저장 결과입니다. 새 분석부터 60%를 적용하며 기존 예약은 유지합니다.';
  $('universe-scan-meta').textContent=p.scan?p.scan.as_of+' · '+p.scan.analyzed+'/100 분석 · 기준 통과 '+p.scan.eligible+' · 제외 '+p.scan.errors:'아직 분석하지 않았습니다.';
  table('universe-positions',['차수','종목','수량','매수일','매수 종가','최신 종가','가격일','만기 예정일','종가 수익률','손절 / 익절'],Object.values(p.positions).map(v=>[v.cycle_id?v.cycle_id+'차':'—',v.symbol.name+' · '+v.symbol.code,v.quantity,v.buy_date,number(v.entry_close),number(v.last_close),v.last_price_date,v.expiry_date??'—',performancePct((v.last_close/v.entry_close-1)*100),number(v.entry_close*.97)+' / '+number(v.entry_close*1.05)]));
  universeCandidates=p.candidates;
  renderUniverseCandidates();
  const activityStates={reserved:'매수 예약',held:'보유 중',sold:'매도 완료'};
  const price=v=>v==null?'—':number(v,2);
  const money=v=>v==null?'—':number(v,0);
  table('universe-pending',['차수','상태','종목','수량','매수일','매도일','평단가 (원)','현재가 (원)','가격 기준일','매도가 (원)','손익 금액 (원)','손익 %'],(p.activity??[]).map(v=>[
    v.cycle_id?v.cycle_id+'차':'—',activityStates[v.status]??v.status,v.symbol.name+' · '+v.symbol.code,v.quantity??'—',
    v.buy_date+(v.status==='reserved'?'\n(예정)':''),v.sell_date+(v.status==='sold'?'':'\n(만기 예정)'),
    price(v.average_price),price(v.current_price),v.price_date??'—',price(v.sell_price),money(v.profit),
    v.return_pct==null?'—':performancePct(v.return_pct)
  ]));
  const reasons={stop_loss:'손절',take_profit:'익절',expiry:'보유 기간 만기'};
  table('universe-trades',['차수','종목','매수일','매도일','수량','청산 사유','비용 차감 수익률','손익 (원)'],p.trades.slice(-100).reverse().map(v=>[v.cycle_id?v.cycle_id+'차':'—',v.symbol.name,v.buy_date,v.sell_date,v.quantity,reasons[v.reason]??v.reason,performancePct(v.net_return_pct),number(v.profit)]));
  $('universe-price-errors').textContent=p.errors.map(v=>v.name+': '+v.error).join(' / ');
  chart('universe-equity',p.equity);
}
async function refreshUniversePaper(){renderUniversePaper(await api('/api/universe-paper'));}
async function refreshPaper(){await Promise.all([refreshLegacyPaper(),refreshUniversePaper()]);}
$('universe-capital').oninput=updateUniverseBudget;
$('universe-filter').onchange=renderUniverseCandidates;
for(const [id,enable,path] of [['universe-scan',null,'scan'],['universe-start',true,'scan'],['universe-settle',null,'reconcile']])$(id).onclick=handle(async()=>{
  if(busy)throw new Error('진행 중인 작업이 끝난 뒤 실행하세요.');
  busy=true;setUniverseWorking(true,'설정을 저장하고 분석·예약 작업을 시작합니다.');
  try{
    const state=await api('/api/universe-paper');
    await api('/api/universe-paper/configure','POST',{config:universeConfig(),enabled:enable??state.enabled});
    await refreshUniversePaper();
    const job=await api('/api/universe-paper/'+path,'POST');
    await poll(job.id,refreshUniversePaper,{universe:true});
  }catch(e){$('universe-action-status').textContent='작업을 시작하지 못했습니다 · '+e.message;showUniverseJob(0,'작업을 시작하지 못했습니다 · '+e.message);throw e;}
  finally{busy=false;setUniverseWorking(false);}
});
$('universe-stop').onclick=handle(async()=>{const state=await api('/api/universe-paper');await api('/api/universe-paper/configure','POST',{config:state.config,enabled:false});await refreshUniversePaper();notice('신규 매수와 예약을 중지했습니다. 기존 보유는 종가 정산을 계속합니다.');});
$('paper-enable').onclick=handle(async()=>{if(!selected)throw new Error('분석 화면에서 종목을 먼저 선택하세요.');await api('/api/paper/configure','POST',{symbol:selected,settings:settings(),enabled:true});await refreshPaper();notice('자동 가상 매매 설정을 저장했습니다. 다음 신호 갱신을 실행하세요.');});
$('paper-disable').onclick=handle(async()=>{const p=await api('/api/paper');if(!p.symbol)return;await api('/api/paper/configure','POST',{symbol:p.symbol,settings:p.settings,enabled:false});await refreshPaper();});
for(const [button,path] of [['paper-prepare','prepare'],['paper-settle','reconcile']])$(button).onclick=handle(async()=>{const j=await api('/api/paper/'+path,'POST');await poll(j.id,refreshPaper);});
let portfolioSymbols=[],portfolioWorking=false;
function clearPortfolioResult(){
  $('portfolio-result').hidden=true;$('portfolio-empty').hidden=false;
  $('portfolio-status').textContent='선택한 종목과 투자금으로 비중을 계산하세요.';
}
function renderPortfolioSelection(){
  const parent=$('portfolio-selected');parent.replaceChildren();
  $('portfolio-count').textContent=portfolioSymbols.length+' / 10';
  if(!portfolioSymbols.length){parent.textContent='아직 담은 종목이 없습니다.';return;}
  parent.textContent='';
  portfolioSymbols.forEach(symbol=>{
    const row=document.createElement('div');row.className='portfolio-stock';
    const name=document.createElement('span');name.textContent=symbol.name+' · '+symbol.code+' · '+(symbol.market==='US'?'미국':'한국')+(symbol.industry?' · '+symbol.industry:'');name.title=symbolLabel(symbol);
    const remove=document.createElement('button');remove.type='button';remove.textContent='제거';remove.setAttribute('aria-label',symbol.name+' 제거');
    remove.onclick=()=>{if(portfolioWorking)return;portfolioSymbols=portfolioSymbols.filter(s=>s.code!==symbol.code||s.market!==symbol.market);clearPortfolioResult();renderPortfolioSelection();};
    row.append(name,remove);parent.append(row);
  });
}
function addPortfolioSymbol(symbol){
  if(portfolioWorking)return;
  if(portfolioSymbols.some(s=>s.code===symbol.code&&s.market===symbol.market)){notice('이미 포트폴리오에 담은 종목입니다.');return;}
  if(portfolioSymbols.length>=10)throw new Error('포트폴리오는 최대 10종목까지 담을 수 있습니다.');
  portfolioSymbols.push(symbol);$('portfolio-candidates').replaceChildren();clearPortfolioResult();renderPortfolioSelection();
}
async function searchPortfolio(){
  const query=$('portfolio-query').value.trim();
  if(!query)throw new Error('찾을 종목명 또는 코드를 입력하세요.');
  const sequence=++portfolioSearchSequence;
  const matches=(await api('/api/symbols?q='+encodeURIComponent(query))).candidates;
  if(sequence!==portfolioSearchSequence||query!==$('portfolio-query').value.trim())return;
  const parent=$('portfolio-candidates');parent.replaceChildren();
  if(!matches.length){parent.textContent='찾은 종목이 없습니다. 이름·코드로 검색하거나 목록을 갱신하세요.';return;}
  parent.textContent='';
  matches.forEach(symbol=>{const button=document.createElement('button');button.type='button';button.textContent=symbolLabel(symbol)+' 추가';button.onclick=handle(()=>addPortfolioSymbol(symbol));parent.append(button);});
}
function portfolioInputs(){return {symbols:portfolioSymbols.map(s=>({...s})),currency:'KRW',...Object.fromEntries(['capital','years','buy_fee_pct','slippage_pct','min_weight_pct','max_weight_pct'].map(key=>[key,Number($('portfolio-'+key).value)]))};}
function setPortfolioWorking(active,message){
  portfolioWorking=active;$('portfolio-fields').disabled=active;
  $('portfolio-run').textContent=active?'투자 비중 계산 중…':'종목별 투자 비중 계산 ↗';
  if(message)$('portfolio-status').textContent=message;
}
function renderPortfolio(result){
  const market=result.currency==='USD'?'US':'KR',unit=market==='US'?'USD':'원';
  $('portfolio-result').hidden=false;$('portfolio-empty').hidden=true;
  cards('portfolio-summary',[['전체 자금 · 과거 연환산 수익률',pct(result.annual_return)],['전체 자금 · 연환산 변동성',pct(result.annual_volatility)],['샤프 비율',number(result.sharpe,3)]]);
  const rows=result.allocations;
  const invested=rows.reduce((n,r)=>n+r.weight,0),cash=result.cash_weight??1-invested;
  $('portfolio-weight-total').textContent='목표 주식 '+pct(invested)+' + 현금 '+pct(cash)+' = 100%';
  $('portfolio-kelly').textContent=result.sizing?'풀 켈리 '+pct(result.sizing.full_fraction)+' → 하프 켈리 '+pct(result.sizing.half_fraction)+' 투자 · 확보 현금 '+money(result.reserve_cash,market)+' '+unit:'';
  $('portfolio-weight-bars').innerHTML=rows.map(r=>'<div class="weight"><span>'+esc(r.symbol.name)+'</span><b>'+pct(r.weight)+'</b><i style="width:'+r.weight*100+'%"></i></div>').join('')+'<div class="weight cash-weight"><span>현금</span><b>'+pct(cash)+'</b><i style="width:'+cash*100+'%"></i></div>';
  table('portfolio-allocation',['종목','목표 종목 간 비중','목표 전체 자금 비중','배정액 ('+unit+')','기준 종가 ('+unit+')','가상 매수 수량','매수 비용 포함 금액','매수 수수료'],rows.map(r=>[r.symbol.name+' · '+r.symbol.code,pct(r.mix_weight??r.weight),pct(r.weight),money(r.allocation,market),money(r.close,market),r.quantity+'주',money(r.purchase_cost,market),money(r.buy_fee,market)]));
  $('portfolio-cash').textContent='총 투자금 '+money(result.capital,market)+' '+unit+' · 매수 비용 포함 '+money(result.total_purchase_cost,market)+' '+unit+' · 최종 현금 '+money(result.remaining_cash,market)+' '+unit+' (매수 후 실제 현금 비중 '+pct(result.remaining_cash/result.capital)+'). 하프 켈리 확보 현금에 정수 수량 매수 후 남은 금액을 더한 값입니다.';
  const limits=result.constraints?' 종목 간 비중 '+pct(result.constraints.min_weight_pct/100)+'~'+pct(result.constraints.effective_max_weight_pct/100)+' 범위.':'';
  $('portfolio-meta').textContent=result.start+' ~ '+result.as_of+' · 공통 '+number(result.common_rows)+'거래일 · 비교 '+number(result.samples)+'조합 · 평가지표용 무위험수익률 '+pct(result.risk_free)+'. '+result.note+limits+(result.sizing?' '+result.sizing.note:'');
  if(result.exchange_rate)$('portfolio-meta').textContent+=' 원화 환산 기준: 1 USD = '+number(result.exchange_rate.rate,2)+'원 ('+result.exchange_rate.date+'). '+result.exchange_rate.note+'.';
  $('portfolio-warnings').replaceChildren();(result.warnings??[]).forEach(message=>{const li=document.createElement('li');li.textContent=message;$('portfolio-warnings').append(li);});
  $('portfolio-status').textContent='계산 완료 · 기준 종가 '+result.as_of+' · 목표 주식 '+pct(invested)+' / 현금 '+pct(cash);
}
function restorePortfolio(result){
  if(!result?.allocations)return;
  restorePortfolioInputs({symbols:result.symbols,...result.settings,currency:result.currency});
  if(result.portfolio_strategy!=='half-kelly-v1'){clearPortfolioResult();$('portfolio-status').textContent='기존 저장 결과에는 하프 켈리가 적용되지 않았습니다. 다시 계산하세요.';return;}
  renderPortfolio(result);
}
function restorePortfolioInputs(input){
  portfolioSymbols=input.symbols;
  $('portfolio-capital-label').textContent='총 투자금 (원)';
  for(const key of ['capital','years','buy_fee_pct','slippage_pct','min_weight_pct','max_weight_pct'])if(input[key]!==undefined)$('portfolio-'+key).value=input[key];
  const legacyDollar=input.currency==='USD'||(!input.currency&&input.symbols.every(s=>s.market==='US'));
  $('portfolio-currency-note').textContent=legacyDollar?'이전 달러 입력은 보존했습니다. 새 계산의 총 투자금은 원화로 입력하세요.':'미국 종목은 일별 환율을 반영해 원화로 계산합니다.';
  if(legacyDollar)$('portfolio-capital').value=100000000;
  $('portfolio-query').placeholder='삼성전자, 마이크론, 코덱스 200, GLD';
  renderPortfolioSelection();
}
$('portfolio-search').onclick=handle(searchPortfolio);
$('portfolio-query').addEventListener('input',()=>{portfolioSearchSequence++;$('portfolio-candidates').replaceChildren();});
$('portfolio-refresh-symbols').onclick=handle(async()=>{const response=await api('/api/symbols/refresh?market=ALL','POST');await poll(response.id,()=>notice('국내·미국 종목과 ETF 목록 갱신 완료. 다시 검색하세요.'));});
$('portfolio-query').onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();handle(searchPortfolio)();}};
for(const key of ['capital','years','buy_fee_pct','slippage_pct','min_weight_pct','max_weight_pct'])$('portfolio-'+key).addEventListener('input',clearPortfolioResult);
$('portfolio-form').onsubmit=handle(async()=>{
  if(busy)throw new Error('진행 중인 작업이 끝난 뒤 실행하세요.');
  if(portfolioSymbols.length<2)throw new Error('종목을 2개 이상 담아주세요.');
  clearPortfolioResult();busy=true;setPortfolioWorking(true,'선택한 종목의 가격을 조회하고 있습니다.');
  try{const job=await api('/api/portfolio','POST',portfolioInputs());await poll(job.id,renderPortfolio,{portfolio:true});}
  catch(e){$('portfolio-status').textContent='계산 실패 · '+e.message;throw e;}
  finally{busy=false;setPortfolioWorking(false);}
});
renderPortfolioSelection();
window.addEventListener('resize',()=>currentResult?drawResults(currentResult):chart('price-chart',[]));
async function finishSavedJob(kind,result){
  if(kind==='comparison-paper'){renderComparison(result);return;}
  if(kind==='universe-paper'){await refreshUniversePaper();return;}
  if(kind==='paper'){await refreshPaper();return;}
  if(kind==='portfolio'){restorePortfolio(result);return;}
  if(result?.latest_signal!==undefined||result?.latest_probability!==undefined)render(result);
  else notice('이전 작업이 완료되었습니다.');
}
setInterval(()=>{$('clock').textContent=new Date().toLocaleString('ko-KR',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit'})+' KST';},1000);
(async()=>{try{const s=await api('/api/settings');keys.forEach(k=>$(k).value=s[k]);$('feature_set').value=s.feature_set??'expanded';await search();const latest=await api('/api/latest');if(latest){choose(latest.symbol);render(latest);}else chart('price-chart',[]);await refreshPaper();await refreshComparison();restorePortfolio(await api('/api/portfolio/latest'));const jobs=await api('/api/jobs');const active=jobs.find(j=>['queued','running'].includes(j.status));if(active)poll(active.id,r=>finishSavedJob(active.kind,r),{comparison:active.kind==='comparison-paper',universe:active.kind==='universe-paper',portfolio:active.kind==='portfolio'});}catch(e){notice(e.message,true);}})();
