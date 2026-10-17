/* US long-history conditional return studies. Pure computation is exported for tests. */
(function(root){
  'use strict';
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt=(n,d=1)=>Number(n).toLocaleString('ko-KR',{minimumFractionDigits:d,maximumFractionDigits:d});
  const pct=(n,d=1)=>(n>0?'+':'')+fmt(n*100,d)+'%';
  const START_YEAR=1871;
  const yearOf=i=>START_YEAR+Math.floor(i/12);
  const monthOf=i=>i%12+1;
  const num=v=>typeof v==='number'&&Number.isFinite(v);
  const bins=(edges,unit)=>{
    const out=[];
    for(let k=0;k<=edges.length;k++){
      const lo=k?edges[k-1]:null,hi=k<edges.length?edges[k]:null;
      out.push({lo,hi,label:lo===null?hi+unit+' 미만':hi===null?lo+unit+' 이상':lo+'~'+hi+unit});
    }
    return out;
  };
  const cats=labels=>labels.map((label,key)=>({key,label}));
  const change=(s,i,lag)=>num(s[i])&&num(s[i-lag])?s[i]-s[i-lag]:null;
  const ret=(S,i,lag)=>num(S.tr[i])&&num(S.tr[i-lag])?S.tr[i]/S.tr[i-lag]-1:null;

  /* series:'tr' enters at the signal month-end; 'rtr' (monthly averages) enters next month. */
  const STUDIES={
    'us-cape':{series:'rtr',real:true,annualize:true,h:120,horizons:[12,36,60,120],start:1881,
      variable:'CAPE(경기조정 PER, 3개월 지연)',value:(S,i)=>S.cape[i],bins:bins([10,15,20,25,30],'배')},
    'us-dividend-yield':{series:'rtr',real:true,annualize:true,h:120,horizons:[12,36,60,120],start:1872,
      variable:'배당수익률(3개월 지연)',value:(S,i)=>S.dy[i],bins:bins([2,3,4,5,6],'%')},
    'us-seasonality':{series:'tr',h:1,horizons:[1],start:1928,variable:'수익이 발생한 달',
      category:(S,i)=>monthOf(i+1)-1,categories:cats(Array.from({length:12},(_,m)=>(m+1)+'월'))},
    'us-president':{series:'tr',h:12,horizons:[12],start:1928,step:12,variable:'대통령 임기 연차',
      filter:i=>monthOf(i)===12,category:(S,i)=>(yearOf(i)+1+3)%4,
      categories:cats(['1년차 · 취임','2년차 · 중간선거','3년차','4년차 · 대선'])},
    'us-january':{series:'tr',h:11,horizons:[11],start:1928,step:12,variable:'1월 수익률의 방향',
      filter:i=>monthOf(i)===1,category:(S,i)=>{const r=ret(S,i,1);return r===null?null:r>=0?0:1;},
      categories:cats(['1월 상승','1월 하락'])},
    'us-trend':{series:'tr',h:1,horizons:[1,3,6,12],start:1929,variable:'월말 지수와 10개월 평균',
      category:(S,i)=>{
        if(i<9)return null;let sum=0;
        for(let k=i-9;k<=i;k++){if(!num(S.tr[k]))return null;sum+=S.tr[k];}
        return S.tr[i]>=sum/10?0:1;},
      categories:cats(['10개월 평균 위','10개월 평균 아래'])},
    'us-momentum':{series:'tr',h:12,horizons:[1,3,12],start:1929,variable:'직전 12개월 총수익률',
      value:(S,i)=>{const r=ret(S,i,12);return r===null?null:r*100;},bins:bins([-20,-10,0,10,20],'%')},
    'us-drawdown':{series:'tr',h:12,horizons:[3,12,36],start:1928,variable:'직전 고점 대비 하락폭',
      value:(S,i)=>{
        if(!num(S.tr[i]))return null;let peak=0;
        for(let k=0;k<=i;k++)if(num(S.tr[k])&&S.tr[k]>peak)peak=S.tr[k];
        return (1-S.tr[i]/peak)*100;},bins:bins([5,10,20,30],'%')},
    'us-yield-curve':{series:'tr',h:12,horizons:[6,12,24],start:1934,variable:'10년 국채 − 3개월 국채(%p)',
      value:(S,i)=>num(S.gs10[i])&&num(S.tb3[i])?S.gs10[i]-S.tb3[i]:null,bins:bins([0,1,2],'%p')},
    'us-credit-spread':{series:'tr',h:12,horizons:[3,12,24],start:1928,variable:'BAA − AAA 회사채 금리차(%p)',
      value:(S,i)=>S.baa_aaa[i],bins:bins([.75,1,1.5,2.5],'%p')},
    'us-inflation':{series:'tr',real:true,h:12,horizons:[12,36],start:1928,variable:'소비자물가 전년비(1개월 지연)',
      value:(S,i)=>num(S.cpi[i-1])&&num(S.cpi[i-13])?(S.cpi[i-1]/S.cpi[i-13]-1)*100:null,bins:bins([0,2,4,6],'%')},
    'us-rate-change':{series:'tr',h:12,horizons:[3,12,24],start:1928,variable:'10년 국채금리 12개월 변화(%p)',
      value:(S,i)=>change(S.gs10,i,12),bins:bins([-1,-.25,.25,1],'%p')},
    'us-fed-direction':{series:'tr',h:12,horizons:[3,12,24],start:1955,variable:'기준금리(FEDFUNDS) 6개월 변화(%p)',
      value:(S,i)=>change(S.ff,i,6),bins:bins([-1,-.25,.25,1],'%p')},
    'us-vix':{series:'tr',h:12,horizons:[1,3,12],start:1990,variable:'VIX 월평균',
      value:(S,i)=>S.vix[i],bins:bins([15,20,25,30],'')},
    'us-unemployment':{series:'tr',h:12,horizons:[3,12,24],start:1949,variable:'실업률 − 직전 12개월 최저(%p, 1개월 지연)',
      value:(S,i)=>{
        if(!num(S.unrate[i]))return null;let low=Infinity;
        for(let k=i-12;k<i;k++){if(!num(S.unrate[k]))return null;low=Math.min(low,S.unrate[k]);}
        return S.unrate[i]-low;},bins:bins([.3,.5,1],'%p')},
    'us-recession':{series:'tr',h:12,horizons:[3,12,24],start:1928,variable:'NBER 경기침체 여부(사후 판정)',
      category:(S,i)=>num(S.rec[i])?(S.rec[i]?1:0):null,categories:cats(['비침체','침체 기간'])}
  };

  function forward(S,study,i,h,real){
    const off=study.series==='rtr'?1:0,s=S[study.series];
    const a=s[i+off],b=s[i+off+h];
    if(!num(a)||!num(b))return null;
    let r=b/a;
    if(real&&study.series==='tr'){
      const c0=S.cpi[i+off],c1=S.cpi[i+off+h];
      if(!num(c0)||!num(c1))return null;
      r*=c0/c1;
    }
    return study.annualize?Math.pow(r,12/h)-1:r-1;
  }

  function bucketOf(study,S,i){
    if(study.category){const c=study.category(S,i);return c===null||c===undefined?null:c;}
    const v=study.value(S,i);
    if(!num(v))return null;
    return study.bins.findIndex(b=>(b.lo===null||v>=b.lo)&&(b.hi===null||v<b.hi));
  }

  function summarize(values,step,h){
    const n=values.length;
    if(!n)return {n:0};
    const sorted=[...values].sort((a,b)=>a-b);
    const mean=values.reduce((a,b)=>a+b,0)/n;
    const sd=n>1?Math.sqrt(values.reduce((a,b)=>a+(b-mean)**2,0)/(n-1)):0;
    const median=n%2?sorted[(n-1)/2]:(sorted[n/2-1]+sorted[n/2])/2;
    return {n,mean,median,sd,positive:values.filter(v=>v>0).length/n,min:sorted[0],max:sorted[n-1],
      independent:Math.max(1,Math.round(n*Math.min(1,step/h)))};
  }

  function studyStats(data,id,options={}){
    const study=STUDIES[id];
    if(!study)throw new Error('알 수 없는 연구 항목입니다.');
    const S=data.series,total=S.tr.length;
    const lastYear=yearOf(total-1);
    const start=options.start??study.start,end=options.end??lastYear;
    const h=options.h??study.h;
    const real=study.series==='rtr'?true:options.real??!!study.real;
    if(!Number.isInteger(start)||!Number.isInteger(end)||start>end)throw new Error('시작·종료 연도를 확인하세요.');
    if(start<study.start||end>lastYear)throw new Error('이 항목의 자료 범위는 '+study.start+'~'+lastYear+'년입니다.');
    if(!study.horizons.includes(h))throw new Error('지원하지 않는 관찰 기간입니다.');
    const groups=(study.categories||study.bins).map(()=>[]),all=[],pairs=[];
    let first=null,last=null;
    for(let i=0;i<total;i++){
      const y=yearOf(i);
      if(y<start||y>end||(study.filter&&!study.filter(i)))continue;
      const b=bucketOf(study,S,i);
      if(b===null||b<0)continue;
      const r=forward(S,study,i,h,real);
      if(r===null)continue;
      groups[b].push(r);all.push(r);
      if(study.value)pairs.push([study.value(S,i),r]);
      first=first??i;last=i;
    }
    if(!all.length)throw new Error('선택한 기간에 이후 수익까지 확인된 관측치가 없습니다.');
    const step=study.step||1;
    let current=null;
    for(let i=total-1;i>=0;i--){
      if(study.filter&&!study.filter(i))continue;
      const b=bucketOf(study,S,i);
      if(b!==null&&b>=0){current={index:i,date:yearOf(i)+'-'+String(monthOf(i)).padStart(2,'0'),bucket:b,
        value:study.value?study.value(S,i):null};break;}
    }
    let correlation=null;
    if(pairs.length>2){
      const mx=pairs.reduce((a,p)=>a+p[0],0)/pairs.length,my=pairs.reduce((a,p)=>a+p[1],0)/pairs.length;
      let sxy=0,sxx=0,syy=0;
      for(const [x,y] of pairs){sxy+=(x-mx)*(y-my);sxx+=(x-mx)**2;syy+=(y-my)**2;}
      correlation=sxx&&syy?sxy/Math.sqrt(sxx*syy):null;
    }
    return {id,h,real,annualized:!!study.annualize,start,end,
      firstSignal:yearOf(first)+'-'+String(monthOf(first)).padStart(2,'0'),
      lastSignal:yearOf(last)+'-'+String(monthOf(last)).padStart(2,'0'),
      baseline:summarize(all,step,h),correlation,current,
      buckets:(study.categories||study.bins).map((b,k)=>({label:b.label,...summarize(groups[k],step,h)}))};
  }

  const exported={STUDIES,studyStats,forward};
  if(typeof module!=='undefined'&&module.exports)module.exports=exported;
  if(typeof document==='undefined')return;

  let history=null,pending=null;
  const get=id=>document.getElementById(id);
  async function load(){
    if(history)return history;
    pending=pending||fetch('/static/quant-us-history.json?v=20261012-us-01').then(r=>{
      if(!r.ok)throw new Error('미국 장기 자료를 불러오지 못했습니다.');return r.json();}).then(d=>{
      if(d.version!==1||!Array.isArray(d.series?.tr))throw new Error('미국 장기 자료 형식을 확인할 수 없습니다.');
      history=d;return d;}).finally(()=>{pending=null;});
    return pending;
  }

  const horizonLabel=h=>h%12===0?(h/12)+'년':h+'개월';
  function panel(id){
    const s=STUDIES[id];
    const options=s.horizons.map(h=>'<option value="'+h+'"'+(h===s.h?' selected':'')+'>'+horizonLabel(h)+'</option>').join('');
    const realControl=s.series==='rtr'?'<label>수익 기준<select id="qh-real" disabled><option value="1">실질(물가 차감)</option></select></label>':
      '<label>수익 기준<select id="qh-real"><option value="0"'+(s.real?'':' selected')+'>명목 총수익</option><option value="1"'+(s.real?' selected':'')+'>실질(물가 차감)</option></select></label>';
    return '<section class="quant-lab qh-lab" aria-label="미국 장기 자료 직접 계산"><div class="quant-lab-heading"><h3>조건별 이후 수익 · 직접 계산</h3><span id="qh-source">S&amp;P 500 총수익 · 월별</span></div>'+
      '<form id="qh-form" class="qh-form"><label>시작 연도<input type="number" id="qh-start" value="'+s.start+'" min="'+s.start+'" step="1" required></label>'+
      '<label>종료 연도<input type="number" id="qh-end" step="1" required></label><label>이후 기간<select id="qh-h">'+options+'</select></label>'+realControl+
      '<button type="submit" class="primary">다시 계산</button></form><p id="qh-error" class="quant-error" role="alert" hidden></p><div id="qh-results" aria-live="polite"><p class="quant-footnote">자료를 계산하는 중입니다…</p></div></section>';
  }

  function chart(r,study){
    const values=r.buckets.filter(b=>b.n).map(b=>b.mean).concat([r.baseline.mean,0]);
    const lo=Math.min(...values),hi=Math.max(...values),span=hi-lo||1;
    const x=v=>((v-lo)/span*100).toFixed(2);
    const unit=r.annualized?'연율 ':'';
    const rows=r.buckets.map((b,k)=>{
      if(!b.n)return '<div class="qh-row empty"><span class="qh-label">'+escape(b.label)+'</span><span class="qh-track"></span><span class="qh-value">관측 없음</span></div>';
      const left=Math.min(x(0),x(b.mean)),width=Math.abs(x(b.mean)-x(0));
      const tip=b.label+' · 평균 '+pct(b.mean)+' · 중앙값 '+pct(b.median)+' · 상승 '+fmt(b.positive*100,0)+'% · 관측 '+b.n+'개';
      return '<div class="qh-row'+(r.current&&r.current.bucket===k?' current':'')+'" title="'+escape(tip)+'"><span class="qh-label">'+escape(b.label)+(r.current&&r.current.bucket===k?' <em>현재</em>':'')+'</span>'+
        '<span class="qh-track"><i class="qh-zero" style="left:'+x(0)+'%"></i><i class="qh-base" style="left:'+x(r.baseline.mean)+'%"></i><b class="'+(b.mean<0?'neg':'pos')+(b.n<20?' thin':'')+'" style="left:'+left+'%;width:'+Math.max(width,.6)+'%"></b></span>'+
        '<span class="qh-value">'+pct(b.mean)+'<small>n='+b.n+'</small></span></div>';
    }).join('');
    return '<h4>'+escape(study.variable)+'별 이후 '+horizonLabel(r.h)+' '+unit+(r.real?'실질':'명목')+' 평균 수익</h4><div class="qh-chart" role="img" aria-label="'+escape(r.buckets.map(b=>b.label+' '+(b.n?pct(b.mean):'관측 없음')).join(', '))+'">'+rows+
      '</div><p class="qh-legend"><span><i class="qh-key base"></i>전체 평균 '+pct(r.baseline.mean)+'</span><span><i class="qh-key thin"></i>관측 20개 미만 (흐리게)</span></p>';
  }

  function table(r){
    return '<details><summary>구간별 계산값 확인</summary><div class="quant-year-table"><table><thead><tr><th>구간</th><th>관측</th><th>겹치지 않는 환산</th><th>평균</th><th>중앙값</th><th>상승 비율</th><th>표준편차</th><th>최저</th><th>최고</th></tr></thead><tbody>'+
      [...r.buckets,{label:'전체',...r.baseline}].map(b=>'<tr><td>'+escape(b.label)+'</td><td>'+b.n+'</td>'+(b.n?'<td>약 '+b.independent+'</td><td>'+pct(b.mean)+'</td><td>'+pct(b.median)+'</td><td>'+fmt(b.positive*100,0)+'%</td><td>'+fmt(b.sd*100,1)+'%p</td><td>'+pct(b.min)+'</td><td>'+pct(b.max)+'</td>':'<td colspan="7">—</td>')+'</tr>').join('')+
      '</tbody></table></div></details>';
  }

  function render(id){
    const error=get('qh-error');error.hidden=true;
    try{
      const study=STUDIES[id];
      const opts={start:Number(get('qh-start').value),end:Number(get('qh-end').value),h:Number(get('qh-h').value),real:get('qh-real').value==='1'};
      const r=studyStats(history,id,opts);
      const cur=r.current,curBucket=cur?r.buckets[cur.bucket]:null;
      const best=r.buckets.filter(b=>b.n>=20).sort((a,b)=>b.mean-a.mean);
      const metric=(label,value,note)=>'<div class="quant-metric"><small>'+escape(label)+'</small><strong>'+escape(value)+'</strong><span>'+escape(note)+'</span></div>';
      get('qh-results').innerHTML='<div class="quant-lab-stats">'+
        metric('현재 위치',cur?curBucket.label:'—',cur?cur.date+' 기준'+(cur.value!==null&&num(cur.value)?' · 값 '+fmt(cur.value,2):''):'최근 값 없음')+
        metric('전체 평균',pct(r.baseline.mean),'상승 비율 '+fmt(r.baseline.positive*100,0)+'% · 관측 '+r.baseline.n+'개')+
        (r.correlation!==null?metric('상관계수',fmt(r.correlation,2),'값과 이후 수익의 선형 관계 · −1~1'):
          metric('구간 차이',best.length>1?pct(best[0].mean-best.at(-1).mean):'—','관측 20개 이상 구간의 최고−최저 평균'))+'</div>'+
        chart(r,study)+
        '<p class="quant-footnote">신호 '+r.firstSignal+'~'+r.lastSignal+' · 겹치지 않는 구간으로 환산하면 약 '+r.baseline.independent+'개 · '+
        (study.series==='rtr'?'실러 월평균 가격으로 계산해 다음 달 평균가에 진입합니다.':'월말 종가에 진입하고 배당을 재투자한 총수익입니다.')+
        ' 관찰 기간이 겹치는 월별 표본은 서로 독립이 아니므로 관측 수만큼 확실한 근거가 아닙니다.</p>'+table(r);
    }catch(e){error.textContent=e.message;error.hidden=false;get('qh-results').innerHTML='';}
  }

  async function mount(id){
    const results=get('qh-results');
    try{
      await load();
      if(!get('qh-form'))return;
      const end=yearOf(history.series.tr.length-1);
      get('qh-end').value=end;get('qh-end').max=end;get('qh-start').max=end;
      get('qh-form').addEventListener('submit',e=>{e.preventDefault();render(id);});
      ['qh-h','qh-real'].forEach(k=>get(k).addEventListener('change',()=>render(id)));
      render(id);
    }catch(e){if(results)results.innerHTML='<p class="quant-error">'+escape(e.message)+'</p>';}
  }
  root.QuantHistory={...exported,panel,mount,load};
})(typeof window!=='undefined'?window:globalThis);
