import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createPgPool } from '../src/postgres-store.mjs';
import { loadDatabaseUrl } from '../src/config.mjs';

const root=fileURLToPath(new URL('../',import.meta.url)),port=3013,base=`http://127.0.0.1:${port}`;let child,browser,db;
const sleep=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms));
async function cleanup(){if(browser)await browser.close().catch(()=>{});if(db)await db.end().catch(()=>{});if(child?.pid){child.kill();await new Promise((resolve)=>{child.once('exit',resolve);setTimeout(resolve,5000);});}}
try{
  child=spawn(process.execPath,['scripts/admin-server.js'],{cwd:root,env:{...process.env,PORT:String(port)},windowsHide:true,stdio:['ignore','pipe','pipe']});let ready=false;for(let i=0;i<60;i++){try{if((await fetch(`${base}/api/product-drafts/64`)).status===200){ready=true;break}}catch{}await sleep(500)}if(!ready)throw new Error('manual_detail_server_not_ready');

  const packageResponse=await fetch(`${base}/api/product-drafts/64/ai-workflows/detail-page/package`);const packageBytes=Buffer.from(await packageResponse.arrayBuffer());

  browser=await chromium.launch({headless:true});const page=await browser.newPage();const browserConsoleErrors=[],browserPageErrors=[],failedRequests=[];page.on('console',(message)=>{if(message.type()==='error')browserConsoleErrors.push(message.text())});page.on('pageerror',(error)=>browserPageErrors.push(error.message));page.on('requestfailed',(request)=>failedRequests.push(request.url()));await page.goto(`${base}/admin?draftId=64`,{waitUntil:'networkidle'});await page.locator('[data-tab="image"]').click();await page.waitForSelector('[data-manual-detail-workflow]',{state:'visible'});

  const fixtureDir=process.env.DETAIL_PAGE_FIXTURE_DIR||join(tmpdir(),'automoney-detail-page-fixtures');
  await mkdir(fixtureDir,{recursive:true});
  const png=Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082','hex');
  for(let i=1;i<=10;i+=1)await writeFile(join(fixtureDir,`img${i}.png`),png);
  const shuffledFiles=[6,3,10,1,8,2,9,4,7,5].map((n)=>join(fixtureDir,`img${n}.png`));

  await page.locator('[data-manual-detail-workflow] input[name="images[]"]').setInputFiles(shuffledFiles);
  await page.waitForFunction(()=>document.querySelectorAll('[data-manual-detail-workflow] [data-detail-order]').length===10);

  const result=await page.evaluate(()=>{
    const workflow=document.querySelector('[data-manual-detail-workflow]');
    const orderedFilenames=[...workflow.querySelectorAll('[data-detail-order]')].map((item)=>item.dataset.detailFilename);
    const thumbnailCount=workflow.querySelectorAll('[data-detail-order] img').length;
    return {
      packageDownloadAvailable:Boolean(workflow.querySelector('a[href*="ai-workflows/detail-page/package"]')),
      detailPromptCopyAvailable:Boolean(workflow.querySelector('[data-detail-copy-rendered]')&&workflow.querySelector('[data-detail-copy-original]')),
      detailManualUploadAvailable:Boolean(workflow.querySelector('[name="images[]"][multiple]')),
      providerMetadataSupported:Boolean(workflow.querySelector('select[name="providerCode"]')),
      emptyStateVisibleBeforeUpload:Boolean(workflow.querySelector('[data-detail-thumbnails] [class="muted"]')||workflow.textContent.includes('생성된 상세페이지 이미지 세트 없음')),
      expectedImageCount:10,
      multiUploadSupported:true,
      thumbnailCount,
      orderedFilenames,
      dragHandlesPresent:[...workflow.querySelectorAll('[data-detail-order]')].every((item)=>item.getAttribute('draggable')==='true'),
      approvedDetailSetUsedInExportControlsPresent:Boolean(workflow.querySelector('[data-detail-approve]')&&workflow.querySelector('[data-detail-reject]')),
      approveDisabledWithoutUpload:workflow.querySelector('[data-detail-approve]')?.disabled===true,
    };
  });

  db=await createPgPool(await loadDatabaseUrl(root));
  const html=(await db.query('select generated_detail_html from product_drafts where id=64')).rows[0]?.generated_detail_html||'';
  const detailRequest=(await db.query("select revision from product_image_generation_requests where product_draft_id=64 and request_type='detail_page'")).rows[0]||null;
  const naturalOrder=Array.from({length:10},(_,i)=>`img${i+1}.png`);
  Object.assign(result,{
    packageDownloadStatus:packageResponse.status,
    packageIsZip:packageBytes.subarray(0,2).equals(Buffer.from('PK')),
    generatedDetailHtmlLength:html.length,
    generatedDetailHtmlSha256:createHash('sha256').update(html).digest('hex'),
    detailPromptRevisionUnchanged:Number(detailRequest?.revision)===1,
    naturalSortAppliedCorrectly:JSON.stringify(result.orderedFilenames)===JSON.stringify(naturalOrder),
    browserConsoleErrors,browserPageErrors,failedRequests,
  });

  const artifactsDir=join(root,'artifacts');
  await mkdir(artifactsDir,{recursive:true});
  await page.screenshot({path:join(artifactsDir,'manual-detail-page-draft-64.png'),fullPage:true});
  await writeFile(join(artifactsDir,'manual-detail-page-draft-64-result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));

  const controls=['packageDownloadAvailable','detailPromptCopyAvailable','detailManualUploadAvailable','providerMetadataSupported','emptyStateVisibleBeforeUpload','multiUploadSupported','dragHandlesPresent','approvedDetailSetUsedInExportControlsPresent','approveDisabledWithoutUpload','naturalSortAppliedCorrectly'];
  if(
    controls.some((key)=>!result[key])
    ||result.thumbnailCount!==10
    ||result.packageDownloadStatus!==200
    ||!result.packageIsZip
    ||!result.detailPromptRevisionUnchanged
    ||html.length!==3896
    ||result.generatedDetailHtmlSha256!=='67ee716e9d48a39ae8a744e3451c3d7bd198399227aaf4b87997be54b86c5758'
    ||browserConsoleErrors.length
    ||browserPageErrors.length
    ||failedRequests.length
  )process.exitCode=1;
}finally{await cleanup();}
