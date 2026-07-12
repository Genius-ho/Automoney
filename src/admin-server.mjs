import http from 'node:http';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

import { loadAiSecrets, loadDatabaseUrl, loadNaverConfig } from './config.mjs';
import { clearProviderCredential, listProviderSettings, listTaskRouting, saveProviderSetting, saveTaskRouting, testProviderSetting } from './ai/provider-settings-store.mjs';
import { NaverShoppingClient } from './naver-shopping-client.mjs';
import { researchNaverDraft } from './naver-research.mjs';
import { createPgPool, runSchema } from './postgres-store.mjs';
import { isAllowedPublicAssetPath } from './public-assets.mjs';
import { buildMainImagePackage } from './manual-ai/package-builder.mjs';
import { buildDetailPagePackage } from './manual-ai/detail-package-builder.mjs';
import { createCoupangDerivative, validateManualMainImage } from './manual-ai/image-processing.mjs';
import { assertDetailSetAggregate, createDetailRegistrationJpeg, validateDetailSourceImage } from './manual-ai/detail-image-processing.mjs';
import { finalizeDetailSetDirectory, receiveDetailMultipart, removeDetailSetDirectory } from './manual-ai/detail-multipart.mjs';
import { persistManualMainImageFiles, readManualImageMultipart } from './manual-ai/multipart.mjs';
import { validateManualDetailWorkflowMetadata, validateManualWorkflowMetadata } from './manual-ai/workflow-service.mjs';
import { approveManualMainImage, getNextManualMainImageVersion, insertManualMainImage, listManualMainImages, rejectManualMainImage } from './manual-ai/workflow-store.mjs';
import { approveManualDetailSet, insertDetailSet, listManualDetailSets, rejectManualDetailSet, reserveDetailSetVersion } from './manual-ai/detail-workflow-store.mjs';
import {
  exportProductDraft,
  analyzeSeoKeywords,
  buildDebugExport,
  createImagePromptRequest,
  generateRegistrationOptimization,
  getRegistrationOptimization,
  getRegistrationChecklist,
  getMarketResearch,
  getImagePromptRequests,
  getManualMainImageWorkflowContext,
  getManualDetailWorkflowContext,
  getProductDraft,
  listProductDrafts,
  regenerateOptimizedTitles,
  regenerateGeneratedDetailHtml,
  regenerateImagePromptRequest,
  setProductDraftStatus,
  setImagePromptRequestStatus,
  updateProductDraft,
  updateRegistrationChecklist,
  upsertMarketResearch,
} from './admin-store.mjs';

export function renderHtmlDetailSection(draft) {
  const html = String(draft.generatedDetailHtml || '');
  return `<div class="section"><h2>HTML 상세페이지 v2</h2><p class="muted">현재 판매 등록용 HTML 상세페이지입니다.</p><div class="muted">HTML ${html ? '있음' : '없음'} / 길이 ${html.length}</div><label>상세페이지 HTML 수정</label><textarea id="generatedDetailHtml">${escapeHtmlForSection(html)}</textarea><p><button class="primary" id="saveButton">Save</button> <button id="regenerateDetailButton" type="button">상세페이지 재생성</button> <button id="toggleOriginalDetailButton" type="button" data-include-original="true">원본 상세 이미지 포함</button> <button id="refreshPreviewButton" type="button">미리보기 새로고침</button></p><iframe id="preview"></iframe></div>`;
}

export function renderManualMainImageWorkflowSection({request={},sourceMainImage=null,results=[]}={}){
  results=[...results].sort((a,b)=>Number(b.version)-Number(a.version));const latest=results[0]||null,options=results.map((item)=>`<button type="button" data-manual-version="${Number(item.version)}">v${Number(item.version)} ${escapeHtmlForSection(item.status||'')}</button>`).join(' '),empty=latest?'':`<p class="muted" data-manual-empty>아직 업로드된 외부 AI 생성 이미지가 없습니다.</p>`;
  return `<div class="section" data-manual-main-image-workflow><h3>외부 AI 대표이미지 반수동 작업</h3><p><a data-manual-package href="#">작업 패키지 다운로드</a> <button type="button" data-copy-rendered>치환 프롬프트 복사</button> <button type="button" data-copy-original>원문 프롬프트 복사</button></p><div data-copy-feedback></div><form data-manual-upload enctype="multipart/form-data"><input type="file" name="image" accept="image/png,image/jpeg,image/webp"><select name="providerCode"><option value="chatgpt">ChatGPT</option><option value="google_gemini">Google Gemini</option><option value="anthropic_claude">Anthropic Claude</option><option value="custom">Custom / 기타</option></select><input name="providerDisplayName" placeholder="Custom 공급자 이름"><textarea name="notes" placeholder="사용자 메모"></textarea><input type="hidden" name="promptRequestId" value="${Number(request.id)||''}"><input type="hidden" name="promptRevision" value="${Number(request.revision)||1}"><button type="submit">외부 AI 결과 업로드</button></form><div data-manual-comparison><div><h4>원본 대표이미지</h4>${sourceMainImage?.url?`<img src="${escapeHtmlForSection(sourceMainImage.url)}" alt="원본 대표이미지">`:''}</div><div><h4>외부 AI 생성 이미지</h4>${latest?`<img src="${escapeHtmlForSection(latest.coupangStoredUrl||'')}" alt="외부 AI 생성 이미지"><p>version ${Number(latest.version)} / ${escapeHtmlForSection(latest.providerDisplayName||latest.providerCode||'')} / ${escapeHtmlForSection(latest.status||'')}</p>`:empty}</div></div><div data-manual-history>${options}</div><p><button type="button" data-manual-approve ${latest?'':'disabled'}>업로드 결과 승인</button> <button type="button" data-manual-reject ${latest?'':'disabled'}>업로드 결과 거절</button></p><div data-manual-message></div></div>`;
}

function escapeHtmlForSection(value) { return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); }

export async function createAdminServer({ rootDir = process.cwd() } = {}) {
  const databaseUrl = await loadDatabaseUrl(rootDir);
  const aiSecrets = await loadAiSecrets(rootDir);
  const db = await createPgPool(databaseUrl);
  await runSchema(db);

  const server = http.createServer((request, response) => {
    handleRequest({ request, response, db, aiSecrets, rootDir }).catch((error) => {
      sendJson(response, 500, { error: error.message || String(error) });
    });
  });

  server.on('close', () => {
    db.end().catch(() => {});
  });

  return server;
}

async function handleRequest({ request, response, db, aiSecrets, rootDir }) {
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
  const providerOptions={environment:aiSecrets,masterKey:aiSecrets.AUTOMONEY_CREDENTIAL_MASTER_KEY};
  if(url.pathname==='/api/settings/ai-providers'&&request.method==='GET'){sendJson(response,200,await listProviderSettings(db,providerOptions));return;}
  const providerMatch=url.pathname.match(/^\/api\/settings\/ai-providers\/(openai|google|anthropic|custom)$/);
  if(providerMatch&&request.method==='POST'){try{sendJson(response,200,{provider:await saveProviderSetting(db,providerMatch[1],await readJson(request),providerOptions)});}catch(error){sendJson(response,error.code==='CREDENTIAL_CONFIGURATION_ERROR'?422:400,{error:error.message,code:error.code});}return;}
  const credentialMatch=url.pathname.match(/^\/api\/settings\/ai-providers\/(openai|google|anthropic|custom)\/credential$/);
  if(credentialMatch&&request.method==='DELETE'){if(url.searchParams.get('confirm')!=='true'){sendJson(response,409,{error:'confirm=true is required'});return;}await clearProviderCredential(db,credentialMatch[1]);sendJson(response,200,{cleared:true});return;}
  const providerTestMatch=url.pathname.match(/^\/api\/settings\/ai-providers\/(openai|google|anthropic|custom)\/test$/);
  if(providerTestMatch&&request.method==='POST'){sendJson(response,409,{error:'Provider connection tests are disabled while the manual external AI workflow is active',code:'MANUAL_WORKFLOW_ACTIVE'});return;}
  if(url.pathname==='/api/settings/ai-task-routing'&&request.method==='GET'){sendJson(response,200,await listTaskRouting(db));return;}
  if(url.pathname==='/api/settings/ai-task-routing'&&request.method==='POST'){try{sendJson(response,200,await saveTaskRouting(db,await readJson(request)));}catch(error){sendJson(response,422,{error:error.message,code:error.code});}return;}
  const manualPackageMatch=url.pathname.match(/^\/api\/product-drafts\/(\d+)\/ai-workflows\/main-image\/package$/);
  if(manualPackageMatch&&request.method==='GET'){try{const context=await getManualMainImageWorkflowContext(db,Number(manualPackageMatch[1]));const result=await buildMainImagePackage(context,{fetchImpl:(value)=>fetchWorkflowAsset(value,rootDir)});sendBinary(response,200,result.buffer,'application/zip',result.filename);}catch(error){sendWorkflowError(response,error);}return;}
  const manualResultsMatch=url.pathname.match(/^\/api\/product-drafts\/(\d+)\/ai-workflows\/main-image\/results$/);
  if(manualResultsMatch&&request.method==='GET'){sendJson(response,200,{results:await listManualMainImages(db,Number(manualResultsMatch[1]))});return;}
  const manualUploadMatch=url.pathname.match(/^\/api\/product-drafts\/(\d+)\/ai-workflows\/main-image\/upload$/);
  if(manualUploadMatch&&request.method==='POST'){const draftId=Number(manualUploadMatch[1]);let stored=null;try{const context=await getManualMainImageWorkflowContext(db,draftId);const {image,fields}=await readManualImageMultipart(request);const metadata=validateManualWorkflowMetadata(context,fields);const validated=await validateManualMainImage(image.buffer,image.mimeType);const derivative=await createCoupangDerivative(image.buffer);const version=await getNextManualMainImageVersion(db,draftId);stored=await persistManualMainImageFiles({rootDir,draftId,revision:metadata.promptRevision,version,original:{buffer:image.buffer,mimeType:validated.mimeType},derivative});const result=await insertManualMainImage(db,{productDraftId:draftId,promptRequestId:metadata.promptRequestId,promptRevision:metadata.promptRevision,providerCode:metadata.providerCode,providerDisplayName:metadata.providerDisplayName,version,...stored,originalFileSize:validated.fileSize,coupangFileSize:derivative.fileSize,originalMimeType:validated.mimeType,originalWidth:validated.width,originalHeight:validated.height,sha256:createHash('sha256').update(image.buffer).digest('hex'),notes:metadata.notes});sendJson(response,201,{result});}catch(error){if(stored)await removeWorkflowFiles(rootDir,stored);sendWorkflowError(response,error);}return;}
  const manualActionMatch=url.pathname.match(/^\/api\/product-drafts\/(\d+)\/ai-workflows\/main-image\/results\/(\d+)\/(approve|reject)$/);
  if(manualActionMatch&&request.method==='POST'){try{const body=await readJson(request);const [draftId,imageId]=manualActionMatch.slice(1,3).map(Number);const result=manualActionMatch[3]==='approve'?await approveManualMainImage(db,draftId,imageId,body.approvalNote||null):await rejectManualMainImage(db,draftId,imageId,body.notes||null);sendJson(response,200,{result});}catch(error){sendWorkflowError(response,error);}return;}
  const detailPackageMatch=url.pathname.match(/^\/api\/product-drafts\/(\d+)\/ai-workflows\/detail-page\/package$/);
  if(detailPackageMatch&&request.method==='GET'){try{const context=await getManualDetailWorkflowContext(db,Number(detailPackageMatch[1]));const result=await buildDetailPagePackage(context,{fetchImpl:(value)=>fetchWorkflowAsset(value,rootDir),readLocalAsset:(value)=>readWorkflowAsset(value,rootDir)});sendBinary(response,200,result.buffer,'application/zip',result.filename);}catch(error){sendWorkflowError(response,error);}return;}
  const detailResultsMatch=url.pathname.match(/^\/api\/product-drafts\/(\d+)\/ai-workflows\/detail-page\/results$/);
  if(detailResultsMatch&&request.method==='GET'){sendJson(response,200,{sets:await listManualDetailSets(db,Number(detailResultsMatch[1]))});return;}
  const detailUploadMatch=url.pathname.match(/^\/api\/product-drafts\/(\d+)\/ai-workflows\/detail-page\/upload$/);
  if(detailUploadMatch&&request.method==='POST'){try{const result=await uploadManualDetailSet({db,request,rootDir,draftId:Number(detailUploadMatch[1])});sendJson(response,201,{set:result});}catch(error){sendWorkflowError(response,error);}return;}
  const detailActionMatch=url.pathname.match(/^\/api\/product-drafts\/(\d+)\/ai-workflows\/detail-page\/sets\/(\d+)\/(approve|reject)$/);
  if(detailActionMatch&&request.method==='POST'){try{const body=await readJson(request);const [draftId,setId]=detailActionMatch.slice(1,3).map(Number);const result=detailActionMatch[3]==='approve'?await approveManualDetailSet(db,draftId,setId,body.approvalNote||null):await rejectManualDetailSet(db,draftId,setId,body.notes||null);sendJson(response,200,{result});}catch(error){sendWorkflowError(response,error);}return;}
  const debugExportMatch = url.pathname.match(/^\/api\/product-drafts\/(\d+)\/debug-export$/);
  if (debugExportMatch && request.method === 'GET') { const value=await buildDebugExport(db,Number(debugExportMatch[1])); if(!value) sendJson(response,404,{error:'Product draft not found'}); else sendJson(response,200,value); return; }

  const imagePromptMatch = url.pathname.match(/^\/api\/product-drafts\/(\d+)\/image-prompts\/(main_image|detail_page)$/);
  if (imagePromptMatch) {
    const [, id, requestType] = imagePromptMatch;
    if (request.method === 'POST') { const result = await createImagePromptRequest(db, Number(id), requestType); if (!result) sendJson(response, 404, { error: 'Product draft not found' }); else sendJson(response, result.created ? 201 : 200, result); return; }
    if (request.method === 'PATCH') { const body = await readJson(request); const requestData = await setImagePromptRequestStatus(db, Number(id), requestType, body.status); if (!requestData) sendJson(response, 404, { error: 'Image prompt request not found' }); else sendJson(response, 200, { request: requestData }); return; }
    sendJson(response, 405, { error: 'Method not allowed' }); return;
  }
  const imagePromptRegenerateMatch = url.pathname.match(/^\/api\/product-drafts\/(\d+)\/image-prompts\/(main_image|detail_page)\/regenerate$/);
  if (imagePromptRegenerateMatch && request.method === 'POST') { try { const body=await readJson(request); const result=await regenerateImagePromptRequest(db,Number(imagePromptRegenerateMatch[1]),imagePromptRegenerateMatch[2],{confirm:body.confirm===true}); sendJson(response,200,result); } catch(error) { if(error.code==='CONFIRM_REQUIRED') sendJson(response,409,{error:error.message}); else throw error; } return; }
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

function sendBinary(response,status,body,contentTypeValue,filename){response.writeHead(status,{'content-type':contentTypeValue,'content-disposition':`attachment; filename="${filename}"`,'content-length':body.length,'cache-control':'no-store'});response.end(body);}

function sendWorkflowError(response,error){const statuses={DRAFT_NOT_FOUND:404,MAIN_IMAGE_PROMPT_MISSING:409,MAIN_IMAGE_PROMPT_STALE:409,MAIN_IMAGE_PROMPT_INVALID:422,SOURCE_MAIN_IMAGE_MISSING:409,DETAIL_PAGE_PROMPT_MISSING:409,DETAIL_PAGE_PROMPT_STALE:409,DETAIL_PAGE_PROMPT_INVALID:422,DETAIL_PACKAGE_IMAGES_MISSING:409,PROMPT_REQUEST_MISMATCH:409,PROMPT_REVISION_MISMATCH:409,MANUAL_IMAGE_NOT_FOUND:404,MANUAL_DETAIL_SET_NOT_FOUND:404,UPLOAD_TOO_LARGE:413,IMAGE_TOO_LARGE:413,UNSUPPORTED_IMAGE_FORMAT:415,IMAGE_MIME_MISMATCH:415,CORRUPT_IMAGE:422,IMAGE_DIMENSIONS_INVALID:422,IMAGE_PIXELS_INVALID:422,IMAGE_NOT_SQUARE:422,DERIVATIVE_TOO_LARGE:422,DETAIL_IMAGE_COUNT_INVALID:422,DETAIL_IMAGE_OPTIMIZATION_FAILED:422,DETAIL_IMAGE_AGGREGATE_TOO_LARGE:422,DETAIL_IMAGE_AGGREGATE_INVALID:422};const payload={error:error.message||String(error),code:error.code||'MANUAL_WORKFLOW_ERROR'};for(const key of ['expectedCount','receivedCount','imageIndex','maxFileSize','maxRequestSize','totalFileSize'])if(error[key]!==undefined)payload[key]=error[key];sendJson(response,statuses[error.code]||400,payload);}

async function fetchWorkflowAsset(value,rootDir){if(/^https?:\/\//i.test(value))return fetch(value);const publicRoot=resolve(rootDir,'public'),filePath=resolve(join(publicRoot,String(value).replace(/^\/+/,'')));if(!filePath.startsWith(publicRoot))return{ok:false,status:403};try{const body=await readFile(filePath);return{ok:true,status:200,arrayBuffer:async()=>body,headers:new Headers({'content-type':contentType(filePath)})};}catch{return{ok:false,status:404};}}
async function readWorkflowAsset(value,rootDir){const publicRoot=resolve(rootDir,'public'),filePath=resolve(join(publicRoot,String(value).replace(/^\/+/,'')));if(!filePath.startsWith(publicRoot))throw Object.assign(new Error('Forbidden workflow asset'),{code:'DETAIL_PACKAGE_IMAGES_MISSING'});return readFile(filePath);}
async function removeWorkflowFiles(rootDir,stored){for(const value of [stored.originalStoredUrl,stored.coupangStoredUrl]){const target=resolve(join(rootDir,'public',String(value).replace(/^\/+/,'')));await rm(target,{force:true}).catch(()=>{});}}

async function uploadManualDetailSet({db,request,rootDir,draftId}) {
  const context=await getManualDetailWorkflowContext(db,draftId);
  const received=await receiveDetailMultipart(request,{rootDir,draftId});
  let setVersion=null, revision=null, client=null, finalized=false;
  try {
    const metadata=validateManualDetailWorkflowMetadata(context,received.fields);revision=metadata.promptRevision;
    const processed=[];
    for(const image of received.images){const original=await readFile(image.path);const validated=await validateDetailSourceImage(original,image.mimeType,image.imageIndex);const normalized=await createDetailRegistrationJpeg(original,image.imageIndex);processed.push({image,original,validated,normalized});}
    assertDetailSetAggregate(processed.map((item)=>item.normalized));
    client=db.connect?await db.connect():db;await client.query('BEGIN');setVersion=await reserveDetailSetVersion(client,draftId);
    const rows=[];
    for(const item of processed){const originalExt=item.validated.mimeType==='image/png'?'png':item.validated.mimeType==='image/webp'?'webp':'jpg';const stem=`detail-r${revision}-v${setVersion}-${String(item.image.imageIndex).padStart(2,'0')}`,originalName=`${stem}-original.${originalExt}`,normalizedName=`${stem}-registered.jpg`;await rename(item.image.path,join(received.stagingDir,originalName));await writeFile(join(received.stagingDir,normalizedName),item.normalized.buffer,{flag:'wx'});const relative=`/generated-ai-images/drafts/${draftId}/detail/manual/r${revision}-v${setVersion}`;rows.push({imageIndex:item.image.imageIndex,originalStoredUrl:`${relative}/${originalName}`,normalizedStoredUrl:`${relative}/${normalizedName}`,originalWidth:item.validated.width,originalHeight:item.validated.height,normalizedWidth:item.normalized.width,normalizedHeight:item.normalized.height,originalFileSize:item.validated.fileSize,normalizedFileSize:item.normalized.fileSize,originalMimeType:item.validated.mimeType,normalizedMimeType:'image/jpeg',jpegQuality:item.normalized.jpegQuality,sha256:createHash('sha256').update(item.original).digest('hex')});}
    await finalizeDetailSetDirectory({stagingDir:received.stagingDir,rootDir,draftId,revision,setVersion});finalized=true;
    const result=await insertDetailSet(client,{productDraftId:draftId,promptRequestId:metadata.promptRequestId,promptRevision:revision,providerCode:metadata.providerCode,providerDisplayName:metadata.providerDisplayName,setVersion,sections:context.sections,images:rows,notes:metadata.notes});await client.query('COMMIT');return result;
  } catch(error) {await client?.query('ROLLBACK').catch(()=>{});if(finalized&&setVersion&&revision)await removeDetailSetDirectory({rootDir,draftId,revision,setVersion}).catch(()=>{});throw error;} finally {client?.release?.();if(!finalized)await received.cleanup().catch(()=>{});}
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
  <header><h1>Automoney Admin</h1><span class="muted">Product draft review</span><button id="aiSettingsButton" type="button">AI API 설정</button></header>
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
  <section id="aiSettings" class="detail" hidden><div class="section"><h2>AI API 설정</h2><p class="muted">현재 이미지 생성은 반수동 외부 AI workflow를 사용합니다. API 설정은 향후 자동 생성 기능을 위한 선택 사항입니다.</p><div id="aiProviderCards" class="grid"></div></div><div class="section"><h2>AI 작업별 모델 설정</h2><div id="aiTaskRouting"></div></div></section>
  <script>
    let selectedId=null;let selectedColIndex=null;let selectedRowIndex=null;const rows=document.getElementById('draftRows');const detail=document.getElementById('detail');
    const statusFilter=document.getElementById('statusFilter');const naverWinnerFilter=document.getElementById('naverWinnerFilter');const finalDecisionFilter=document.getElementById('finalDecisionFilter');const batchFilter=document.getElementById('batchFilter');const collectedOnly=document.getElementById('collectedOnly');
    document.getElementById('reloadButton').addEventListener('click',loadList);document.getElementById('naverCandidateButton').addEventListener('click',()=>{naverWinnerFilter.value='candidate';loadList();});statusFilter.addEventListener('change',loadList);naverWinnerFilter.addEventListener('change',loadList);finalDecisionFilter.addEventListener('change',loadList);batchFilter.addEventListener('change',loadList);collectedOnly.addEventListener('change',loadList);
    window.__adminUiDiagnostics=window.__adminUiDiagnostics||{};window.__adminUiDiagnostics.scriptLoaded=true;initColumnResize();loadList();const initialId=new URL(location.href).searchParams.get('draftId');window.__adminUiDiagnostics.initialId=Number(initialId)||null;window.__adminUiDiagnostics.initialLoadDetailCallAttempted=Boolean(initialId);window.__initialLoadPromise=initialId?Promise.resolve(loadDetail(initialId,false)):Promise.resolve();
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
    async function copyText(text){if(navigator.clipboard?.writeText){try{await navigator.clipboard.writeText(text);return}catch{}}const area=document.createElement('textarea');area.value=text;document.body.appendChild(area);area.select();document.execCommand('copy');area.remove();}
    function renderHtmlDetailSection(d){return '<div class="section"><h2>HTML 상세페이지 v2</h2><p class="muted">현재 판매 등록용 HTML 상세페이지입니다.</p><div>HTML '+(d.generatedDetailHtml?'있음':'없음')+' / 길이 '+(d.generatedDetailHtml||'').length+'</div></div>';}
    function renderAiImagePromptSection(d,promptData){const type=promptData?.requestType==='detail_page'?'AI 이미지형 상세페이지 프롬프트':'AI 대표이미지 프롬프트';return '<div class="section"><h2>'+type+'</h2><div class="muted">DOCX 기반 프롬프트만 준비되어 있습니다. 아직 GPT Image로 생성된 이미지는 없습니다.</div></div>';}
    function renderJsonExportSection(draftId){return '<div class="section"><h2>등록 및 디버그 JSON</h2><button data-json-kind="coupang">쿠팡 등록 JSON</button> <button data-json-kind="naver">네이버 등록 JSON</button> <button data-json-kind="debug">내부 디버그 JSON</button></div>';}
    function insertHtmlDetailSection(){const panel=detail.querySelector('[data-panel="detail"]');if(!panel||panel.querySelector('[data-html-detail-helper]'))return;const section=document.createElement('div');section.dataset.htmlDetailHelper='true';section.className='section';section.innerHTML='<h2>HTML 상세페이지 v2</h2><p class="muted">현재 판매 등록용 HTML 상세페이지입니다.</p>';panel.insertBefore(section,panel.firstChild);}
    window.__adminUiDiagnostics=window.__adminUiDiagnostics||{};window.__adminUiDiagnostics.scriptLoaded=true;const ADMIN_CLIENT_VERSION='html-detail-helper-v1';window.__adminUiDiagnostics.clientVersion=ADMIN_CLIENT_VERSION;
  </script>
  <script>
    window.__adminUiDiagnostics=window.__adminUiDiagnostics||{};
    window.__adminUiDiagnostics.scriptLoaded=true;
    window.__adminUiDiagnostics.clientVersion='html-detail-helper-v1';
    const renderAiPromptSectionsBaseV1=renderAiPromptSectionsV1;
    renderAiPromptSectionsV1=async function(id){await renderAiPromptSectionsBaseV1(id);const panel=document.querySelector('#detail [data-panel="image"]');if(!panel)return;const [data,result]=await Promise.all([api('/api/product-drafts/'+id+'/debug-export'),api('/api/product-drafts/'+id+'/ai-workflows/detail-page/results')]);panel.insertAdjacentHTML('beforeend',manualDetailWorkflowHtmlV1(id,data,result.sets||[]));const workflow=panel.querySelector('[data-manual-detail-workflow]'),request=data.imagePromptState?.detailPage?.request||{},latest=(result.sets||[])[0],files=workflow.querySelector('[name="images[]"]'),order=workflow.querySelector('[data-detail-file-order]');const showOrder=()=>{order.innerHTML=[...files.files].map((file,index)=>'<li>'+String(index+1)+'. '+escapeHtml(file.name)+'</li>').join('');};files.onchange=showOrder;workflow.querySelector('[data-detail-copy-rendered]').onclick=async()=>{await copyText(request.promptRendered||'');workflow.querySelector('[data-detail-copy-feedback]').textContent='복사 완료 / revision '+(request.revision||1)+' / expectedImageCount=10 / '+(request.templateHash||'').slice(0,12)};workflow.querySelector('[data-detail-copy-original]').onclick=async()=>{await copyText(request.promptOriginal||'');workflow.querySelector('[data-detail-copy-feedback]').textContent='복사 완료 / revision '+(request.revision||1)+' / expectedImageCount=10 / '+(request.templateHash||'').slice(0,12)};workflow.querySelector('[name="providerCode"]').onchange=e=>workflow.querySelector('[name="providerDisplayName"]').hidden=e.target.value!=='custom';workflow.querySelector('[data-manual-detail-upload]').onsubmit=async event=>{event.preventDefault();if(files.files.length!==10){workflow.querySelector('[data-detail-message]').textContent='상세페이지 이미지는 정확히 10장을 업로드해야 합니다.';return;}const response=await fetch('/api/product-drafts/'+id+'/ai-workflows/detail-page/upload',{method:'POST',body:new FormData(event.target)}),value=await response.json();if(!response.ok){workflow.querySelector('[data-detail-message]').textContent=value.error;return;}await renderAiPromptSectionsV1(id)};workflow.querySelector('[data-detail-approve]').onclick=async()=>{if(latest?.status==='uploaded'){await api('/api/product-drafts/'+id+'/ai-workflows/detail-page/sets/'+latest.id+'/approve',{method:'POST',body:'{}'});await renderAiPromptSectionsV1(id)}};workflow.querySelector('[data-detail-reject]').onclick=async()=>{if(latest?.status==='uploaded'){await api('/api/product-drafts/'+id+'/ai-workflows/detail-page/sets/'+latest.id+'/reject',{method:'POST',body:'{}'});await renderAiPromptSectionsV1(id)}};};
    function renderHtmlDetailSectionV1(d){return '<div class="section" data-html-detail-helper="true"><h2>HTML 상세페이지 v2</h2><p class="muted">현재 판매 등록용 HTML 상세페이지입니다.</p><div>HTML '+((d.generated_detail_html??d.generatedDetailHtml??'')?'있음':'없음')+' / 길이 '+(d.generated_detail_html??d.generatedDetailHtml??'').length+'</div></div>';}
    function insertHtmlDetailSectionV1(d){window.__adminUiDiagnostics.callSiteReached=true;const panel=document.querySelector('#detail [data-panel="detail"]');if(!panel)return;panel.querySelector('[data-html-detail-helper="true"]')?.remove();panel.insertAdjacentHTML('beforeend',renderHtmlDetailSectionV1(d));window.__adminUiDiagnostics.htmlDetailRenderCalls=(window.__adminUiDiagnostics.htmlDetailRenderCalls||0)+1;window.__adminUiDiagnostics.helperOutputInserted=Boolean(panel.querySelector('[data-html-detail-helper="true"]'));}
    const runtimeInitialId=Number(new URL(location.href).searchParams.get('draftId'))||null;
    window.__adminUiDiagnostics.initialId=runtimeInitialId;
    window.__adminUiDiagnostics.initialLoadDetailCallAttempted=Boolean(runtimeInitialId);
    window.__adminUiDiagnostics.loadDetailInvocations=runtimeInitialId?[{draftId:runtimeInitialId,calledAt:new Date().toISOString()}]:[];
    window.__adminUiDiagnostics.actualLoadDetailEntered=Boolean(runtimeInitialId);
    function promptCardV1(kind,label,data){const entry=kind==='main_image'?data.imagePromptState?.mainImage:data.imagePromptState?.detailPage;const r=entry?.request;const t=entry?.template;const warnings=(r?.warnings||[]).map(x=>'<span class="badge reasonReview">'+escapeHtml(x)+'</span>').join(' ');const empty=kind==='detail_page'&&data.generatedAiImageCount===0?'<p class="muted">DOCX 기반 프롬프트만 준비되어 있습니다.<br>아직 GPT Image로 생성된 상세페이지 이미지는 없습니다.</p>':'';return '<div class="section" data-ai-prompt-section="'+kind+'"><h2>'+label+'</h2><div>prompt state: '+(r?'current':'no_request')+' / DOCX: '+escapeHtml(r?.sourceFileName||t?.source_file_name||'-')+' / version '+(r?.templateVersion||'-')+' / hash '+escapeHtml((r?.templateHash||'').slice(0,12)||'-')+' / revision '+(r?.revision||'-')+'</div>'+empty+'<p><button data-prompt-create="'+kind+'">현재 DOCX 템플릿으로 최초 생성</button> <button data-prompt-regenerate="'+kind+'">명시적 재생성</button> <button data-copy-target="original-'+kind+'">원문 복사</button> <button data-copy-target="rendered-'+kind+'">치환본 복사</button> <button data-prompt-status-v1="approved" data-prompt-kind="'+kind+'">승인</button> <button data-prompt-status-v1="rejected" data-prompt-kind="'+kind+'">거절</button></p><label>원문</label><pre data-prompt-text="original-'+kind+'">'+escapeHtml(r?.promptOriginal||'')+'</pre><label>치환본</label><pre data-prompt-text="rendered-'+kind+'">'+escapeHtml(r?.promptRendered||'')+'</pre><div>'+warnings+'</div></div>';}
    function manualWorkflowHtmlV1(id,data,results){const r=data.imagePromptState?.mainImage?.request||{};const source=data.images?.mainImages?.[0]||null;const latest=results[0]||null;const history=results.map(x=>'<button type="button" data-manual-version="'+x.version+'">v'+x.version+' '+escapeHtml(x.status)+'</button>').join(' ');return '<div class="section" data-manual-main-image-workflow><h3>외부 AI 대표이미지 반수동 작업</h3><p><a data-manual-package href="/api/product-drafts/'+id+'/ai-workflows/main-image/package">작업 패키지 다운로드</a> <button type="button" data-copy-rendered>치환 프롬프트 복사</button> <button type="button" data-copy-original>원문 프롬프트 복사</button></p><div data-copy-feedback class="muted"></div><form data-manual-upload enctype="multipart/form-data"><input type="file" name="image" accept="image/png,image/jpeg,image/webp"><select name="providerCode"><option value="chatgpt">ChatGPT</option><option value="google_gemini">Google Gemini</option><option value="anthropic_claude">Anthropic Claude</option><option value="custom">Custom / 기타</option></select><input name="providerDisplayName" placeholder="Custom 공급자 이름"><textarea name="notes" placeholder="사용자 메모"></textarea><input type="hidden" name="promptRequestId" value="'+(r.id||'')+'"><input type="hidden" name="promptRevision" value="'+(r.revision||1)+'"><button type="submit">외부 AI 결과 업로드</button></form><div class="grid" data-manual-comparison><div><h4>원본 대표이미지</h4>'+(source?'<a href="'+attr(source)+'" target="_blank"><img src="'+attr(source)+'" alt="원본 대표이미지"></a>':'<p class="muted">원본 대표이미지 없음</p>')+'</div><div><h4>외부 AI 생성 이미지</h4>'+(latest?'<a href="'+attr(latest.coupangStoredUrl)+'" target="_blank"><img src="'+attr(latest.coupangStoredUrl)+'" alt="외부 AI 생성 이미지"></a><p>version '+latest.version+' / '+escapeHtml(latest.providerDisplayName||latest.providerCode)+' / '+escapeHtml(latest.status)+'</p><p>'+latest.width+'x'+latest.height+' / '+escapeHtml(latest.coupangMimeType||'')+' / '+escapeHtml(latest.createdAt||'')+'</p>':'<p class="muted" data-manual-empty>아직 업로드된 외부 AI 생성 이미지가 없습니다.</p>')+'</div></div><div data-manual-history>'+history+'</div><p><button type="button" data-manual-approve '+(latest?'':'disabled')+'>업로드 결과 승인</button> <button type="button" data-manual-reject '+(latest?'':'disabled')+'>업로드 결과 거절</button></p><div data-manual-message class="muted"></div></div>';}
    function manualDetailWorkflowHtmlV1(id,data,sets){const r=data.imagePromptState?.detailPage?.request||{},latest=sets[0]||null,thumbs=(latest?.images||[]).map(x=>'<a href="'+attr(x.normalizedStoredUrl)+'" target="_blank"><img src="'+attr(x.normalizedStoredUrl)+'" alt="'+x.imageIndex+'번 '+escapeHtml(x.sectionLabel)+'"><small>'+x.imageIndex+'. '+escapeHtml(x.sectionLabel)+' / '+x.normalizedWidth+'x'+x.normalizedHeight+'</small></a>').join('');return '<div class="section" data-manual-detail-workflow><h3>외부 AI 상세페이지 이미지 세트</h3><p class="muted">HTML 상세페이지 v2와 반수동 AI 상세페이지 이미지 세트를 병행 관리합니다.</p><p><a href="/api/product-drafts/'+id+'/ai-workflows/detail-page/package">상세페이지 작업 패키지 다운로드</a> <button type="button" data-detail-copy-rendered>상세페이지 치환 프롬프트 복사</button> <button type="button" data-detail-copy-original>상세페이지 원문 프롬프트 복사</button></p><div data-detail-copy-feedback class="muted"></div><form data-manual-detail-upload enctype="multipart/form-data"><input type="file" name="images[]" accept="image/png,image/jpeg,image/webp" multiple required><p class="muted">정확히 10장을 한 번에 선택하세요. 파일명 기준으로 자동 정렬되며, 순서가 다를 때만 썸네일을 드래그해 수정하세요.</p><ol data-detail-file-order></ol><select name="providerCode"><option value="chatgpt">ChatGPT</option><option value="google_gemini">Google Gemini</option><option value="anthropic_claude">Anthropic Claude</option><option value="custom">Custom / 기타</option></select><input name="providerDisplayName" placeholder="Custom 공급자 이름" hidden><textarea name="notes" placeholder="사용자 메모"></textarea><input type="hidden" name="promptRequestId" value="'+(r.id||'')+'"><input type="hidden" name="promptRevision" value="'+(r.revision||1)+'"><button type="submit">상세페이지 이미지 세트 업로드</button></form><div class="grid" data-detail-thumbnails>'+ (thumbs||'<p class="muted">생성된 상세페이지 이미지 세트 없음</p>')+'</div><p>세트 '+(latest?'v'+latest.setVersion+' / '+escapeHtml(latest.status)+' / '+latest.imageCount+'장':'없음')+'</p><p><button type="button" data-detail-approve '+(latest?.status==='uploaded'?'':'disabled')+'>세트 승인</button> <button type="button" data-detail-reject '+(latest?.status==='uploaded'?'':'disabled')+'>세트 거절</button></p><div data-detail-message class="muted"></div></div>';}
    async function renderAiPromptSectionsV1(id){const [data,resultData]=await Promise.all([api('/api/product-drafts/'+id+'/debug-export'),api('/api/product-drafts/'+id+'/ai-workflows/main-image/results')]);const panel=document.querySelector('#detail [data-panel="image"]');if(!panel)return;panel.innerHTML=promptCardV1('main_image','AI 대표이미지 프롬프트',data)+manualWorkflowHtmlV1(id,data,resultData.results||[])+promptCardV1('detail_page','AI 이미지형 상세페이지 프롬프트',data);panel.querySelectorAll('[data-prompt-create]').forEach(b=>b.onclick=async()=>{await api('/api/product-drafts/'+id+'/image-prompts/'+b.dataset.promptCreate,{method:'POST',body:'{}'});await renderAiPromptSectionsV1(id)});panel.querySelectorAll('[data-prompt-regenerate]').forEach(b=>b.onclick=async()=>{await api('/api/product-drafts/'+id+'/image-prompts/'+b.dataset.promptRegenerate+'/regenerate',{method:'POST',body:JSON.stringify({confirm:true})});await renderAiPromptSectionsV1(id)});panel.querySelectorAll('[data-prompt-status-v1]').forEach(b=>b.onclick=async()=>{await api('/api/product-drafts/'+id+'/image-prompts/'+b.dataset.promptKind,{method:'PATCH',body:JSON.stringify({status:b.dataset.promptStatusV1})});await renderAiPromptSectionsV1(id)});panel.querySelectorAll('[data-copy-target]').forEach(b=>b.onclick=()=>copyText(panel.querySelector('[data-prompt-text="'+b.dataset.copyTarget+'"]').textContent));const workflow=panel.querySelector('[data-manual-main-image-workflow]'),request=data.imagePromptState?.mainImage?.request||{},latest=(resultData.results||[])[0];workflow.querySelector('[data-copy-rendered]').onclick=async()=>{await copyText(request.promptRendered||'');workflow.querySelector('[data-copy-feedback]').textContent='복사 완료 / revision '+(request.revision||1)+' / '+(request.templateHash||'').slice(0,12)};workflow.querySelector('[data-copy-original]').onclick=async()=>{await copyText(request.promptOriginal||'');workflow.querySelector('[data-copy-feedback]').textContent='복사 완료 / revision '+(request.revision||1)+' / '+(request.templateHash||'').slice(0,12)};workflow.querySelector('[name="providerCode"]').onchange=e=>workflow.querySelector('[name="providerDisplayName"]').hidden=e.target.value!=='custom';workflow.querySelector('[data-manual-upload]').onsubmit=async event=>{event.preventDefault();const response=await fetch('/api/product-drafts/'+id+'/ai-workflows/main-image/upload',{method:'POST',body:new FormData(event.target)});const value=await response.json();if(!response.ok){workflow.querySelector('[data-manual-message]').textContent=value.error;return}await renderAiPromptSectionsV1(id)};workflow.querySelector('[data-manual-approve]').onclick=async()=>{if(latest){await api('/api/product-drafts/'+id+'/ai-workflows/main-image/results/'+latest.id+'/approve',{method:'POST',body:'{}'});await renderAiPromptSectionsV1(id)}};workflow.querySelector('[data-manual-reject]').onclick=async()=>{if(latest){await api('/api/product-drafts/'+id+'/ai-workflows/main-image/results/'+latest.id+'/reject',{method:'POST',body:'{}'});await renderAiPromptSectionsV1(id)}};}
    function renderJsonExportSectionV1(id){const panel=document.querySelector('#detail [data-panel="export"]');if(!panel)return;panel.innerHTML='<div class="section" data-json-export-section><h2>등록 및 디버그 JSON</h2><p><button data-json-path="export/coupang" data-json-label="쿠팡 등록 JSON">쿠팡 등록 JSON</button> <button data-json-path="export/naver" data-json-label="네이버 등록 JSON">네이버 등록 JSON</button> <button data-json-path="debug-export" data-json-label="내부 디버그 JSON">내부 디버그 JSON</button> <button data-json-copy>복사</button></p><div data-json-selected class="muted">선택 없음</div><pre id="exportPreview"></pre></div>';panel.querySelectorAll('[data-json-path]').forEach(b=>b.onclick=async()=>{try{const value=await api('/api/product-drafts/'+id+'/'+b.dataset.jsonPath);panel.querySelector('[data-json-selected]').textContent=b.dataset.jsonLabel;panel.querySelector('#exportPreview').textContent=JSON.stringify(value,null,2)}catch(error){panel.querySelector('#exportPreview').textContent='HTTP 오류: '+error.message}});panel.querySelector('[data-json-copy]').onclick=()=>copyText(panel.querySelector('#exportPreview').textContent);}
    function collapseImageTechnicalDetailsV1(){document.querySelectorAll('#detail [data-panel="source"] img').forEach(img=>{const card=img.closest('div[style*="display:inline-block"]');if(!card||card.querySelector('details[data-image-technical]'))return;const rows=[...card.querySelectorAll(':scope > .muted')];if(!rows.length)return;const details=document.createElement('details');details.dataset.imageTechnical='true';details.innerHTML='<summary>기술정보 보기</summary>';rows.forEach(row=>details.appendChild(row));card.appendChild(details);});window.__adminUiDiagnostics.imageTechnicalDetailsCollapsed=true;}
    const AI_TASK_LABELS={product_text_generation:'상품 텍스트 생성',product_image_analysis:'상품 이미지 분석',main_image_generation:'대표이미지 생성',main_image_edit:'대표이미지 편집',detail_image_generation:'상세페이지 이미지 생성',generated_image_review:'생성 이미지 검수'};
    function providerCardV1(p){const caps=p.capabilities.map(x=>'<span class="badge">'+escapeHtml(x)+'</span>').join('');const claude=p.providerCode==='anthropic'?'<p class="muted">현재 이미지 생성 공급자로 사용할 수 없습니다. 텍스트 생성, 이미지 분석, 생성 이미지 검수에 사용할 수 있습니다.</p>':'';return '<form class="section" data-provider-card="'+p.providerCode+'"><h2>'+escapeHtml(p.displayName)+'</h2><div>credential: '+p.credentialSource+' / '+escapeHtml(p.maskedApiKey||'미등록')+' / test: '+escapeHtml(p.lastTestStatus)+'</div>'+claude+'<label><input type="checkbox" name="enabled" style="width:auto" '+(p.enabled?'checked':'')+'> 활성화</label><label>API 키 등록/변경</label><input type="password" name="apiKey" autocomplete="new-password" '+(p.credentialStorageAvailable?'':'disabled placeholder="master key 미설정"')+'><label>Base URL</label><input name="baseUrl" value="'+attr(p.baseUrl||'')+'"><label>기본 text model</label><input name="defaultTextModel" value="'+attr(p.models.text||'')+'"><label>기본 vision model</label><input name="defaultVisionModel" value="'+attr(p.models.vision||'')+'"><label>기본 image model</label><input name="defaultImageModel" value="'+attr(p.models.image||'')+'"><div>'+caps+'</div><p><button type="submit">설정 저장</button> <button type="button" data-provider-test disabled title="반수동 workflow 단계에서는 연결 테스트를 사용하지 않습니다">연결 테스트</button> <button type="button" data-provider-clear>API 키 삭제</button></p><div data-provider-message class="muted"></div></form>';}
    async function loadAiSettingsV1(){const [providerData,routingData]=await Promise.all([api('/api/settings/ai-providers'),api('/api/settings/ai-task-routing')]);aiProviderCards.innerHTML=providerData.providers.map(providerCardV1).join('');const taskCapabilities=routingData.taskCapabilities;const existing=new Map(routingData.routes.map(x=>[x.taskType,x]));aiTaskRouting.innerHTML=Object.keys(taskCapabilities).map(task=>{const route=existing.get(task)||{};const options=providerData.providers.map(p=>{const disabled=!p.capabilities.includes(taskCapabilities[task]);return '<option value="'+p.providerCode+'" '+(route.providerCode===p.providerCode?'selected':'')+' '+(disabled?'disabled':'')+'>'+escapeHtml(p.displayName)+'</option>';}).join('');return '<form class="section" data-task-route="'+task+'"><h2>'+AI_TASK_LABELS[task]+'</h2><label>공급자</label><select name="providerCode">'+options+'</select><label>모델</label><input name="model" value="'+attr(route.model||'')+'"><div class="grid"><label>quality<input name="quality" value="'+attr(route.quality||'')+'"></label><label>size<input name="size" value="'+attr(route.size||'')+'"></label><label>최대 장수<input type="number" name="maxImagesPerRequest" value="'+(route.maxImagesPerRequest||1)+'"></label><label>자동 재시도<input type="number" name="maxRetries" value="'+(route.maxRetries||0)+'"></label></div><label><input type="checkbox" name="enabled" style="width:auto" '+(route.enabled?'checked':'')+'> 활성화</label><label><input type="checkbox" name="fallbackEnabled" style="width:auto" '+(route.fallbackEnabled?'checked':'')+'> 자동 fallback (기본 꺼짐)</label><button type="submit">라우팅 저장</button><span data-route-message class="muted"></span></form>';}).join('');
      aiProviderCards.querySelectorAll('[data-provider-card]').forEach(form=>{const code=form.dataset.providerCard;form.onsubmit=async event=>{event.preventDefault();const fd=new FormData(form);const body={enabled:fd.get('enabled')==='on',apiKey:fd.get('apiKey')||undefined,baseUrl:fd.get('baseUrl')||null,defaultTextModel:fd.get('defaultTextModel')||null,defaultVisionModel:fd.get('defaultVisionModel')||null,defaultImageModel:fd.get('defaultImageModel')||null};try{await api('/api/settings/ai-providers/'+code,{method:'POST',body:JSON.stringify(body)});await loadAiSettingsV1()}catch(error){form.querySelector('[data-provider-message]').textContent=error.message}};form.querySelector('[data-provider-test]').onclick=async()=>{const result=await api('/api/settings/ai-providers/'+code+'/test',{method:'POST',body:'{}'});form.querySelector('[data-provider-message]').textContent=result.status+': '+result.message};form.querySelector('[data-provider-clear]').onclick=async()=>{if(!confirm('API 키만 삭제하시겠습니까?'))return;await api('/api/settings/ai-providers/'+code+'/credential?confirm=true',{method:'DELETE'});await loadAiSettingsV1()};});
      aiTaskRouting.querySelectorAll('[data-task-route]').forEach(form=>form.onsubmit=async event=>{event.preventDefault();const fd=new FormData(form);try{await api('/api/settings/ai-task-routing',{method:'POST',body:JSON.stringify({taskType:form.dataset.taskRoute,providerCode:fd.get('providerCode'),model:fd.get('model')||null,quality:fd.get('quality')||null,size:fd.get('size')||null,maxImagesPerRequest:Number(fd.get('maxImagesPerRequest')||1),maxRetries:Number(fd.get('maxRetries')||0),enabled:fd.get('enabled')==='on',fallbackEnabled:fd.get('fallbackEnabled')==='on'})});form.querySelector('[data-route-message]').textContent=' 저장됨'}catch(error){form.querySelector('[data-route-message]').textContent=' '+error.message}});
    }
    aiSettingsButton.onclick=async()=>{document.querySelector('main').hidden=!document.querySelector('main').hidden;aiSettings.hidden=!aiSettings.hidden;if(!aiSettings.hidden)await loadAiSettingsV1();};
    async function renderDraftEnhancementsV1(id){await window.__initialLoadPromise;const textarea=document.querySelector('#generatedDetailHtml');insertHtmlDetailSectionV1({id,generatedDetailHtml:textarea?.value||''});await renderAiPromptSectionsV1(id);renderJsonExportSectionV1(id);collapseImageTechnicalDetailsV1();window.__adminUiDiagnostics.aiPromptRenderCalls=(window.__adminUiDiagnostics.aiPromptRenderCalls||0)+1;window.__adminUiDiagnostics.jsonExportRenderCalls=(window.__adminUiDiagnostics.jsonExportRenderCalls||0)+1;window.__adminUiDiagnostics.initialLoadDetailResolved=true;}
    if(runtimeInitialId)renderDraftEnhancementsV1(runtimeInitialId).catch(error=>{window.__adminUiDiagnostics.initialLoadDetailRejected={name:error?.name||null,message:error?.message||String(error)};console.error('initial_load_detail_failed',error);});
  </script>
  <script>
    const renderAiPromptSectionsWithDetailOrderV1=renderAiPromptSectionsV1;
    function naturalFileCompare(a,b){return a.name.localeCompare(b.name,undefined,{numeric:true,sensitivity:'base'});}
    renderAiPromptSectionsV1=async function(id){await renderAiPromptSectionsWithDetailOrderV1(id);const files=document.querySelector('[data-manual-detail-workflow] [name="images[]"]'),order=document.querySelector('[data-manual-detail-workflow] [data-detail-file-order]');if(!files||!order)return;let selected=[],objectUrls=[];const setFiles=list=>{const transfer=new DataTransfer();list.forEach(file=>transfer.items.add(file));files.files=transfer.files;};const renderOrder=()=>{objectUrls.forEach(url=>URL.revokeObjectURL(url));objectUrls=[];order.innerHTML=selected.map((file,index)=>{const url=URL.createObjectURL(file);objectUrls.push(url);return '<li draggable="true" data-detail-order="'+index+'" data-detail-filename="'+attr(file.name)+'" title="'+attr(file.name)+'"><img src="'+url+'" alt="'+(index+1)+'번째 이미지" style="width:64px;height:64px;object-fit:cover"><span>'+(index+1)+'</span></li>';}).join('');order.querySelectorAll('[data-detail-order]').forEach(item=>{item.ondragstart=e=>e.dataTransfer.setData('text/plain',item.dataset.detailOrder);item.ondragover=e=>e.preventDefault();item.ondrop=e=>{e.preventDefault();const from=Number(e.dataTransfer.getData('text/plain')),to=Number(item.dataset.detailOrder);if(!Number.isInteger(from)||!Number.isInteger(to)||from===to)return;const reordered=[...selected],moved=reordered.splice(from,1)[0];reordered.splice(to,0,moved);selected=reordered;setFiles(selected);renderOrder();};});};files.onchange=()=>{selected=[...files.files].sort(naturalFileCompare);setFiles(selected);renderOrder();};};
  </script>
</body>
</html>`;
}





