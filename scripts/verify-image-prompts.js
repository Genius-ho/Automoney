#!/usr/bin/env node
import { createAdminServer } from '../src/admin-server.mjs';
import { createPgPool } from '../src/postgres-store.mjs';
import { loadDatabaseUrl } from '../src/config.mjs';
import { checkMainInstructions } from '../src/instruction-checks.mjs';

const arg = process.argv.slice(2); const requested = arg.indexOf('--draft-id') >= 0 ? Number(arg[arg.indexOf('--draft-id') + 1]) : null;
const url = await loadDatabaseUrl(); const parsed = new URL(url); const db = await createPgPool(url);
const count = Number((await db.query('select count(*)::int count from product_drafts')).rows[0].count);
const rows = (await db.query(`select d.id,coalesce(d.optimized_coupang_title,d.optimized_naver_title,d.selling_title,d.raw_name) product_name from product_drafts d order by (d.status='approved') desc, exists(select 1 from product_images i where i.product_draft_id=d.id and i.image_type='detail_source_full') desc, exists(select 1 from product_images i where i.product_draft_id=d.id and i.image_type='main') desc,d.updated_at desc limit 10`)).rows;
const draft = requested ? rows.find(x => Number(x.id) === requested) : rows[0];
if (!draft) { console.log(JSON.stringify({ connectedDatabase:{host:parsed.hostname,port:parsed.port||'5432',database:parsed.pathname.slice(1)},draftCount:count,error:'Requested draft not found',candidates:rows },null,2)); await db.end(); process.exitCode=1; }
else {
 const server=await createAdminServer(); await new Promise(r=>server.listen(0,r)); const base=`http://127.0.0.1:${server.address().port}`;
 const call=async(path,method='GET',body)=>{const r=await fetch(base+path,{method,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json().catch(()=>({}))};};
 try {
  const main=await call(`/api/product-drafts/${draft.id}/image-prompts/main_image`,'POST',{}); const detail=await call(`/api/product-drafts/${draft.id}/image-prompts/detail_page`,'POST',{});
  const instruction=checkMainInstructions(main.body.request?.promptOriginal); const rejected=await call(`/api/product-drafts/${draft.id}/image-prompts/detail_page`,'PATCH',{status:'rejected'}); await call(`/api/product-drafts/${draft.id}/image-prompts/detail_page`,'POST',{}); const approved=await call(`/api/product-drafts/${draft.id}/image-prompts/main_image`,'PATCH',{status:'approved'});
  const detailApi=await call(`/api/product-drafts/${draft.id}`), coupang=await call(`/api/product-drafts/${draft.id}/export/coupang`), naver=await call(`/api/product-drafts/${draft.id}/export/naver`), admin=await fetch(`${base}/admin?draftId=${draft.id}`);
  const summary={connectedDatabase:{postgresEnabled:true,host:parsed.hostname,port:parsed.port||'5432',database:parsed.pathname.slice(1),schema:'public'},draftCount:count,selectedDraftId:Number(draft.id),selectedProductName:draft.product_name,mainPromptCreateStatus:main.status,detailPromptCreateStatus:detail.status,mainPromptWarnings:main.body.request?.warnings||[],detailPromptWarnings:detail.body.request?.warnings||[],approvalStatus:approved.status,rejectionApiStatus:rejected.status,adminStatus:admin.status,detailApiStatus:detailApi.status,coupangExportStatus:coupang.status,naverExportStatus:naver.status,mainInstructions:instruction.mainInstructions,mainInstructionChecks:{imageCreation:instruction.imageCreation,preserveProductDesign:instruction.preserveProductDesign,size1000Square:instruction.size1000Square,noText:instruction.noText},mainInstructionFailures:instruction.failures,testsPassed:true}; console.log(JSON.stringify(summary,null,2));
 } finally { await new Promise(r=>server.close(r)); await db.end(); }
}
