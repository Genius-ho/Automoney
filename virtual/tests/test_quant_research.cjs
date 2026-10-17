const {test}=require('node:test');
const assert=require('node:assert/strict');
const {treasuryStats,filterFactors}=require('../static/quant-research.js');

test('Treasury frequencies use complete years, ties policy, and basis points',()=>{
  const rows=[
    {year:2000,peak_month:10,oct_end:5,dec_end:4,jan_end:3},
    {year:2001,peak_month:1,oct_end:3,dec_end:3,jan_end:4},
    {year:2002,peak_month:12,oct_end:4,dec_end:5,jan_end:3}
  ];
  const r=treasuryStats(rows,2000,2002);
  assert.equal(r.n,3);assert.equal(r.octoberPeaks,1);assert.equal(r.nonRising,2);
  assert.equal(r.riseThenFall,1);assert.equal(r.meanChangeBp,0);
  assert.deepEqual(r.histogram,[1,0,0,0,0,0,0,0,0,1,0,1]);
  const sub=treasuryStats(rows,2001,2002);
  assert.equal(sub.n,2);assert.equal(sub.nonRising,1);assert.equal(sub.meanChangeBp,50);
  assert.throws(()=>treasuryStats(rows,2002,2000),/기간/);
  assert.throws(()=>treasuryStats(rows,2010,2011),/자료/);
});

test('Research filtering combines market, evidence and Korean/English search',()=>{
  const factors=[{id:'pmi',title:'PMI와 코스피',category:'growth',markets:['KR'],evidence:'hypothesis',summary:'경기 확장',tags:['ISM']},
    {id:'cycle',title:'대통령 3년차',category:'calendar',markets:['US'],evidence:'study',summary:'선거 주기',tags:[]}];
  assert.deepEqual(filterFactors(factors,{query:'pMi',market:'KR'}).map(x=>x.id),['pmi']);
  assert.deepEqual(filterFactors(factors,{query:'ism',category:'growth',evidence:'hypothesis'}).map(x=>x.id),['pmi']);
  assert.equal(filterFactors(factors,{query:'PMI',market:'US'}).length,0);
});

const QH=require('../static/quant-history.js');
function synthetic(months,fill){
  const keys=['tr','rtr','cpi','cape','dy','gs10','tb3','baa_aaa','unrate','ff','vix','rec'];
  const series=Object.fromEntries(keys.map(k=>[k,Array(months).fill(null)]));
  fill(series);return {version:1,series};
}

test('Forward returns enter at month-end for tr and next month for monthly-average rtr',()=>{
  const d=synthetic(24,s=>{for(let i=0;i<24;i++){s.tr[i]=100*(1+i/10);s.rtr[i]=100+i;s.cpi[i]=100;}});
  assert.ok(Math.abs(QH.forward(d.series,QH.STUDIES['us-trend'],0,1,false)-.1)<1e-12);
  // rtr: signal 0 -> enter month 1 (101), exit month 13 (113)
  const study={...QH.STUDIES['us-cape'],annualize:false};
  assert.ok(Math.abs(QH.forward(d.series,study,0,12,true)-(113/101-1))<1e-12);
  assert.equal(QH.forward(d.series,QH.STUDIES['us-trend'],23,1,false),null);
});

test('Real returns deflate tr by CPI over the same window',()=>{
  const d=synthetic(3,s=>{s.tr=[100,110,121];s.cpi=[100,105,110];});
  const r=QH.forward(d.series,QH.STUDIES['us-inflation'],0,1,true);
  assert.ok(Math.abs(r-(1.1*100/105-1))<1e-12);
});

test('Study buckets use lower-inclusive edges, year range and month filters',()=>{
  // 1871-01 .. 1874-12 ; vix values drive buckets [15,20,25,30]
  const d=synthetic(48,s=>{for(let i=0;i<48;i++){s.tr[i]=100+i;s.vix[i]=i%2?15:14.99;}});
  const vix={...QH.STUDIES['us-vix'],start:1871};
  QH.STUDIES['__vix']=vix;
  try{
    const r=QH.studyStats(d,'__vix',{start:1871,end:1874,h:1});
    assert.equal(r.buckets[0].n+r.buckets[1].n,47);
    assert.equal(r.buckets[0].n,24);assert.equal(r.buckets[1].n,23);
    assert.equal(r.current.bucket,1);
    assert.throws(()=>QH.studyStats(d,'__vix',{start:1874,end:1871,h:1}),/연도/);
    assert.throws(()=>QH.studyStats(d,'__vix',{start:1871,end:1874,h:7}),/관찰 기간/);
    const pres={...QH.STUDIES['us-president'],start:1871};QH.STUDIES['__pres']=pres;
    const p=QH.studyStats(d,'__pres',{start:1871,end:1874,h:12});
    // December signals 1871..1873 have a following complete year; 1873 -> 1874 = 4th (election) year
    assert.equal(p.baseline.n,3);assert.equal(p.buckets[3].n,1);assert.equal(p.buckets[0].n,1);
    assert.equal(p.baseline.independent,3);
  }finally{delete QH.STUDIES['__vix'];delete QH.STUDIES['__pres'];}
});

test('Every computed history factor references a study and the shipped data covers it',()=>{
  const data=require('../static/quant-research-data.json');
  const history=require('../static/quant-us-history.json');
  const linked=data.factors.filter(f=>f.study);
  assert.equal(linked.length,Object.keys(QH.STUDIES).length);
  for(const f of linked){
    assert.equal(f.evidence,'computed');
    for(const s of f.sources)assert.ok(data.sources[s],f.id+' source '+s);
    const r=QH.studyStats(history,f.study);
    assert.ok(r.baseline.n>50,f.id);
    assert.ok(r.buckets.every(b=>b.n===0||Number.isFinite(b.mean)));
  }
  // Long-run S&P 500 total return sanity: ~9-11%/yr nominal since 1928
  const tr=history.series.tr.filter(v=>v!==null);
  const cagr=Math.pow(tr.at(-1)/tr[0],12/(tr.length-1))-1;
  assert.ok(cagr>.09&&cagr<.11,String(cagr));
});
