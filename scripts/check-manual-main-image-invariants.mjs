import { createHash } from 'node:crypto';
import { loadDatabaseUrl } from '../src/config.mjs';
import { createPgPool } from '../src/postgres-store.mjs';

const db=await createPgPool(await loadDatabaseUrl());
try{
  const duplicates=await db.query("select product_draft_id,task_type,count(id)::int approved_count from generated_ai_images where status='approved' group by product_draft_id,task_type having count(id)>1");
  const counts=await db.query('select status,count(id)::int from generated_ai_images group by status order by status');
  const html=(await db.query('select generated_detail_html from product_drafts where id=64')).rows[0]?.generated_detail_html||'';
  const result={duplicateApprovalGroups:duplicates.rows,manualImageCounts:counts.rows,draft64HtmlLength:html.length,draft64HtmlSha256:createHash('sha256').update(html).digest('hex')};
  console.log(JSON.stringify(result,null,2));
  if(result.duplicateApprovalGroups.length||result.draft64HtmlLength!==3896||result.draft64HtmlSha256!=='67ee716e9d48a39ae8a744e3451c3d7bd198399227aaf4b87997be54b86c5758')process.exitCode=1;
}finally{await db.end();}
