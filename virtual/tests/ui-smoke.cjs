// Real headless Chrome regression checks; no dependencies beyond Node 22+.
const {spawn} = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const base = process.argv[2] || 'http://127.0.0.1:8001';
const output = path.join(root, 'docs', 'verification', '2026-10-08');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  await fs.mkdir(output, {recursive:true});
  const profile = await fs.mkdtemp(path.join(output, 'chrome-'));
  const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
    '--headless=new', '--disable-gpu', '--in-process-gpu', '--no-first-run', '--no-default-browser-check', '--enable-logging=stderr',
    '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    '--user-data-dir='+profile, 'about:blank'
  ], {windowsHide:true, stdio:['ignore','ignore','pipe']});
  chrome.stderr.on('data',data=>require('node:fs').appendFileSync(path.join(output,'chrome-test.log'),data));
  let socket;
  try {
    let port;
    for (let i=0; i<100; i++) {
      try {port=(await fs.readFile(path.join(profile, 'DevToolsActivePort'),'utf8')).split('\n')[0]; break;}
      catch {await sleep(100);}
    }
    assert.ok(port, 'Chrome did not expose its test debugging port');
    const targets=await (await fetch('http://127.0.0.1:'+port+'/json/list')).json();
    socket = new WebSocket(targets.find(target=>target.type==='page').webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Chrome test socket did not open')),10000);
      socket.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});
      socket.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('Chrome test socket failed'));},{once:true});
    });
    let sequence=0;
    const pending=new Map(), errors=[];
    socket.addEventListener('message', event=>{
      const data=JSON.parse(event.data);
      if (data.method==='Runtime.exceptionThrown') errors.push(data.params.exceptionDetails.text);
      if (data.id && pending.has(data.id)) {
        const {resolve,reject,timer}=pending.get(data.id);pending.delete(data.id);clearTimeout(timer);
        data.error?reject(new Error(data.error.message)):resolve(data.result);
      }
    });
    const send=(method,params={})=>new Promise((resolve,reject)=>{
      const id=++sequence;
      const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Chrome test command timed out: '+method));},10000);
      pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));
    });
    const evaluate=async expression=>{
      const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
      if(r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);
      return r.result.value;
    };
    const wait=async expression=>{
      for(let i=0;i<1200;i++){if(await evaluate(expression))return;await sleep(100);}
      throw new Error('Timed out: '+expression);
    };
    await send('Runtime.enable');
    console.log('Headless Chrome test session ready');
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    await send('Page.navigate',{url:base});
    await wait("document.getElementById('selected-symbol')?.textContent.includes('005930')");
    assert.equal(await evaluate("document.querySelectorAll('nav button').length"),5);
    await evaluate("document.querySelector('[data-tab=portfolio]').click()");
    await evaluate("document.getElementById('kelly-run').click()");
    await wait("document.getElementById('kelly-result').textContent.includes('40%')");
    assert.equal(await evaluate("!!document.getElementById('kelly2-run')"),true,'Kelly2 tool is missing from the screen');
    await evaluate("document.getElementById('kelly2-run').click()");
    await wait("document.getElementById('kelly2-result').textContent.includes('4,000%')");
    await evaluate("document.querySelector('[data-tab=analyze]').click();document.getElementById('query').value='애플';document.getElementById('search').click()");
    await wait("document.getElementById('selected-symbol').textContent.includes('AAPL')");
    assert.ok(await evaluate("document.getElementById('capital-label').textContent.includes('USD')"));
    await evaluate("document.getElementById('query').value='삼성';document.getElementById('search').click()");
    await wait("document.querySelectorAll('#candidates button').length>=5");
    await evaluate("document.getElementById('query').value='005930';document.getElementById('search').click()");
    await wait("document.getElementById('selected-symbol').textContent.includes('005930')");
    assert.ok(await evaluate("document.getElementById('capital-label').textContent.includes('원')"));
    await fs.writeFile(path.join(output,'desktop.png'),Buffer.from((await send('Page.captureScreenshot',{captureBeyondViewport:true})).data,'base64'));
    await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    for(const tab of ['analyze','validation','paper','portfolio','batch']) {
      await evaluate("document.querySelector('[data-tab="+tab+"]').click()");
      await sleep(200);
      assert.ok(await evaluate('document.documentElement.scrollWidth <= window.innerWidth+1'),tab+': page overflows mobile width');
    }
    await evaluate("document.querySelector('[data-tab=analyze]').click()");
    await fs.writeFile(path.join(output,'mobile.png'),Buffer.from((await send('Page.captureScreenshot',{captureBeyondViewport:true})).data,'base64'));
    if(process.argv.includes('--analysis')) {
      const csv=await fs.readFile(path.join(output,'synthetic-prices.csv'),'utf8');
      await evaluate("selected={code:'005930',name:'합성 검증 예제 (실제 종목 아님)',market:'KR'};document.getElementById('csv-text').value="+JSON.stringify(csv)+";document.getElementById('analysis-form').requestSubmit()");
      await wait("document.getElementById('probability').textContent.includes('%') && document.getElementById('job-panel').hidden");
      assert.ok(await evaluate("document.getElementById('result-name').textContent.includes('합성 검증 예제')"));
      assert.ok(await evaluate("document.querySelectorAll('#report-links a').length>=5"));
      await evaluate("document.querySelector('[data-tab=validation]').click()");
      assert.ok(await evaluate("document.querySelectorAll('#variant-table tbody tr').length>=14"));
      assert.equal(await evaluate("document.querySelectorAll('#simulation-table tbody tr').length"),3);
      await fs.writeFile(path.join(output,'synthetic-validation-mobile.png'),Buffer.from((await send('Page.captureScreenshot',{captureBeyondViewport:true})).data,'base64'));
    }
    assert.deepEqual(errors,[],'Browser raised an uncaught exception');
    const result={ok:true,base,desktop:'1440x1000',mobile:'390x844',tabs:5,synthetic_analysis:process.argv.includes('--analysis'),browser_errors:errors};
    await fs.writeFile(path.join(output,'ui-results.json'),JSON.stringify(result,null,2));
    console.log(JSON.stringify(result));
    await send('Browser.close');
  } finally {
    if(socket)socket.close();
    chrome.kill();
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
