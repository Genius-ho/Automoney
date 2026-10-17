/* Dated research notes. No model, trading, or ledger endpoints are called here. */
(function(root){
  'use strict';
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const format=(n,d=1)=>Number(n).toLocaleString('ko-KR',{maximumFractionDigits:d});
  const marketNames={KR:'한국',US:'미국',GLOBAL:'글로벌'};

  function treasuryStats(rows,start,end){
    if(!Number.isInteger(start)||!Number.isInteger(end)||start>end)throw new Error('시작·종료 연도를 확인하세요. 조회 기간이 올바르지 않습니다.');
    const selected=rows.filter(r=>r.year>=start&&r.year<=end);
    if(!selected.length)throw new Error('선택한 기간에 완료된 연도 자료가 없습니다.');
    const histogram=Array(12).fill(0);
    let nonRising=0,riseThenFall=0,change=0;
    for(const r of selected){
      histogram[r.peak_month-1]++;
      if(r.dec_end<=r.oct_end){nonRising++;if(r.oct_end>r.jan_end)riseThenFall++;}
      change+=(r.dec_end-r.oct_end)*100;
    }
    return {n:selected.length,octoberPeaks:histogram[9],nonRising,riseThenFall,
      meanChangeBp:change/selected.length,histogram,years:selected};
  }

  function filterFactors(factors,filters={}){
    const query=String(filters.query||'').trim().toLocaleLowerCase().replace(/\s+/g,'');
    return factors.filter(f=>{
      const text=[f.title,f.summary,f.condition||'',...(f.tags||[])].join(' ').toLocaleLowerCase().replace(/\s+/g,'');
      return (!query||text.includes(query))&&(!filters.category||filters.category==='all'||f.category===filters.category)&&
        (!filters.market||filters.market==='all'||f.markets.includes(filters.market))&&
        (!filters.evidence||filters.evidence==='all'||f.evidence===filters.evidence);
    });
  }
  const exported={treasuryStats,filterFactors};
  if(typeof module!=='undefined'&&module.exports)module.exports=exported;
  if(typeof document==='undefined')return;
  root.QuantResearch=exported;

  const get=id=>document.getElementById(id);
  const DEFAULT='us-cape';
  let data=null,selected=DEFAULT,loading=false;
  const metric=m=>'<div class="quant-metric"><small>'+escape(m.label)+'</small><strong>'+escape(m.value)+'</strong><span>'+escape(m.note)+'</span></div>';
  const badge=f=>'<span class="quant-badge '+escape(f.evidence)+'">'+escape(data.evidence_labels[f.evidence])+'</span>';
  function sourceLink(id){
    const s=data.sources[id];
    if(!s||!/^https:\/\//i.test(s.url))return '';
    return '<a href="'+escape(s.url)+'" target="_blank" rel="noopener noreferrer">'+escape(s.title)+' ↗</a>';
  }

  function renderList(){
    if(!data)return;
    const factors=filterFactors(data.factors,{query:get('quant-search').value,category:get('quant-category').value,
      market:get('quant-market').value,evidence:get('quant-evidence').value});
    if(!factors.some(f=>f.id===selected))selected=factors[0]?.id||null;
    get('quant-count').textContent=factors.length+' / '+data.factors.length+'개 요소';
    get('quant-list').innerHTML=factors.length?factors.map(f=>'<button type="button" class="quant-item'+(f.id===selected?' selected':'')+'" data-factor="'+escape(f.id)+'" aria-pressed="'+(f.id===selected)+'"><span class="quant-item-title">'+escape(f.title)+'</span><span class="quant-item-meta">'+escape(data.categories[f.category])+' · '+escape(f.markets.map(m=>marketNames[m]).join('·'))+'</span>'+badge(f)+'</button>').join(''):'<p class="quant-empty">일치하는 요소가 없습니다. 검색어나 필터를 바꿔보세요.</p>';
    document.querySelectorAll('#quant-list [data-factor]').forEach(b=>b.addEventListener('click',()=>{selected=b.dataset.factor;renderList();}));
    renderDetail();
  }

  function select(id){
    get('quant-search').value='';
    ['quant-category','quant-market','quant-evidence'].forEach(id=>get(id).value='all');
    selected=id;renderList();
  }

  function renderDetail(){
    const f=data.factors.find(f=>f.id===selected);
    if(!f){get('quant-detail').innerHTML='<div class="quant-empty"><h2>검색 결과가 없습니다</h2><p>전체 요소로 돌아가거나 다른 검색어를 입력하세요.</p></div>';return;}
    get('quant-detail').innerHTML='<div class="quant-detail-top"><span>'+escape(data.categories[f.category])+' / '+escape(f.markets.map(m=>marketNames[m]).join(' · '))+'</span>'+badge(f)+'</div><h2>'+escape(f.title)+'</h2><p class="quant-lead">'+escape(f.summary)+'</p>'+
      '<div class="quant-metrics">'+f.metrics.map(metric).join('')+'</div>'+
      (f.id==='treasury-october'?treasuryPanel():'')+
      (f.study&&root.QuantHistory?root.QuantHistory.panel(f.study):'')+
      '<div class="quant-info"><div><h3>어떤 조건을 보나요?</h3><p>'+escape(f.condition)+'</p></div><div><h3>관찰 기간</h3><p>'+escape(f.horizon)+'</p></div></div>'+
      '<div class="quant-evidence-note"><h3>통계의 범위와 표본</h3><p>'+escape(f.period)+'</p><p>'+escape(f.sample)+'</p></div>'+
      '<div class="quant-limits"><h3>함께 확인할 한계</h3><ul>'+f.limitations.map(v=>'<li>'+escape(v)+'</li>').join('')+'</ul></div>'+
      '<details class="quant-method"><summary>검증 방법 보기</summary><p>'+escape(f.test)+'</p><p>검증을 추가할 때는 상승 사례 수 / 전체 사례 수, 무조건 보유의 기준 성적, 평균·중앙값 수익, 낙폭을 함께 확인합니다. 발표일 당시 자료로 계산하고 최근 기간을 분리합니다.</p></details>'+
      '<div class="quant-sources"><h3>근거 자료</h3>'+f.sources.map(sourceLink).join('')+'</div>';
    if(f.id==='treasury-october'){
      get('quant-range-form').addEventListener('submit',e=>{e.preventDefault();renderTreasury();});
      renderTreasury();
    }
    if(f.study&&root.QuantHistory)root.QuantHistory.mount(f.study);
    document.querySelectorAll('#quant-quick [data-factor]').forEach(b=>b.classList.toggle('selected',b.dataset.factor===selected));
  }

  function treasuryPanel(){
    return '<section class="quant-lab" aria-label="국채금리 가설 직접 검증"><div class="quant-lab-heading"><h3>기간을 바꿔 직접 확인</h3><span>완료 연도 · DGS10</span></div><form id="quant-range-form"><label>시작 연도<input type="number" id="quant-start" value="1962" min="1962" max="2025" step="1" required></label><label>종료 연도<input type="number" id="quant-end" value="2025" min="1962" max="2025" step="1" required></label><button type="submit" class="primary">다시 계산</button></form><p id="quant-range-error" class="quant-error" role="alert" hidden></p><div id="quant-range-results" aria-live="polite"></div></section>';
  }

  function renderTreasury(){
    const error=get('quant-range-error');error.hidden=true;
    try{
      const start=Number(get('quant-start').value),end=Number(get('quant-end').value);
      if(start<1962||end>2025)throw new Error('자료 범위는 1962~2025년입니다.');
      const r=treasuryStats(data.treasury.years,start,end);
      const rate=n=>format(n/r.n*100,2)+'%';
      const max=Math.max(...r.histogram,1);
      get('quant-range-results').innerHTML='<div class="quant-lab-stats">'+
        metric({label:'10월 연중 고점',value:r.octoberPeaks+' / '+r.n+'년',note:rate(r.octoberPeaks)+' · 최초 고점 날짜 기준'})+
        metric({label:'10→12월 금리 비상승',value:r.nonRising+' / '+r.n+'년',note:rate(r.nonRising)+' · 12월 말 ≤ 10월 말'})+
        metric({label:'10→12월 평균 변화',value:(r.meanChangeBp>0?'+':'')+format(r.meanChangeBp,1)+'bp',note:'1bp = 금리 0.01%p'})+'</div>'+
        '<h4>연중 최고 금리가 처음 나온 달</h4><div class="quant-histogram" role="img" aria-label="'+escape(r.histogram.map((v,i)=>(i+1)+'월 '+v+'년').join(', '))+'">'+r.histogram.map((v,i)=>'<div class="quant-bar'+(i===9?' october':'')+'" title="'+(i+1)+'월: '+v+' / '+r.n+'년"><span>'+v+'</span><i style="height:'+Math.max(v/max*82,1)+'px"></i><small>'+(i+1)+'월</small></div>').join('')+'</div>'+
        '<p class="quant-footnote">집계 '+r.years[0].year+'~'+r.years.at(-1).year+'년, '+r.n+'개 연도. 1월 말보다 10월 말 금리가 높고 이후 연말에 같거나 낮았던 경우: '+r.riseThenFall+'/'+r.n+'년 ('+rate(r.riseThenFall)+'). 월마다 계속 상승했는지를 뜻하지 않습니다.</p>'+
        '<p class="quant-footnote">연중 고점은 사후에 확인하는 통계입니다. 동일 최고치가 여러 달이면 최초 날짜로 집계합니다. 각 연도의 경제·금리 국면은 독립적이지 않아 이 빈도를 다음 해 확률로 사용할 수 없습니다.</p>'+
        '<details><summary>연도별 계산값 확인</summary><div class="quant-year-table"><table><thead><tr><th>연도</th><th>최초 고점일</th><th>고점 금리</th><th>10월 말</th><th>12월 말</th><th>변화(bp)</th></tr></thead><tbody>'+[...r.years].reverse().map(y=>'<tr><td>'+y.year+'</td><td>'+escape(y.first_peak_date)+'</td><td>'+format(y.peak_yield,2)+'%</td><td>'+format(y.oct_end,2)+'%</td><td>'+format(y.dec_end,2)+'%</td><td>'+format((y.dec_end-y.oct_end)*100,1)+'</td></tr>').join('')+'</tbody></table></div></details>';
    }catch(e){error.textContent=e.message;error.hidden=false;get('quant-range-results').innerHTML='';}
  }

  async function load(){
    if(data||loading)return;
    loading=true;get('quant-load-status').hidden=false;get('quant-load-status').textContent='조사 자료를 불러오는 중입니다…';get('quant-retry').hidden=true;
    try{
      const response=await fetch('/static/quant-research-data.json?v=20261012-us-history-01');
      if(!response.ok)throw new Error('조사 자료를 불러오지 못했습니다.');
      const result=await response.json();
      if(result.version!==1||!Array.isArray(result.factors)||!result.treasury?.years?.length)throw new Error('조사 자료 형식을 확인할 수 없습니다.');
      data=result;
      get('quant-reviewed').textContent='자료 확인 '+data.reviewed_at;
      get('quant-factor-total').textContent=data.factors.length+'개 요소, 근거부터 살펴보기';
      get('quant-category').innerHTML='<option value="all">모든 분야</option>'+Object.entries(data.categories).map(([k,v])=>'<option value="'+escape(k)+'">'+escape(v)+'</option>').join('');
      get('quant-workspace').hidden=false;get('quant-load-status').hidden=true;
      renderList();
    }catch(e){get('quant-load-status').textContent=e.message;get('quant-retry').hidden=false;}
    finally{loading=false;}
  }
  function initialize(){
    if(!get('quant'))return;
    document.querySelector('nav [data-tab="quant"]').addEventListener('click',load);
    ['quant-search','quant-category','quant-market','quant-evidence'].forEach(id=>get(id).addEventListener(id==='quant-search'?'input':'change',renderList));
    get('quant-reset').addEventListener('click',()=>select(DEFAULT));
    get('quant-retry').addEventListener('click',load);
    document.querySelectorAll('#quant-quick [data-factor]').forEach(b=>b.addEventListener('click',async()=>{await load();if(data)select(b.dataset.factor);}));
    if(root.location?.hash==='#quant'){if(typeof root.activate==='function')root.activate('quant');load();}
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',initialize);else initialize();
})(typeof window!=='undefined'?window:globalThis);
