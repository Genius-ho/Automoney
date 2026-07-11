import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

import { loadDatabaseUrl, loadNaverConfig } from './config.mjs';
import { NaverShoppingClient } from './naver-shopping-client.mjs';
import { researchNaverDraft } from './naver-research.mjs';
import { createPgPool, runSchema } from './postgres-store.mjs';
import { isAllowedPublicAssetPath } from './public-assets.mjs';
import {
  exportProductDraft,
  analyzeSeoKeywords,
  createImagePromptRequest,
  generateRegistrationOptimization,
  getRegistrationOptimization,
  getRegistrationChecklist,
  getMarketResearch,
  getImagePromptRequests,
  getProductDraft,
  listProductDrafts,
  regenerateOptimizedTitles,
  regenerateGeneratedDetailHtml,
  setProductDraftStatus,
  setImagePromptRequestStatus,
  updateProductDraft,
  updateRegistrationChecklist,
  upsertMarketResearch,
} from './admin-store.mjs';

export async function createAdminServer({ rootDir = process.cwd() } = {}) {
  const databaseUrl = await loadDatabaseUrl(rootDir);
  const db = await createPgPool(databaseUrl);
  await runSchema(db);

  const server = http.createServer((request, response) => {
    handleRequest({ request, response, db }).catch((error) => {
      sendJson(response, 500, { error: error.message || String(error) });
    });
  });

  server.on('close', () => {
    db.end().catch(() => {});
  });

  return server;
}

async function handleRequest({ request, response, db }) {
  const url = new URL(request.url, 'http://localhost');
  if (request.method === 'GET' && url.pathname === '/') {
    sendRedirect(response, '/admin');
    return;
  }
  if (request.method === 'GET' && url.pathname === '/admin') {
    sendHtml(response, adminHtml());
    return;
  }
  if (request.method === 'GET' && isAllowedPublicAssetPath(url.pathname)) {
    await sendPublicFile(response, url.pathname);
    return;
  }

  const imagePromptMatch = url.pathname.match(/^\/api\/product-drafts\/(\d+)\/image-prompts\/(main_image|detail_page)$/);
  if (imagePromptMatch) {
    const [, id, requestType] = imagePromptMatch;
    if (request.method === 'POST') { const requestData = await createImagePromptRequest(db, Number(id), requestType); if (!requestData) sendJson(response, 404, { error: 'Product draft not found' }); else sendJson(response, 200, { request: requestData }); return; }
    if (request.method === 'PATCH') { const body = await readJson(request); const requestData = await setImagePromptRequestStatus(db, Number(id), requestType, body.status); if (!requestData) sendJson(response, 404, { error: 'Image prompt request not found' }); else sendJson(response, 200, { request: requestData }); return; }
    sendJson(response, 405, { error: 'Method not allowed' }); return;
  }
  const imagePromptsMatch = url.pathname.match(/^\/api\/product-drafts\/(\d+)\/image-prompts$/);
  if (imagePromptsMatch && request.method === 'GET') { sendJson(response, 200, { requests: await getImagePromptRequests(db, Number(imagePromptsMatch[1])) }); return; }

  const naverRefreshMatch = url.pathname.match(/^\/api\/product-drafts\/(\d+)\/market-research\/naver\/refresh$/);
  if (naverRefreshMatch) {
    const [, id] = naverRefreshMatch;
    if (request.method !== 'POST') {
      sendJson(response, 405, { error: 'Method not allowed' });
      return;
    }
    const draft = await getProductDraft(db, Number(id));
    if (!draft) {
      sendJson(response, 404, { error: 'Product draft not found' });
      return;
    }
    const config = await loadNaverConfig();
    const client = new NaverShoppingClient(config);
    const body = await readJson(request);
    const research = await researchNaverDraft(db, client, {
      id: draft.id,
      selling_title: draft.sellingTitle,
      cleaned_name: draft.cleanedName,
      raw_name: draft.rawName,
      naver_sale_price: draft.naverSalePrice,
      naver_expected_profit: draft.naverExpectedProfit,
    }, { keyword: body.keyword });
    sendJson(response, 200, { research });
    return;
  }

  const researchMatch = url.pathname.match(/^\/api\/product-drafts\/(\d+)\/market-research\/(coupang|naver)$/);
  if (researchMatch) {
    const [, id, marketplace] = researchMatch;
    if (request.method === 'GET') {
      sendJson(response, 200, { research: await getMarketResearch(db, Number(id), marketplace) });
      return;
    }
    if (request.method === 'PUT' && marketplace === 'coupang') {
      const research = await upsertMarketResearch(db, Number(id), marketplace, await readJson(request));
      if (!research) sendJson(response, 404, { error: 'Product draft not found' });
      else sendJson(response, 200, { research });
      return;
    }
    sendJson(response, 405, { error: 'Method not allowed' });
    return;
  }

  const optimizationMatch = url.pathname.match(/^\/api\/product-drafts\/(\d+)\/registration-optimization$/);
  if (optimizationMatch) {
    const [, id] = optimizationMatch;
    if (request.method === 'GET') {
      sendJson(response, 200, { optimization: await getRegistrationOptimization(db, Number(id)) });
      return;
    }
    if (request.method === 'POST') {
      const optimization = await generateRegistrationOptimization(db, Number(id));
      if (!optimization) sendJson(response, 404, { error: 'Product draft not found' });
      else sendJson(response, 200, { optimization });
      return;
    }
    sendJson(response, 405, { error: 'Method not allowed' });
    return;
  }

  const generatedDetailMatch = url.pathname.match(/^\/api\/product-drafts\/(\d+)\/generated-detail-html$/);
  if (generatedDetailMatch) {
    const [, id] = generatedDetailMatch;
    if (request.method !== 'POST') {
      sendJson(response, 405, { error: 'Method not allowed' });
      return;
    }
    const body = await readJson(request);
    sendMaybeDraft(
      response,
      await regenerateGeneratedDetailHtml(db, Number(id), {
        includeOriginalDetailImages: body.includeOriginalDetailImages !== false,
      }),
    );
    return;
  }

  const seoAnalysisMatch = url.pathname.match(/^\/api\/product-drafts\/(\d+)\/seo-analysis$/);
  if (seoAnalysisMatch) {
    if (request.method !== 'POST') {
      sendJson(response, 405, { error: 'Method not allowed' });
      return;
    }
    const optimization = await analyzeSeoKeywords(db, Number(seoAnalysisMatch[1]));
    if (!optimization) sendJson(response, 404, { error: 'Product draft not found' });
    else sendJson(response, 200, { optimization });
    return;
  }

  const optimizedTitlesMatch = url.pathname.match(/^\/api\/product-drafts\/(\d+)\/optimized-titles$/);
  if (optimizedTitlesMatch) {
    if (request.method !== 'POST') {
      sendJson(response, 405, { error: 'Method not allowed' });
      return;
    }
    const optimization = await regenerateOptimizedTitles(db, Number(optimizedTitlesMatch[1]));
    if (!optimization) sendJson(response, 404, { error: 'Product draft not found' });
    else sendJson(response, 200, { optimization });
    return;
  }

  const checklistMatch = url.pathname.match(/^\/api\/product-drafts\/(\d+)\/registration-checklist$/);
  if (checklistMatch) {
    const [, id] = checklistMatch;
    if (request.method === 'GET') {
      sendJson(response, 200, { checklist: await getRegistrationChecklist(db, Number(id)) });
      return;
    }
    if (request.method === 'PUT') {
      sendJson(response, 200, { checklist: await updateRegistrationChecklist(db, Number(id), await readJson(request)) });
      return;
    }
    sendJson(response, 405, { error: 'Method not allowed' });
    return;
  }

  const match = url.pathname.match(/^\/api\/product-drafts(?:\/(\d+)(?:\/(approve|block|export\/coupang|export\/naver))?)?$/);
  if (!match) {
    sendJson(response, 404, { error: 'Not found' });
    return;
  }

  const [, id, action] = match;
  if (!id && request.method === 'GET') {
    const drafts = await listProductDrafts(db, {
      status: url.searchParams.get('status') || undefined,
      importBatchId: url.searchParams.get('importBatchId') || undefined,
      collectedOnly: url.searchParams.get('collectedOnly') === 'true',
      naverWinnerStatus: url.searchParams.get('naverWinnerStatus') || undefined,
      finalDecision: url.searchParams.get('finalDecision') || undefined,
    });
    sendJson(response, 200, { drafts });
    return;
  }

  if (!id) {
    sendJson(response, 405, { error: 'Method not allowed' });
    return;
  }

  if (!action && request.method === 'GET') {
    sendMaybeDraft(response, await getProductDraft(db, Number(id)));
    return;
  }

  if (!action && request.method === 'PATCH') {
    sendMaybeDraft(response, await updateProductDraft(db, Number(id), await readJson(request)));
    return;
  }

  if (action === 'approve' && request.method === 'POST') {
    sendMaybeDraft(response, await setProductDraftStatus(db, Number(id), 'approved'));
    return;
  }

  if (action === 'block' && request.method === 'POST') {
    sendMaybeDraft(response, await setProductDraftStatus(db, Number(id), 'blocked'));
    return;
  }

  if (action?.startsWith('export/') && request.method === 'GET') {
    const exportJson = await exportProductDraft(db, Number(id), action.split('/')[1]);
    if (!exportJson) sendJson(response, 404, { error: 'Product draft not found' });
    else sendJson(response, 200, exportJson);
    return;
  }

  sendJson(response, 405, { error: 'Method not allowed' });
}

function sendMaybeDraft(response, draft) {
  if (!draft) sendJson(response, 404, { error: 'Product draft not found' });
  else sendJson(response, 200, { draft });
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error('Request body too large'));
        request.destroy();
      }
    });
    request.on('end', () => {
      if (!body.trim()) resolve({});
      else {
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error('Invalid JSON request body'));
        }
      }
    });
    request.on('error', reject);
  });
}

function sendRedirect(response, location) {
  response.writeHead(302, { location });
  response.end();
}

function sendHtml(response, html) {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  response.end(html);
}

function sendJson(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value, null, 2));
}

async function sendPublicFile(response, pathname) {
  const publicRoot = resolve(process.cwd(), 'public');
  const relativePath = decodeURIComponent(pathname.replace(/^\/+/, ''));
  const filePath = resolve(join(publicRoot, relativePath.replace(/^public[\\/]/, '')));
  if (!filePath.startsWith(publicRoot)) {
    sendJson(response, 403, { error: 'Forbidden' });
    return;
  }
  try {
    const body = await readFile(filePath);
    response.writeHead(200, { 'content-type': contentType(filePath), 'cache-control': 'public, max-age=3600' });
    response.end(body);
  } catch {
    sendJson(response, 404, { error: 'Not found' });
  }
}

function contentType(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'application/octet-stream';
}

function adminHtml() {
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Automoney Admin</title>
  <style>
    body{margin:0;background:#f5f6f8;color:#1f2933;font-family:Arial,sans-serif}
    header{background:#fff;border-bottom:1px solid #d8dee7;padding:14px 18px;display:flex;gap:14px;align-items:center}
    h1{font-size:18px;margin:0} button,select,input,textarea{font:inherit}
    button{border:1px solid #b9c2cf;background:#fff;padding:7px 10px;cursor:pointer}
    button.primary{background:#1f6feb;color:#fff;border-color:#1f6feb}
    main{display:grid;grid-template-rows:minmax(420px,52vh) 1fr;min-height:calc(100vh - 57px)}
    .list{border-bottom:1px solid #d8dee7;background:#fff;overflow:hidden;display:flex;flex-direction:column;min-width:0}
    .detail{padding:18px;overflow:auto}.toolbar{display:flex;gap:8px;padding:12px;border-bottom:1px solid #d8dee7;background:#fff;flex:0 0 auto}
    .tableWrap{overflow:auto;flex:1 1 auto} table{border-collapse:collapse;width:max-content;min-width:100%;font-size:12px;table-layout:fixed}
    th,td{border-bottom:1px solid #edf0f4;padding:6px 7px;vertical-align:top;text-align:left;overflow:hidden;text-overflow:ellipsis} th{background:#f9fafb;font-weight:700;position:sticky;top:0;z-index:1;white-space:nowrap;user-select:none}
    td{max-height:44px}.clip{display:block;overflow:hidden;text-overflow:ellipsis}.idCol{width:58px;min-width:44px}.productNoCol{width:98px;min-width:76px}.nameCol{width:260px;min-width:150px;max-width:none}
    .moneyCol{width:82px;min-width:58px;text-align:right;white-space:nowrap}.statusCol{width:88px;min-width:64px}.reasonCol{width:180px;min-width:110px}.actionCol{width:74px;min-width:62px;text-align:center}
    .colResize{position:absolute;top:0;right:-3px;width:7px;height:100%;cursor:col-resize;z-index:3}.colResize:hover,.resizing .colResize{background:#b8d7ff}
    th.selectedCol,td.selectedCol{background:#fff7e6!important}tr.selectedRow td{background:#e8f1ff!important}th.selectedCol{box-shadow:inset 0 -2px 0 #f59e0b}td.selectedCell{outline:2px solid #1f6feb;outline-offset:-2px}
    tr{cursor:pointer} tr.active{background:#e8f1ff}.productLink{color:#145dbf;font-weight:700;text-decoration:none}.productLink:hover{text-decoration:underline}
    .muted{color:#667085}.badge{display:inline-block;padding:2px 6px;border:1px solid #ccd3dd;background:#f8fafc;margin:1px;font-size:12px;white-space:nowrap}
    .badge.status{background:#eef6ff;border-color:#b8d7ff;color:#174a85}.badge.reasonBlock{background:#fff1f0;border-color:#ffccc7;color:#a8071a}.badge.reasonReview{background:#fffbe6;border-color:#ffe58f;color:#874d00}
    .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.section{background:#fff;border:1px solid #d8dee7;padding:12px;margin-bottom:12px}
    .tabs{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 12px}.tabs button.active{background:#1f6feb;color:#fff;border-color:#1f6feb}.tabPanel{display:none}.tabPanel.active{display:block}
    .section h2{font-size:15px;margin:0 0 10px}label{display:block;font-size:12px;color:#4b5563;margin:8px 0 4px}
    input,textarea,select{box-sizing:border-box;width:100%;border:1px solid #b9c2cf;padding:8px;background:#fff}textarea{min-height:120px;resize:vertical}
    iframe{width:100%;min-height:360px;border:1px solid #d8dee7;background:#fff}img{max-width:120px;max-height:120px;object-fit:contain;border:1px solid #d8dee7;background:#fff;margin:4px}
    pre{white-space:pre-wrap;background:#0f172a;color:#dbeafe;padding:12px;overflow:auto}
  </style>
</head>
<body>
  <header><h1>Automoney Admin</h1><span class="muted">Product draft review</span></header>
  <main>
    <section class="list">
      <div class="toolbar">
        <select id="statusFilter"><option value="">all</option><option value="draft">draft</option><option value="needs_review">needs_review</option><option value="blocked">blocked</option><option value="approved">approved</option></select>
        <select id="naverWinnerFilter"><option value="">naver all</option><option value="candidate">candidate</option><option value="needs_review">needs_review</option><option value="reject">reject</option></select>
        <select id="finalDecisionFilter"><option value="">final all</option><option value="등록후보">등록후보</option><option value="검수필요">검수필요</option><option value="제외">제외</option></select>
        <input id="batchFilter" placeholder="importBatchId">
        <label style="display:flex;align-items:center;gap:4px;margin:0;color:#1f2933;"><input id="collectedOnly" type="checkbox" style="width:auto;"> collected</label>
        <button id="naverCandidateButton">N winner Candidate</button>
        <button id="reloadButton">Reload</button>
      </div>
      <div class="tableWrap"><table id="draftTable"><thead><tr>
        <th class="idCol">DB ID</th><th class="productNoCol">Domeme No</th><th class="statusCol">Market</th><th class="moneyCol">Main img</th><th class="moneyCol">Detail img</th><th class="moneyCol">Total img</th><th class="moneyCol">MOQ</th><th class="moneyCol">Order unit</th><th class="statusCol">Sell unit</th><th class="moneyCol">Bundle qty</th><th class="moneyCol">Unit cost</th><th class="moneyCol">Bundle cost</th><th class="nameCol">Name</th>
        <th class="moneyCol">Cost</th><th class="moneyCol">Shipping</th><th class="moneyCol">Coupang</th><th class="moneyCol">Coupang profit</th>
        <th class="moneyCol">Naver</th><th class="moneyCol">Naver profit</th><th class="moneyCol">Lowest</th><th class="moneyCol">Gap %</th>
        <th class="statusCol">Rocket</th><th class="moneyCol">Max reviews</th><th class="moneyCol">Competitors</th><th class="moneyCol">Winner score</th><th class="statusCol">Winner</th>
        <th class="moneyCol">N lowest</th><th class="moneyCol">N gap %</th><th class="moneyCol">N competitors</th><th class="moneyCol">N score</th><th class="statusCol">N winner</th>
        <th class="statusCol">Final</th><th class="statusCol">Status</th><th class="reasonCol">Reasons</th><th class="actionCol">상세보기</th><th class="actionCol">공급처</th>
      </tr></thead><tbody id="draftRows"></tbody></table></div>
    </section>
    <section class="detail" id="detail">Select a product.</section>
  </main>
  <script>
    let selectedId=null;let selectedColIndex=null;let selectedRowIndex=null;const rows=document.getElementById('draftRows');const detail=document.getElementById('detail');
    const statusFilter=document.getElementById('statusFilter');const naverWinnerFilter=document.getElementById('naverWinnerFilter');const finalDecisionFilter=document.getElementById('finalDecisionFilter');const batchFilter=document.getElementById('batchFilter');const collectedOnly=document.getElementById('collectedOnly');
    document.getElementById('reloadButton').addEventListener('click',loadList);document.getElementById('naverCandidateButton').addEventListener('click',()=>{naverWinnerFilter.value='candidate';loadList();});statusFilter.addEventListener('change',loadList);naverWinnerFilter.addEventListener('change',loadList);finalDecisionFilter.addEventListener('change',loadList);batchFilter.addEventListener('change',loadList);collectedOnly.addEventListener('change',loadList);
    initColumnResize();loadList();const initialId=new URL(location.href).searchParams.get('draftId');if(initialId)loadDetail(initialId,false);
    async function loadList(){const params=new URLSearchParams();if(statusFilter.value)params.set('status',statusFilter.value);if(naverWinnerFilter.value)params.set('naverWinnerStatus',naverWinnerFilter.value);if(finalDecisionFilter.value)params.set('finalDecision',finalDecisionFilter.value);if(batchFilter.value.trim())params.set('importBatchId',batchFilter.value.trim());if(collectedOnly.checked)params.set('collectedOnly','true');const qs=params.toString()?'?'+params.toString():'';const data=await api('/api/product-drafts'+qs);rows.innerHTML=data.drafts.map(rowHtml).join('');for(const el of rows.querySelectorAll('[data-open-detail]'))el.addEventListener('click',e=>{e.preventDefault();loadDetail(el.dataset.openDetail);});bindCellSelection();applyStoredOrAutoWidths();applySelection();}
    function initColumnResize(){const table=document.getElementById('draftTable');const headers=[...table.querySelectorAll('th')];headers.forEach((th,index)=>{th.addEventListener('click',e=>{if(e.target.classList.contains('colResize'))return;selectedColIndex=index;selectedRowIndex=null;applySelection();});th.addEventListener('dblclick',e=>{if(e.target.classList.contains('colResize'))return;autoFitColumn(index,true);});const handle=document.createElement('span');handle.className='colResize';handle.title='Drag to resize column. Double-click to auto-fit.';th.appendChild(handle);handle.addEventListener('dblclick',e=>{e.preventDefault();e.stopPropagation();autoFitColumn(index,true);});handle.addEventListener('mousedown',e=>{e.preventDefault();e.stopPropagation();const startX=e.clientX;const startWidth=th.getBoundingClientRect().width;document.body.classList.add('resizing');const move=event=>{const width=Math.max(minColumnWidth(index),Math.round(startWidth+event.clientX-startX));setColumnWidth(table,index,width);saveColumnWidth(index,width);};const up=()=>{document.body.classList.remove('resizing');document.removeEventListener('mousemove',move);document.removeEventListener('mouseup',up);};document.addEventListener('mousemove',move);document.addEventListener('mouseup',up);});});}
    function applyStoredOrAutoWidths(){const table=document.getElementById('draftTable');const headers=[...table.querySelectorAll('th')];const saved=getColumnWidths();headers.forEach((_,index)=>{if(saved['c'+index])setColumnWidth(table,index,saved['c'+index]);else autoFitColumn(index,false);});}
    function autoFitColumn(index,persist){const table=document.getElementById('draftTable');const isName=table.rows[0]?.cells[index]?.classList.contains('nameCol');let max=isName?190:minColumnWidth(index);for(const row of table.rows){const cell=row.cells[index];if(!cell)continue;const text=(cell.innerText||'').replace(/\s+/g,' ').trim();const estimate=Math.min(isName?360:160,Math.max(minColumnWidth(index),text.length*7+18));max=Math.max(max,estimate);}setColumnWidth(table,index,max);if(persist)saveColumnWidth(index,max);}
    function setColumnWidth(table,index,width){const value=Number(width)||80;for(const row of table.rows){const cell=row.cells[index];if(cell){cell.style.width=value+'px';cell.style.minWidth=value+'px';cell.style.maxWidth=value+'px';}}}
    function minColumnWidth(index){const table=document.getElementById('draftTable');const header=table.rows[0]?.cells[index];if(header?.classList.contains('nameCol'))return 180;if(header?.classList.contains('actionCol'))return 58;if(header?.classList.contains('idCol'))return 44;if(header?.classList.contains('productNoCol'))return 76;return 52;}
    function getColumnWidths(){try{return JSON.parse(localStorage.getItem('automoney.admin.columnWidths')||'{}')}catch{return{}}}
    function saveColumnWidth(index,width){const saved=getColumnWidths();saved['c'+index]=width;localStorage.setItem('automoney.admin.columnWidths',JSON.stringify(saved));}
    function bindCellSelection(){[...rows.querySelectorAll('tr')].forEach((tr,rowIndex)=>{tr.addEventListener('click',e=>{if(e.target.closest('button,a,input,select,textarea'))return;selectedRowIndex=rowIndex;selectedColIndex=e.target.closest('td')?.cellIndex??selectedColIndex;applySelection();});});}
    function applySelection(){const table=document.getElementById('draftTable');for(const cell of table.querySelectorAll('.selectedCol,.selectedCell'))cell.classList.remove('selectedCol','selectedCell');for(const row of table.querySelectorAll('tr.selectedRow'))row.classList.remove('selectedRow');if(selectedColIndex!=null){for(const row of table.rows){row.cells[selectedColIndex]?.classList.add('selectedCol');}}if(selectedRowIndex!=null){rows.rows[selectedRowIndex]?.classList.add('selectedRow');if(selectedColIndex!=null)rows.rows[selectedRowIndex]?.cells[selectedColIndex]?.classList.add('selectedCell');}}
    function rowHtml(d){const r=d.coupangResearch||{};const nr=d.naverResearch||{};const warningBadges=(d.warnings||[]).map(x=>'<span class="badge reasonBlock">'+escapeHtml(x)+'</span>').join('');const reasons=[...(d.blockReasons||[]).map(x=>'<span class="badge reasonBlock">'+escapeHtml(x)+'</span>'),...(d.reviewReasons||[]).map(x=>'<span class="badge reasonReview">'+escapeHtml(x)+'</span>')].join('')||'<span class="muted">-</span>';const title=d.originalProductName||d.sellingTitle||'';const sourceButton=d.supplierProductUrl?'<a href="'+attr(d.supplierProductUrl)+'" target="_blank" rel="noopener noreferrer"><button>공급처</button></a>':'-';return '<tr class="'+(Number(selectedId)===d.id?'active':'')+'"><td class="idCol">'+d.id+'</td><td>'+escapeHtml(d.supplierProductNo)+'</td><td>'+escapeHtml(labelMarket(d.supplierMarket))+'</td><td class="moneyCol">'+money(d.mainImages)+'</td><td class="moneyCol">'+money(d.detailImages)+'</td><td class="moneyCol">'+money(d.totalImages)+'</td><td class="moneyCol">'+money(d.minOrderQty)+'</td><td class="moneyCol">'+money(d.orderUnit)+'</td><td>'+escapeHtml(labelSellUnit(d.sellUnitType))+'</td><td class="moneyCol">'+money(d.bundleQuantity)+'</td><td class="moneyCol">'+money(d.unitCostPrice)+'</td><td class="moneyCol">'+money(d.bundleCostPrice)+'</td><td class="nameCol"><a class="productLink" data-open-detail="'+d.id+'" href="/admin?draftId='+d.id+'">'+escapeHtml(title)+'</a><br><span class="muted">'+escapeHtml(d.sellingTitle||'')+'</span></td><td class="moneyCol">'+money(d.cost)+'</td><td class="moneyCol">'+money(d.shippingFee)+'</td><td class="moneyCol">'+money(d.coupangSalePrice)+'</td><td class="moneyCol">'+moneyWithRate(d.coupangExpectedProfit,d.coupangMarginRate)+'</td><td class="moneyCol">'+money(d.naverSalePrice)+'</td><td class="moneyCol">'+moneyWithRate(d.naverExpectedProfit,d.naverMarginRate)+'</td><td class="moneyCol">'+money(r.lowestPrice)+'</td><td class="moneyCol">'+percent(r.priceGapRate)+'</td><td>'+rocketLabel(r.rocketExists)+'</td><td class="moneyCol">'+money(r.maxReviewCount)+'</td><td class="moneyCol">'+money(r.competitorCount)+'</td><td class="moneyCol">'+(r.winnerScore??'-')+'</td><td>'+escapeHtml(labelWinner(r.winnerStatus))+'</td><td class="moneyCol">'+money(nr.lowestPrice)+'</td><td class="moneyCol">'+percent(nr.priceGapRate)+'</td><td class="moneyCol">'+money(nr.competitorCount)+'</td><td class="moneyCol">'+(nr.winnerScore??'-')+'</td><td>'+escapeHtml(labelWinner(nr.winnerStatus))+'</td><td><span class="badge status">'+escapeHtml(d.finalDecision||'-')+'</span></td><td><span class="badge status">'+escapeHtml(labelStatus(d.status))+'</span>'+warningBadges+'</td><td>'+reasons+'</td><td><button data-open-detail="'+d.id+'">상세보기</button></td><td>'+sourceButton+'</td></tr>';}
    async function loadDetail(id,push=true){selectedId=id;if(push)history.replaceState(null,'','/admin?draftId='+encodeURIComponent(id));const data=await api('/api/product-drafts/'+id);const d=data.draft;detail.innerHTML=detailHtml(d);enhanceDetailImageSections(d);bindTabs();document.getElementById('saveButton').addEventListener('click',()=>saveDraft(id));for(const b of detail.querySelectorAll('[data-status-action]'))b.addEventListener('click',()=>setStatus(id,b.dataset.statusAction));const forceApprove=document.getElementById('forceApproveButton');if(forceApprove)forceApprove.addEventListener('click',()=>forceApproveDraft(id));document.getElementById('exportCoupangButton').addEventListener('click',()=>loadExport(id,'coupang'));document.getElementById('exportNaverButton').addEventListener('click',()=>loadExport(id,'naver'));document.getElementById('copyJsonButton').addEventListener('click',copyExportJson);document.getElementById('refreshNaverButton').addEventListener('click',()=>refreshNaver(id));document.getElementById('runSeoAnalysisButton').addEventListener('click',()=>runSeoAnalysis(id));const regenerateTitleButton=document.getElementById('regenerateTitleButton');if(regenerateTitleButton)regenerateTitleButton.addEventListener('click',()=>regenerateOptimizedTitles(id));const saveTitlesButton=document.getElementById('saveTitlesButton');if(saveTitlesButton)saveTitlesButton.addEventListener('click',()=>saveOptimizedTitles(id));const copyCoupangTitleButton=document.getElementById('copyCoupangTitleButton');if(copyCoupangTitleButton)copyCoupangTitleButton.addEventListener('click',()=>copyTitle('optimizedCoupangTitle'));const copyNaverTitleButton=document.getElementById('copyNaverTitleButton');if(copyNaverTitleButton)copyNaverTitleButton.addEventListener('click',()=>copyTitle('optimizedNaverTitle'));const regenerateDetailButton=document.getElementById('regenerateDetailButton');if(regenerateDetailButton)regenerateDetailButton.addEventListener('click',()=>regenerateGeneratedDetail(id));const toggleOriginalButton=document.getElementById('toggleOriginalDetailButton');if(toggleOriginalButton)toggleOriginalButton.addEventListener('click',toggleOriginalDetailImages);const refreshPreviewButton=document.getElementById('refreshPreviewButton');if(refreshPreviewButton)refreshPreviewButton.addEventListener('click',refreshDetailPreview);document.getElementById('saveChecklistButton').addEventListener('click',()=>saveChecklist(id));document.getElementById('preview').srcdoc=d.generatedDetailHtml||'';const naver=await api('/api/product-drafts/'+id+'/market-research/naver');fillNaverResearch(naver.research);const opt=await api('/api/product-drafts/'+id+'/registration-optimization');renderOptimization(opt.optimization);const checklist=await api('/api/product-drafts/'+id+'/registration-checklist');fillChecklist(checklist.checklist);loadList();}
    function detailHtml(d){const hasBlockReasons=(d.blockReasons||[]).length>0;const approvalButton=hasBlockReasons?'<button id="forceApproveButton">Force approve</button><span class="badge reasonBlock">overrideReason required</span>':'<button data-status-action="approved">Approved</button>';const warnings=(d.warnings||[]).map(x=>'<span class="badge reasonBlock">'+escapeHtml(x)+'</span>').join('');return '<div class="tabs"><button class="active" data-tab="source">원본/공급처</button><button data-tab="naver">네이버 경쟁분석</button><button data-tab="seo">SEO 키워드</button><button data-tab="title">상품명</button><button data-tab="detail">상세페이지</button><button data-tab="image">이미지 프롬프트</button><button data-tab="category">카테고리</button><button data-tab="notice">고시정보</button><button data-tab="shipping">배송정책</button><button data-tab="approval">승인조건</button><button data-tab="export">Export JSON</button></div><div class="tabPanel active" data-panel="source"><div class="section"><h2>#'+d.id+' '+escapeHtml(d.supplierProductNo)+'</h2><div class="grid"><div><div class="muted">Original name</div><strong>'+escapeHtml(d.originalProductName||'')+'</strong></div><div><div class="muted">Status</div>'+escapeHtml(labelStatus(d.status))+' / '+escapeHtml(labelStatus(d.filterStatus))+' '+warnings+'</div><div>Final: <span class="badge status">'+escapeHtml(d.finalDecision||'-')+'</span></div><div>Raw price: '+escapeHtml(d.rawPriceFieldName||'-')+' = '+escapeHtml(d.rawPriceValue||'-')+'</div><div>Shipping: '+escapeHtml(d.shippingRawFieldName||'-')+' = '+escapeHtml(d.shippingRawValue||'-')+'</div><div>Coupang: '+money(d.coupangSalePrice)+' / profit '+money(d.coupangExpectedProfit)+'</div><div>Naver: '+money(d.naverSalePrice)+' / profit '+money(d.naverExpectedProfit)+'</div></div></div>'+sourceInfoHtml(d)+'<div class="section"><h2>Reasons</h2>'+reasonBadges(d.blockReasons).join('')+reasonBadges(d.reviewReasons).join('')+'</div><div class="section"><h2>Images</h2>'+imageGalleryHtml(d)+'</div><div class="section"><h2>Options</h2><table><tbody>'+d.options.map(o=>'<tr><td>'+o.index+'</td><td>'+escapeHtml(o.name||'')+'</td><td>'+escapeHtml(o.value||'')+'</td><td>'+money(o.additionalPrice)+'</td></tr>').join('')+'</tbody></table></div></div><div class="tabPanel" data-panel="naver">'+naverResearchHtml()+'</div><div class="tabPanel" data-panel="seo">'+optimizationHtml()+'</div><div class="tabPanel" data-panel="title"><div class="section"><h2>상품명</h2><div id="optimizedTitleResult" class="muted"></div></div></div><div class="tabPanel" data-panel="detail"><div class="section"><h2>수정</h2><label>sellingTitle</label><input id="sellingTitle" value="'+attr(d.sellingTitle||'')+'"><div class="grid"><div><label>coupangSalePrice</label><input id="coupangSalePrice" type="number" value="'+attr(d.coupangSalePrice??'')+'"></div><div><label>naverSalePrice</label><input id="naverSalePrice" type="number" value="'+attr(d.naverSalePrice??'')+'"></div></div><label>status</label><select id="status"><option>draft</option><option>needs_review</option><option>blocked</option><option>approved</option></select><label>상세페이지 HTML 수정</label><textarea id="generatedDetailHtml">'+escapeHtml(d.generatedDetailHtml||'')+'</textarea><label>reviewMemo</label><textarea id="reviewMemo">'+escapeHtml(d.reviewMemo||'')+'</textarea><p><button class="primary" id="saveButton">Save</button> <button data-status-action="draft">Draft</button> <button data-status-action="needs_review">Needs review</button> <button data-status-action="blocked">Blocked</button> '+approvalButton+' <button id="exportCoupangButton">쿠팡 JSON 보기</button> <button id="exportNaverButton">네이버 JSON 보기</button> <button id="copyJsonButton">JSON 복사</button></p></div><div class="section"><h2>상세페이지 미리보기</h2><iframe id="preview"></iframe></div></div><div class="tabPanel" data-panel="image"><div class="section"><h2>이미지 프롬프트</h2><pre id="imagePromptResult"></pre></div></div><div class="tabPanel" data-panel="category"><div class="section"><h2>카테고리</h2><div id="categoryResult" class="muted"></div></div></div><div class="tabPanel" data-panel="notice"><div class="section"><h2>고시정보</h2><div id="noticeResult" class="muted"></div></div></div><div class="tabPanel" data-panel="shipping"><div class="section"><h2>배송정책</h2><div id="shippingResult" class="muted"></div></div></div><div class="tabPanel" data-panel="approval">'+approvalChecklistHtml()+'</div><div class="tabPanel" data-panel="export"><div class="section"><h2>Export JSON preview</h2><pre id="exportPreview"></pre></div></div><script>document.getElementById("status").value='+JSON.stringify(d.status)+';<\\/script>';}
    function enhanceDetailImageSections(d){const panel=detail.querySelector('[data-panel="detail"]');if(!panel)return;const preview=panel.querySelector('#preview')?.closest('.section');if(preview){preview.querySelector('h2').textContent='재구성 상세페이지 미리보기';const note=document.createElement('p');note.className='muted';note.textContent='긴 원본 이미지는 참고 자료로 보관하고, 아래 HTML은 상품명/스펙/추천대상/핵심장점/배송안내 구조로 재구성한 내용입니다.';preview.insertBefore(note,preview.querySelector('iframe'));}const edit=panel.querySelector('.section');const save=document.getElementById('saveButton');if(save)save.textContent='HTML 저장';if(edit&&!document.getElementById('regenerateDetailButton')){const controls=document.createElement('p');controls.innerHTML='<button id="regenerateDetailButton" type="button">상세페이지 재생성</button> <button id="toggleOriginalDetailButton" type="button" data-include-original="true">원본 상세 이미지 포함</button> <button id="refreshPreviewButton" type="button">미리보기 새로고침</button>';edit.append(controls);}const source=document.createElement('div');source.className='section';source.innerHTML='<h2>원본 상세 이미지 보기</h2>'+imageGalleryHtml(d);panel.insertBefore(source,preview||null);const usage=document.createElement('div');usage.className='section';usage.innerHTML='<h2>원본 이미지 사용 여부</h2><div class="muted">detail_source_full은 기본적으로 원본 참고 영역에서만 사용합니다. 상세 본문 자동 삽입은 selected_for_detail 또는 regenerated_detail_asset을 우선합니다.</div>';if(preview)panel.insertBefore(usage,preview.nextSibling);const imagePanel=detail.querySelector('[data-panel="image"] h2');if(imagePanel)imagePanel.textContent='AI 이미지 생성 프롬프트';}
    function imageGalleryHtml(d){const images=d.images||[];const main=images.filter(i=>i.imageType==='main');const detailImages=images.filter(i=>i.sourceSection==='detail'&&['detail','regenerated_detail_asset'].includes(i.imageType));const sourceFull=images.filter(i=>['detail_source_full','detail_full'].includes(i.imageType));const slices=images.filter(i=>['detail_source_slice','detail_slice'].includes(i.imageType));const rejected=images.filter(i=>i.qualityStatus==='rejected'||i.rejectReason||['ad','recommendation','header','footer'].includes(i.sourceSection));const warnings=[];if(detailImages.length===0&&sourceFull.length===0&&slices.length===0)warnings.push('detail_images_missing');if(detailImages.length===0&&sourceFull.length>0)warnings.push('using_original_detail_source_only');const warn=warnings.map(x=>'<span class="badge reasonBlock">'+escapeHtml(x)+'</span>').join(' ');function meta(i){const size=(i.width||i.naturalWidth||i.renderedWidth||'-')+'x'+(i.height||i.naturalHeight||i.renderedHeight||'-');const pos=i.renderedX==null?'-':Math.round(i.renderedX)+','+Math.round(i.renderedY);const archived=String(i.storedUrl||'').startsWith('/original-images/')?'로컬 보관됨':'로컬 미보관';return '<div class="muted">'+escapeHtml(i.sourceMethod||'-')+' / '+escapeHtml(i.sourceSection||'-')+' / '+size+' / pos '+pos+' / '+archived+(i.crawlStatus?(' / '+escapeHtml(i.crawlStatus)):'')+(i.crawlError?(' / '+escapeHtml(i.crawlError)):'')+(i.sliceIndex?(' / slice '+i.sliceIndex):'')+(i.rejectReason?(' / reject '+escapeHtml(i.rejectReason)):'')+'</div><div class="muted">original: '+escapeHtml(i.originalUrl||i.url||'-')+'</div><div class="muted">stored: '+escapeHtml(i.storedUrl||'-')+'</div>';}function card(i){const url=i.storedUrl||i.url;const original=i.originalUrl||i.url;const local=i.storedUrl&&i.storedUrl!==original?'<a href="'+attr(i.storedUrl)+'" target="_blank" rel="noopener noreferrer"><button>로컬 이미지 열기</button></a>':'';return '<div style="display:inline-block;vertical-align:top;max-width:170px;margin:4px"><span class="badge">'+escapeHtml(i.imageType||'unknown')+'</span>'+meta(i)+'<a href="'+attr(url)+'" target="_blank" rel="noopener noreferrer"><img src="'+attr(url)+'" alt=""></a><br><a href="'+attr(original)+'" target="_blank" rel="noopener noreferrer"><button>원본 열기</button></a> '+local+'</div>';}function group(title,items){return '<h3>'+escapeHtml(title)+' ('+items.length+')</h3><div>'+items.map(card).join('')+'</div>';}return (warn?'<p>'+warn+'</p>':'')+group('대표 이미지',main)+group('상세페이지 이미지',detailImages)+group('원본 상세 이미지',sourceFull)+group('긴 이미지 분할 이미지',slices)+group('제외된 이미지/debug 이미지',rejected);}    function sourceInfoHtml(d){const link=d.supplierProductUrl?'<a href="'+attr(d.supplierProductUrl)+'" target="_blank" rel="noopener noreferrer"><button>공급처</button></a>':'-';return '<div class="section"><h2>공급처 정보</h2><div class="grid"><div>공급처명: '+escapeHtml(d.supplierName||'-')+'</div><div>공급마켓: '+escapeHtml(labelMarket(d.supplierMarket))+'</div><div>상품번호: '+escapeHtml(d.supplierProductNo||'-')+'</div><div>최소구매수량: '+money(d.minOrderQty)+'</div><div>주문단위: '+money(d.orderUnit)+'</div><div>판매단위: '+escapeHtml(labelSellUnit(d.sellUnitType))+'</div><div>묶음수량: '+money(d.bundleQuantity)+'</div><div>단품원가: '+money(d.unitCostPrice)+'</div><div>묶음원가: '+money(d.bundleCostPrice)+'</div><div>묶음사유: '+escapeHtml(d.bundleReason||'-')+'</div><div>공급처 원본 링크: '+link+'</div></div></div>';}
    function naverResearchHtml(){return '<div class="section"><h2>Naver shopping research</h2><label>Naver search keyword</label><input id="naverKeyword"><p><button id="refreshNaverButton">Refresh Naver research</button></p><div id="naverResearchResult" class="muted"></div><div id="naverBestItem"></div></div>';}
    function optimizationHtml(){return '<div class="section"><h2>SEO 키워드</h2><p><button id="runSeoAnalysisButton">SEO 분석 실행</button></p><div id="seoResult" class="muted"></div></div>';}
    function approvalChecklistHtml(){const items=[['supplierLinkChecked','공급처 링크 확인 완료'],['naverLowestSameItemChecked','네이버 최저가 동일상품 확인 완료'],['titleChecked','상품명 확인 완료'],['detailChecked','상세페이지 확인 완료'],['categoryChecked','카테고리 확인 완료'],['noticeChecked','고시정보 확인 완료'],['shippingPolicyChecked','배송정책 확인 완료'],['exportJsonChecked','export JSON 확인 완료']];return '<div class="section"><h2>승인조건</h2>'+items.map(([id,label])=>'<label style="display:flex;gap:8px;align-items:center"><input type="checkbox" data-check="'+id+'" style="width:auto">'+label+'</label>').join('')+'<label>overrideReason</label><textarea id="checkOverrideReason"></textarea><p><button id="saveChecklistButton">승인조건 저장</button></p><div id="checklistResult" class="muted"></div></div>';}
    async function saveDraft(id){const body={sellingTitle:document.getElementById('sellingTitle').value,coupangSalePrice:document.getElementById('coupangSalePrice').value,naverSalePrice:document.getElementById('naverSalePrice').value,generatedDetailHtml:document.getElementById('generatedDetailHtml').value,reviewMemo:document.getElementById('reviewMemo').value,status:document.getElementById('status').value};await api('/api/product-drafts/'+id,{method:'PATCH',body:JSON.stringify(body)});await loadDetail(id);}
    async function setStatus(id,status){await api('/api/product-drafts/'+id,{method:'PATCH',body:JSON.stringify({status})});await loadDetail(id);}
    async function forceApproveDraft(id){const overrideReason=prompt('overrideReason');if(!overrideReason||!overrideReason.trim())return;await api('/api/product-drafts/'+id,{method:'PATCH',body:JSON.stringify({status:'approved',overrideReason})});await loadDetail(id);}
    async function loadExport(id,channel){const data=await api('/api/product-drafts/'+id+'/export/'+channel);document.getElementById('exportPreview').textContent=JSON.stringify(data,null,2);}
    async function copyExportJson(){const text=document.getElementById('exportPreview').textContent;if(!text.trim())return;if(navigator.clipboard&&navigator.clipboard.writeText){await navigator.clipboard.writeText(text);return;}const area=document.createElement('textarea');area.value=text;document.body.appendChild(area);area.select();document.execCommand('copy');area.remove();}
    function bindTabs(){for(const b of detail.querySelectorAll('[data-tab]'))b.addEventListener('click',()=>{for(const x of detail.querySelectorAll('[data-tab]'))x.classList.toggle('active',x===b);for(const p of detail.querySelectorAll('[data-panel]'))p.classList.toggle('active',p.dataset.panel===b.dataset.tab);});}
    function fillChecklist(c){if(!c)return;for(const el of detail.querySelectorAll('[data-check]'))el.checked=!!c[el.dataset.check];document.getElementById('checkOverrideReason').value=c.overrideReason||'';document.getElementById('checklistResult').textContent='saved';}
    async function saveChecklist(id){const body={};for(const el of detail.querySelectorAll('[data-check]'))body[el.dataset.check]=el.checked;body.overrideReason=document.getElementById('checkOverrideReason').value;const data=await api('/api/product-drafts/'+id+'/registration-checklist',{method:'PUT',body:JSON.stringify(body)});fillChecklist(data.checklist);}
    function fillNaverResearch(r){if(!r)return;document.getElementById('naverKeyword').value=r.keyword||'';renderNaverResearchResult(r);renderNaverBestItem(r);}
    async function refreshNaver(id){const data=await api('/api/product-drafts/'+id+'/market-research/naver/refresh',{method:'POST',body:JSON.stringify({keyword:document.getElementById('naverKeyword').value})});fillNaverResearch(data.research);await loadList();}
    async function generateOptimization(id){const data=await api('/api/product-drafts/'+id+'/registration-optimization',{method:'POST',body:'{}'});renderOptimization(data.optimization);await loadDetail(id,false);}
    async function runSeoAnalysis(id){const data=await api('/api/product-drafts/'+id+'/seo-analysis',{method:'POST',body:'{}'});renderOptimization(data.optimization);await loadDetail(id,false);}
    async function regenerateOptimizedTitles(id){const data=await api('/api/product-drafts/'+id+'/optimized-titles',{method:'POST',body:'{}'});renderOptimization(data.optimization);await loadDetail(id,false);}
    async function saveOptimizedTitles(id){await api('/api/product-drafts/'+id,{method:'PATCH',body:JSON.stringify({optimizedCoupangTitle:document.getElementById('optimizedCoupangTitle').value,optimizedNaverTitle:document.getElementById('optimizedNaverTitle').value})});await loadDetail(id,false);}
    async function copyTitle(id){const text=document.getElementById(id).value;if(navigator.clipboard&&navigator.clipboard.writeText){await navigator.clipboard.writeText(text);return;}const area=document.createElement('textarea');area.value=text;document.body.appendChild(area);area.select();document.execCommand('copy');area.remove();}
    function toggleOriginalDetailImages(){const button=document.getElementById('toggleOriginalDetailButton');const include=button.dataset.includeOriginal!=='false';button.dataset.includeOriginal=include?'false':'true';button.textContent=include?'원본 상세 이미지 제외':'원본 상세 이미지 포함';}
    function refreshDetailPreview(){document.getElementById('preview').srcdoc=document.getElementById('generatedDetailHtml').value;}
    async function regenerateGeneratedDetail(id){const include=document.getElementById('toggleOriginalDetailButton')?.dataset.includeOriginal!=='false';const data=await api('/api/product-drafts/'+id+'/generated-detail-html',{method:'POST',body:JSON.stringify({includeOriginalDetailImages:include})});document.getElementById('generatedDetailHtml').value=data.draft.generatedDetailHtml||'';refreshDetailPreview();await loadDetail(id,false);}
    function renderOptimization(o){if(!o)return;const seo=o.seo&&o.seo[0];document.getElementById('seoResult').innerHTML=seo?'<div>baseKeyword='+escapeHtml(seo.baseKeyword||'')+'</div><div>extracted='+(seo.extractedKeywords||seo.generatedKeywords||[]).map(x=>'<span class="badge">'+escapeHtml(x)+'</span>').join('')+'</div><div>selected='+(seo.selectedKeywords||[]).map(x=>'<span class="badge">'+escapeHtml(x)+'</span>').join('')+'</div><div>forbidden='+(seo.forbiddenKeywords||[]).map(x=>'<span class="badge reasonBlock">'+escapeHtml(x)+'</span>').join('')+'</div><div>naverTopTitles=<ol>'+(seo.naverTopTitles||[]).map(x=>'<li>'+escapeHtml(x)+'</li>').join('')+'</ol></div>':'No SEO analysis';const titlePanel=detail.querySelector('[data-panel="title"]');if(titlePanel){titlePanel.innerHTML='<div class="section"><h2>상품명</h2><label>쿠팡 최적화 상품명</label><input id="optimizedCoupangTitle" value="'+attr(o.titles.optimizedCoupangTitle||'')+'"><label>네이버 최적화 상품명</label><input id="optimizedNaverTitle" value="'+attr(o.titles.optimizedNaverTitle||'')+'"><p><button id="regenerateTitleButton">상품명 재생성</button> <button id="saveTitlesButton">상품명 저장</button> <button id="copyCoupangTitleButton">쿠팡 상품명 복사</button> <button id="copyNaverTitleButton">네이버 상품명 복사</button></p><div>'+(o.titles.titleWarnings||[]).map(x=>'<span class="badge reasonReview">'+escapeHtml(x)+'</span>').join('')+'</div></div>';document.getElementById('regenerateTitleButton').addEventListener('click',()=>regenerateOptimizedTitles(selectedId));document.getElementById('saveTitlesButton').addEventListener('click',()=>saveOptimizedTitles(selectedId));document.getElementById('copyCoupangTitleButton').addEventListener('click',()=>copyTitle('optimizedCoupangTitle'));document.getElementById('copyNaverTitleButton').addEventListener('click',()=>copyTitle('optimizedNaverTitle'));}document.getElementById('imagePromptResult').textContent=JSON.stringify(o.imagePrompts,null,2);document.getElementById('categoryResult').textContent=o.category?JSON.stringify(o.category,null,2):'No category candidate';document.getElementById('noticeResult').textContent=JSON.stringify(o.notice||[],null,2);document.getElementById('shippingResult').textContent=JSON.stringify(o.shippingPolicies||[],null,2);}
    function renderNaverResearchResult(r){document.getElementById('naverResearchResult').innerHTML='lowest='+money(r.lowestPrice)+' / avg='+money(r.topPriceAvg)+' / competitors='+money(r.competitorCount)+' / gap='+percent(r.priceGapRate)+' / winnerScore='+r.winnerScore+' / winnerStatus='+escapeHtml(labelWinner(r.winnerStatus))+'<br>'+(r.reasons||[]).map(x=>'<span class="badge">'+escapeHtml(x)+'</span>').join('');}
    function renderNaverBestItem(r){const best=r.bestItem||(r.raw&&r.raw.bestItem);const target=document.getElementById('naverBestItem');if(!best){target.innerHTML='<p class="muted">네이버 최저가 상품 정보 없음</p>';return;}target.innerHTML='<table><tbody><tr><th>네이버 최저가 상품명</th><td>'+escapeHtml(stripTags(best.title||''))+'</td></tr><tr><th>쇼핑몰</th><td>'+escapeHtml(best.mallName||'')+'</td></tr><tr><th>가격</th><td>'+money(best.lprice)+'</td></tr><tr><th>링크</th><td><a href="'+attr(best.link||'#')+'" target="_blank" rel="noopener noreferrer"><button>네이버최저가</button></a></td></tr></tbody></table>';}
    async function api(path,options={}){const response=await fetch(path,{headers:{'content-type':'application/json'},...options});const data=await response.json();if(!response.ok)throw new Error(data.error||'Request failed');return data;}
    function reasonBadges(reasons){return(reasons||[]).map(x=>'<span class="badge">'+escapeHtml(x)+'</span>')}function money(v){return v==null?'-':Number(v).toLocaleString('ko-KR')}function moneyWithRate(v,r){return money(v)+(r==null?'':'<br><span class="muted">'+Math.round(Number(r)*100)+'%</span>')}function percent(v){return v==null?'-':Math.round(Number(v)*1000)/10+'%'}function rocketLabel(v){if(v===true)return'Yes';if(v===false)return'No';return'-'}function labelStatus(v){return({draft:'Draft',pass:'Pass',needs_review:'Needs review',blocked:'Blocked',approved:'Approved'})[v]||v||'-'}function labelWinner(v){return({strong_candidate:'Strong',candidate:'Candidate',needs_review:'Needs review',reject:'Reject'})[v]||v||'-'}function labelMarket(v){return({domeme:'도매매',domeggook:'도매꾹',unknown:'unknown'})[v]||v||'unknown'}function labelSellUnit(v){return({single:'단품',bundle:'묶음'})[v]||v||'-'}function stripTags(v){return String(v??'').replace(/<[^>]*>/g,'')}function escapeHtml(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}function attr(v){return escapeHtml(v)}
    async function loadImagePrompts(id){const data=await api('/api/product-drafts/'+id+'/image-prompts');const panel=detail.querySelector('[data-panel="image"]');if(!panel)return;const card=(type,label)=>{const r=(data.requests||[]).find(x=>x.requestType===type);const original=r?escapeHtml(r.promptOriginal):'';const rendered=r?escapeHtml(r.promptRendered):'';const warnings=(r?.warnings||[]).map(x=>'<span class="badge reasonReview">'+escapeHtml(x)+'</span>').join('');return '<div class="section"><h2>'+label+'</h2><p><button data-prompt-generate="'+type+'">프롬프트 생성</button> <button data-prompt-copy="'+type+'">복사</button> <button data-prompt-status="approved" data-prompt-type="'+type+'">승인</button> <button data-prompt-status="rejected" data-prompt-type="'+type+'">거절</button></p><label>원문 템플릿</label><pre data-prompt-original="'+type+'">'+original+'</pre><label>상품정보 치환 후 최종 프롬프트</label><pre data-prompt-rendered="'+type+'">'+rendered+'</pre><div>'+warnings+'</div></div>';};panel.innerHTML='<h2>AI 이미지 프롬프트</h2>'+card('main_image','대표이미지 프롬프트')+card('detail_page','상세페이지 프롬프트');for(const b of panel.querySelectorAll('[data-prompt-generate]'))b.addEventListener('click',async()=>{await api('/api/product-drafts/'+id+'/image-prompts/'+b.dataset.promptGenerate,{method:'POST',body:'{}'});await loadImagePrompts(id);});for(const b of panel.querySelectorAll('[data-prompt-status]'))b.addEventListener('click',async()=>{await api('/api/product-drafts/'+id+'/image-prompts/'+b.dataset.promptType,{method:'PATCH',body:JSON.stringify({status:b.dataset.promptStatus})});await loadImagePrompts(id);});for(const b of panel.querySelectorAll('[data-prompt-copy]'))b.addEventListener('click',()=>copyText(panel.querySelector('[data-prompt-rendered="'+b.dataset.promptCopy+'"]').textContent));}
    async function copyText(text){if(navigator.clipboard?.writeText)return navigator.clipboard.writeText(text);const area=document.createElement('textarea');area.value=text;document.body.appendChild(area);area.select();document.execCommand('copy');area.remove();}
    document.addEventListener('click',event=>{if(event.target?.dataset?.tab==='image'&&selectedId)loadImagePrompts(selectedId);});
  </script>
</body>
</html>`;
}





