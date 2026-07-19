import http from 'node:http';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

import { loadAiSecrets, loadCodexConfig, loadCoupangConfig, loadDatabaseUrl, loadJobPathsConfig, loadNaverConfig, loadPythonConfig, loadR2Config } from './config.mjs';
import { R2Client } from './r2-client.mjs';
import { clearProviderCredential, listProviderSettings, listTaskRouting, saveProviderSetting, saveTaskRouting, testProviderSetting } from './ai/provider-settings-store.mjs';
import { NaverShoppingClient } from './naver-shopping-client.mjs';
import { researchNaverDraft } from './naver-research.mjs';
import { CoupangApiError, CoupangClient } from './coupang-client.mjs';
import { buildImageOnlyFragments, mapLiveProductToUpdatePayload } from './coupang-payload-builder.mjs';
import { getApprovedManualMainImage } from './manual-ai/workflow-store.mjs';
import { getApprovedManualDetailSet } from './manual-ai/detail-workflow-store.mjs';
import { getCoupangRegistration, linkCoupangRegistration, listCoupangRegistrations, recordImagesSwapped, recordLiveSnapshot } from './coupang-registration-store.mjs';
import { applyProductAnalysis, buildApplyPreview, getAppliedAnalysis, getAnalysisRun, getLatestAnalysisRun, listAnalysisRuns, runProductAnalysis } from './product-analysis-orchestrator.mjs';
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
  if(manualPackageMatch&&request.method==='GET'){try{const draftId=Number(manualPackageMatch[1]);await createImagePromptRequest(db,draftId,'main_image');const context=await getManualMainImageWorkflowContext(db,draftId);const result=await buildMainImagePackage(context,{fetchImpl:(value)=>fetchWorkflowAsset(value,rootDir)});sendBinary(response,200,result.buffer,'application/zip',result.filename);}catch(error){sendWorkflowError(response,error);}return;}
  const manualResultsMatch=url.pathname.match(/^\/api\/product-drafts\/(\d+)\/ai-workflows\/main-image\/results$/);
  if(manualResultsMatch&&request.method==='GET'){sendJson(response,200,{results:await listManualMainImages(db,Number(manualResultsMatch[1]))});return;}
  const manualUploadMatch=url.pathname.match(/^\/api\/product-drafts\/(\d+)\/ai-workflows\/main-image\/upload$/);
  if(manualUploadMatch&&request.method==='POST'){const draftId=Number(manualUploadMatch[1]);let stored=null;try{const context=await getManualMainImageWorkflowContext(db,draftId);const {image,fields}=await readManualImageMultipart(request);const metadata=validateManualWorkflowMetadata(context,fields);const validated=await validateManualMainImage(image.buffer,image.mimeType);const derivative=await createCoupangDerivative(image.buffer);const version=await getNextManualMainImageVersion(db,draftId);stored=await persistManualMainImageFiles({rootDir,draftId,revision:metadata.promptRevision,version,original:{buffer:image.buffer,mimeType:validated.mimeType},derivative});const result=await insertManualMainImage(db,{productDraftId:draftId,promptRequestId:metadata.promptRequestId,promptRevision:metadata.promptRevision,providerCode:metadata.providerCode,providerDisplayName:metadata.providerDisplayName,version,...stored,originalFileSize:validated.fileSize,coupangFileSize:derivative.fileSize,originalMimeType:validated.mimeType,originalWidth:validated.width,originalHeight:validated.height,sha256:createHash('sha256').update(image.buffer).digest('hex'),notes:metadata.notes});sendJson(response,201,{result});}catch(error){if(stored)await removeWorkflowFiles(rootDir,stored);sendWorkflowError(response,error);}return;}
  const manualActionMatch=url.pathname.match(/^\/api\/product-drafts\/(\d+)\/ai-workflows\/main-image\/results\/(\d+)\/(approve|reject)$/);
  if(manualActionMatch&&request.method==='POST'){try{const body=await readJson(request);const [draftId,imageId]=manualActionMatch.slice(1,3).map(Number);const result=manualActionMatch[3]==='approve'?await approveManualMainImage(db,draftId,imageId,body.approvalNote||null):await rejectManualMainImage(db,draftId,imageId,body.notes||null);sendJson(response,200,{result});}catch(error){sendWorkflowError(response,error);}return;}
  const detailPackageMatch=url.pathname.match(/^\/api\/product-drafts\/(\d+)\/ai-workflows\/detail-page\/package$/);
  if(detailPackageMatch&&request.method==='GET'){try{const draftId=Number(detailPackageMatch[1]);await createImagePromptRequest(db,draftId,'detail_page');const context=await getManualDetailWorkflowContext(db,draftId);const result=await buildDetailPagePackage(context,{fetchImpl:(value)=>fetchWorkflowAsset(value,rootDir),readLocalAsset:(value)=>readWorkflowAsset(value,rootDir)});sendBinary(response,200,result.buffer,'application/zip',result.filename);}catch(error){sendWorkflowError(response,error);}return;}
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

  const registrationsListMatch = url.pathname === '/api/coupang-registrations';
  if (registrationsListMatch && request.method === 'GET') {
    const registrations = await listCoupangRegistrations(db, { onlyLinked: url.searchParams.get('onlyLinked') === 'true' });
    sendJson(response, 200, { registrations });
    return;
  }

  const registrationSingleMatch = url.pathname.match(/^\/api\/product-drafts\/(\d+)\/coupang-registration$/);
  if (registrationSingleMatch && request.method === 'GET') {
    const registration = await getCoupangRegistration(db, Number(registrationSingleMatch[1]));
    sendJson(response, 200, { registration });
    return;
  }

  const registrationLookupMatch = url.pathname.match(/^\/api\/product-drafts\/(\d+)\/coupang-registration\/lookup$/);
  if (registrationLookupMatch && request.method === 'GET') {
    const draftId = Number(registrationLookupMatch[1]);
    const draft = await getProductDraft(db, draftId);
    if (!draft) { sendJson(response, 404, { error: 'Product draft not found' }); return; }
    const name = url.searchParams.get('name') || draft.optimizedCoupangTitle || draft.sellingTitle;
    const config = await loadCoupangConfig(rootDir);
    const client = new CoupangClient(config);
    const result = await client.listSellerProducts({ sellerProductName: name });
    sendJson(response, 200, { name, candidates: result.data || [] });
    return;
  }

  const registrationLinkMatch = url.pathname.match(/^\/api\/product-drafts\/(\d+)\/coupang-registration\/link$/);
  if (registrationLinkMatch && request.method === 'POST') {
    const draftId = Number(registrationLinkMatch[1]);
    const body = await readJson(request);
    if (!body.sellerProductId) { sendJson(response, 400, { error: 'sellerProductId is required' }); return; }
    const registration = await linkCoupangRegistration(db, draftId, { sellerProductId: body.sellerProductId, sellerProductName: body.sellerProductName || null });
    sendJson(response, 200, { registration });
    return;
  }

  const registrationSwapMatch = url.pathname.match(/^\/api\/product-drafts\/(\d+)\/coupang-registration\/swap-images$/);
  if (registrationSwapMatch && request.method === 'POST') {
    const draftId = Number(registrationSwapMatch[1]);
    try {
      const body = await readJson(request);
      const registration = await getCoupangRegistration(db, draftId);
      if (!registration?.sellerProductId) { sendJson(response, 409, { error: 'This draft is not linked to a Coupang sellerProductId yet', code: 'NOT_LINKED' }); return; }
      const mainImage = await getApprovedManualMainImage(db, draftId);
      const detailSet = await getApprovedManualDetailSet(db, draftId);
      if (!mainImage || !detailSet) { sendJson(response, 409, { error: 'Approved main image and/or approved detail-page image set are missing', code: 'IMAGES_NOT_APPROVED' }); return; }
      const { mainImageUrl, detailImageUrls } = await uploadApprovedImagesToR2({
        rootDir,
        draftId,
        mainImageLocalUrl: mainImage.coupangStoredUrl,
        detailImageLocalUrls: detailSet.images.map((image) => image.normalizedStoredUrl),
      });
      const { images, contents } = buildImageOnlyFragments({
        mainImageUrl,
        detailImageUrls,
        detailImageUrlsForImages: detailImageUrls.slice(0, 9),
      });
      const config = await loadCoupangConfig(rootDir);
      const client = new CoupangClient(config);
      const live = await client.getProduct(registration.sellerProductId);
      const payload = mapLiveProductToUpdatePayload(live.data, { images, contents });

      await mkdir(`${rootDir}/artifacts`, { recursive: true });
      await writeFile(`${rootDir}/artifacts/coupang-swap-payload-draft-${draftId}-${Date.now()}.json`, JSON.stringify(payload, null, 2));

      if (body.confirm !== true) { sendJson(response, 200, { dryRun: true, payload }); return; }

      await client.updateProduct(payload);
      await recordImagesSwapped(db, draftId);
      const after = await client.getProduct(registration.sellerProductId);
      sendJson(response, 200, { dryRun: false, before: live.data, after: after.data });
    } catch (error) {
      if (error instanceof CoupangApiError) { sendJson(response, 502, { error: error.message, code: 'COUPANG_API_ERROR', bodyPreview: error.bodyPreview }); return; }
      throw error;
    }
    return;
  }

  const registrationRefreshMatch = url.pathname.match(/^\/api\/product-drafts\/(\d+)\/coupang-registration\/refresh$/);
  if (registrationRefreshMatch && request.method === 'POST') {
    const draftId = Number(registrationRefreshMatch[1]);
    const registration = await getCoupangRegistration(db, draftId);
    if (!registration?.sellerProductId) { sendJson(response, 409, { error: 'This draft is not linked to a Coupang sellerProductId yet', code: 'NOT_LINKED' }); return; }
    const config = await loadCoupangConfig(rootDir);
    const client = new CoupangClient(config);
    const live = await client.getProduct(registration.sellerProductId);
    const items = live.data.items || [];
    const totalStockQuantity = items.reduce((sum, item) => sum + (Number(item.maximumBuyCount) || 0), 0);
    const salePrice = items[0]?.salePrice ?? null;
    const updated = await recordLiveSnapshot(db, draftId, { statusName: live.data.statusName, totalStockQuantity, salePrice, itemSnapshotJson: items });
    sendJson(response, 200, { registration: updated });
    return;
  }

  const analysisRunMatch = url.pathname.match(/^\/api\/product-drafts\/(\d+)\/analysis\/run$/);
  if (analysisRunMatch && request.method === 'POST') {
    const draftId = Number(analysisRunMatch[1]);
    const [codexConfig, pythonConfig, jobPathsConfig] = await Promise.all([loadCodexConfig(rootDir), loadPythonConfig(rootDir), loadJobPathsConfig(rootDir)]);
    const run = await runProductAnalysis({ db, rootDir, draftId, codexConfig, pythonConfig, jobPathsConfig });
    sendJson(response, 200, { run });
    return;
  }

  const analysisRunsMatch = url.pathname.match(/^\/api\/product-drafts\/(\d+)\/analysis\/runs\/(\d+)$/);
  if (analysisRunsMatch && request.method === 'GET') {
    const [, draftIdRaw, runIdRaw] = analysisRunsMatch;
    const draftId = Number(draftIdRaw);
    const run = await getAnalysisRun(db, draftId, Number(runIdRaw));
    if (!run) { sendJson(response, 404, { error: 'Analysis run not found', code: 'ANALYSIS_FILES_MISSING' }); return; }
    const draft = await getProductDraft(db, draftId);
    sendJson(response, 200, { run, applyPreview: buildApplyPreview(run, draft) });
    return;
  }

  const analysisMatch = url.pathname.match(/^\/api\/product-drafts\/(\d+)\/analysis$/);
  if (analysisMatch && request.method === 'GET') {
    const draftId = Number(analysisMatch[1]);
    const [runs, latestRun, applied, draft] = await Promise.all([
      listAnalysisRuns(db, draftId),
      getLatestAnalysisRun(db, draftId),
      getAppliedAnalysis(db, draftId),
      getProductDraft(db, draftId),
    ]);
    if (runs.length === 0) { sendJson(response, 200, { runs: [], latestRun: null, applyPreview: null, applied, code: 'ANALYSIS_FILES_MISSING' }); return; }
    sendJson(response, 200, { runs, latestRun, applyPreview: buildApplyPreview(latestRun, draft), applied });
    return;
  }

  const analysisApplyMatch = url.pathname.match(/^\/api\/product-drafts\/(\d+)\/analysis\/apply$/);
  if (analysisApplyMatch && request.method === 'POST') {
    const draftId = Number(analysisApplyMatch[1]);
    try {
      const body = await readJson(request);
      const result = await applyProductAnalysis(db, draftId, { runId: Number(body.runId), fields: body.fields || {}, forceFields: body.forceFields || [] });
      sendJson(response, 200, result);
    } catch (error) {
      if (error.code === 'RUN_NOT_FOUND' || error.code === 'DRAFT_NOT_FOUND') { sendJson(response, 404, { error: error.message, code: error.code }); return; }
      if (error.code === 'RUN_NOT_APPLICABLE') { sendJson(response, 409, { error: error.message, code: error.code }); return; }
      throw error;
    }
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
      limit: url.searchParams.get('limit') || undefined,
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
    const channel = action.split('/')[1];
    const exportJson = await exportProductDraft(db, Number(id), channel);
    if (!exportJson) { sendJson(response, 404, { error: 'Product draft not found' }); return; }
    // Applied analysis candidates (소재/치수/색상/검색어/고시정보) are surfaced
    // here only -- never written back into the export builder's own fields --
    // so downstream payload scripts can read them without any Coupang API
    // call happening as a side effect of viewing this preview.
    if (channel === 'coupang') exportJson.appliedAnalysis = await getAppliedAnalysis(db, Number(id));
    sendJson(response, 200, exportJson);
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

// Approved main/detail images are served locally by this admin server
// (relative /generated-ai-images/... paths), which Coupang's servers can't
// reach. Coupang's payload needs real public HTTPS URLs, so each image gets
// mirrored to R2 first -- same hash-keyed, dedup-on-reupload approach as
// scripts/coupang-upload-images.mjs, just driven from the DB-approved rows
// instead of a draft export.
async function uploadApprovedImagesToR2({ rootDir, draftId, mainImageLocalUrl, detailImageLocalUrls }) {
  const r2Config = await loadR2Config(rootDir);
  const client = new R2Client(r2Config);
  const upload = async (localUrl) => {
    const buffer = await readWorkflowAsset(localUrl, rootDir);
    const hash = createHash('sha256').update(buffer).digest('hex').slice(0, 16);
    const extension = localUrl.split('.').pop();
    const key = `drafts/${draftId}/coupang/${hash}.${extension}`;
    const existing = await client.headObject(key);
    if (existing) return existing.publicUrl;
    const { publicUrl } = await client.putObject(key, buffer, 'image/jpeg');
    return publicUrl;
  };
  const mainImageUrl = await upload(mainImageLocalUrl);
  const detailImageUrls = [];
  for (const localUrl of detailImageLocalUrls) detailImageUrls.push(await upload(localUrl));
  return { mainImageUrl, detailImageUrls };
}

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
    main[hidden]{display:none}
    .list{border-bottom:1px solid #d8dee7;background:#fff;overflow:hidden;display:flex;flex-direction:column;min-width:0}
    .detail{padding:18px;overflow:auto}.toolbar{display:flex;gap:8px;flex-wrap:wrap;padding:10px 12px;border-bottom:1px solid #d8dee7;background:#fff;flex:0 0 auto;align-items:center}
    .viewNav{display:flex;gap:10px;padding:14px 16px;border-bottom:1px solid #d8dee7;background:#fff;flex:0 0 auto}
    .viewNav button{flex:1 1 0;font-size:16px;font-weight:700;padding:14px 10px;border-radius:4px;border-color:#c7d1dd;color:#374151}
    .viewNav button.primary{background:#1f6feb;color:#fff;border-color:#1f6feb}
    .toolbar select,.toolbar input:not([type=checkbox]){width:auto;min-width:120px;flex:0 0 auto}
    .tableWrap{overflow:auto;flex:1 1 auto} table{border-collapse:collapse;width:max-content;min-width:100%;font-size:12px;table-layout:fixed}
    th,td{border-bottom:1px solid #edf0f4;padding:6px 7px;vertical-align:top;text-align:left;overflow:hidden;text-overflow:ellipsis} th{background:#f9fafb;font-weight:700;position:sticky;top:0;z-index:1;white-space:nowrap;user-select:none}
    td{max-height:44px}.clip{display:block;overflow:hidden;text-overflow:ellipsis}.idCol{width:58px;min-width:44px}.productNoCol{width:98px;min-width:76px}.nameCol{width:260px;min-width:150px;max-width:none}
    .moneyCol{width:82px;min-width:58px;text-align:right;white-space:nowrap}.statusCol{width:88px;min-width:64px}.reasonCol{width:180px;min-width:110px}.actionCol{width:74px;min-width:62px;text-align:center}
    .colResize{position:absolute;top:0;right:-3px;width:7px;height:100%;cursor:col-resize;z-index:3}.colResize:hover,.resizing .colResize{background:#b8d7ff}
    th.selectedCol,td.selectedCol{background:#fff7e6!important}tr.selectedRow td{background:#e8f1ff!important}th.selectedCol{box-shadow:inset 0 -2px 0 #f59e0b}td.selectedCell{outline:2px solid #1f6feb;outline-offset:-2px}
    th[draggable="true"]{cursor:grab}th.colDragOver{box-shadow:inset 3px 0 0 #1f6feb}th .sortArrow{color:#1f6feb;margin-left:2px}
    .packageDownload{display:inline-block;background:#1f6feb;color:#fff;font-weight:700;padding:10px 16px;text-decoration:none;border-radius:3px;margin:0 0 10px}.packageDownload:hover{background:#1656c4}
    .promptCollapsible[hidden]{display:none}
    pre[data-prompt-text]{max-height:220px;overflow:auto}
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
      <div class="viewNav">
        <button id="viewAllButton" class="primary" type="button">전체</button>
        <button id="viewRecommendButton" type="button">추천</button>
        <button id="viewRegistrationsButton" type="button">등록·재고관리</button>
      </div>
      <div class="toolbar">
        <select id="statusFilter"><option value="">all</option><option value="draft">draft</option><option value="needs_review">needs_review</option><option value="blocked">blocked</option><option value="approved">approved</option></select>
        <select id="naverWinnerFilter"><option value="">naver all</option><option value="candidate">candidate</option><option value="needs_review">needs_review</option><option value="reject">reject</option></select>
        <select id="finalDecisionFilter"><option value="">final all</option><option value="등록후보">등록후보</option><option value="검수필요">검수필요</option><option value="제외">제외</option></select>
        <input id="batchFilter" placeholder="importBatchId">
        <label style="display:flex;align-items:center;gap:4px;margin:0;color:#1f2933;"><input id="collectedOnly" type="checkbox" style="width:auto;"> collected</label>
        <button id="naverCandidateButton">N winner Candidate</button>
        <button id="reloadButton">Reload</button>
      </div>
      <div class="tableWrap"><table id="draftTable"><thead><tr id="draftHeaderRow"></tr></thead><tbody id="draftRows"></tbody></table></div>
      <div id="specialView" class="tableWrap" hidden></div>
    </section>
    <section class="detail" id="detail">Select a product.</section>
  </main>
  <section id="aiSettings" class="detail" hidden><div class="section"><h2>AI API 설정</h2><p class="muted">현재 이미지 생성은 반수동 외부 AI workflow를 사용합니다. API 설정은 향후 자동 생성 기능을 위한 선택 사항입니다.</p><div id="aiProviderCards" class="grid"></div></div><div class="section"><h2>AI 작업별 모델 설정</h2><div id="aiTaskRouting"></div></div></section>
  <script>
    let selectedId=null;let selectedColIndex=null;let selectedRowIndex=null;const rows=document.getElementById('draftRows');const detail=document.getElementById('detail');
    const statusFilter=document.getElementById('statusFilter');const naverWinnerFilter=document.getElementById('naverWinnerFilter');const finalDecisionFilter=document.getElementById('finalDecisionFilter');const batchFilter=document.getElementById('batchFilter');const collectedOnly=document.getElementById('collectedOnly');
    document.getElementById('reloadButton').addEventListener('click',loadList);document.getElementById('naverCandidateButton').addEventListener('click',()=>{naverWinnerFilter.value='candidate';loadList();});statusFilter.addEventListener('change',loadList);naverWinnerFilter.addEventListener('change',loadList);finalDecisionFilter.addEventListener('change',loadList);batchFilter.addEventListener('change',loadList);collectedOnly.addEventListener('change',loadList);
    let currentView='all';
    const viewButtons={all:document.getElementById('viewAllButton'),recommend:document.getElementById('viewRecommendButton'),registrations:document.getElementById('viewRegistrationsButton')};
    for(const [view,button] of Object.entries(viewButtons))button.addEventListener('click',()=>switchView(view));
    function switchView(view){
      currentView=view;
      for(const [key,button] of Object.entries(viewButtons))button.classList.toggle('primary',key===view);
      document.querySelector('#draftTable').closest('.tableWrap').hidden=view!=='all';
      document.getElementById('specialView').hidden=view==='all';
      if(view==='all')loadList();
      else if(view==='recommend')loadRecommendView();
      else if(view==='registrations')loadRegistrationsView();
    }
    async function loadRecommendView(){
      const data=await api('/api/product-drafts?finalDecision='+encodeURIComponent('등록후보')+'&limit=4');
      const el=document.getElementById('specialView');
      if(!data.drafts.length){el.innerHTML='<p class="muted" style="padding:12px">현재 추천할 후보가 없습니다.</p>';return;}
      el.innerHTML='<div class="grid" style="padding:12px">'+data.drafts.map(recommendCardHtml).join('')+'</div>';
    }
    function recommendCardHtml(d){
      return '<div class="section"><h3>#'+d.id+' '+escapeHtml(d.sellingTitle||d.originalProductName||'')+'</h3>'
        +'<div>쿠팡 '+money(d.coupangSalePrice)+' / 이익 '+money(d.coupangExpectedProfit)+'</div>'
        +'<div>네이버 '+money(d.naverSalePrice)+' / 이익 '+money(d.naverExpectedProfit)+' / winner score '+((d.naverResearch||{}).winnerScore??'-')+'</div>'
        +'<p><a class="packageDownload" href="/api/product-drafts/'+d.id+'/ai-workflows/main-image/package">대표이미지 패키지</a> <a class="packageDownload" href="/api/product-drafts/'+d.id+'/ai-workflows/detail-page/package">상세이미지 패키지</a></p>'
        +'<p><a class="productLink" href="/admin?draftId='+d.id+'">상세보기 →</a></p></div>';
    }
    async function loadRegistrationsView(){
      const data=await api('/api/coupang-registrations');
      const el=document.getElementById('specialView');
      if(!data.registrations.length){el.innerHTML='<p class="muted" style="padding:12px">표시할 항목이 없습니다.</p>';return;}
      el.innerHTML='<div style="padding:12px">'+data.registrations.map(registrationRowHtml).join('')+'</div>';
    }
    function registrationRowHtml(r){
      const linked=r.sellerProductId;
      return '<div class="section"><h3>#'+r.productDraftId+' '+escapeHtml(r.optimizedCoupangTitle||r.sellingTitle||'')+'</h3>'
        +(linked
          ?'<div>sellerProductId '+escapeHtml(r.sellerProductId)+' / 상태 '+escapeHtml(r.liveStatusName||r.status||'-')+' / 재고 '+money(r.liveTotalStockQuantity)+' / 가격 '+money(r.liveSalePrice)+'</div><div class="muted">마지막 확인: '+escapeHtml(r.lastSyncedAt||'-')+'</div>'
          :'<div class="muted">아직 쿠팡 상품과 연결되지 않았습니다.</div>')
        +'<p><a class="productLink" href="/admin?draftId='+r.productDraftId+'">상세보기(연결/이미지반영/새로고침) →</a></p></div>';
    }
    window.__adminUiDiagnostics=window.__adminUiDiagnostics||{};window.__adminUiDiagnostics.scriptLoaded=true;loadList();const initialId=new URL(location.href).searchParams.get('draftId');window.__adminUiDiagnostics.initialId=Number(initialId)||null;window.__adminUiDiagnostics.initialLoadDetailCallAttempted=Boolean(initialId);window.__initialLoadPromise=initialId?Promise.resolve(loadDetail(initialId,false)):Promise.resolve();

    let currentDrafts=[];
    let columnOrder=null;
    let sortState={key:null,dir:1};

    function sortNum(v){return v==null?-Infinity:Number(v);}
    const COLUMNS_V1=[
      {key:'id',label:'DB ID',cls:'idCol',value:d=>Number(d.id),html:d=>String(d.id)},
      {key:'supplierProductNo',label:'Domeme No',cls:'productNoCol',value:d=>d.supplierProductNo||'',html:d=>escapeHtml(d.supplierProductNo)},
      {key:'market',label:'Market',cls:'statusCol',value:d=>labelMarket(d.supplierMarket),html:d=>escapeHtml(labelMarket(d.supplierMarket))},
      {key:'mainImages',label:'Main img',cls:'moneyCol',value:d=>sortNum(d.mainImages),html:d=>money(d.mainImages)},
      {key:'detailImages',label:'Detail img',cls:'moneyCol',value:d=>sortNum(d.detailImages),html:d=>money(d.detailImages)},
      {key:'totalImages',label:'Total img',cls:'moneyCol',value:d=>sortNum(d.totalImages),html:d=>money(d.totalImages)},
      {key:'minOrderQty',label:'MOQ',cls:'moneyCol',value:d=>sortNum(d.minOrderQty),html:d=>money(d.minOrderQty)},
      {key:'orderUnit',label:'Order unit',cls:'moneyCol',value:d=>sortNum(d.orderUnit),html:d=>money(d.orderUnit)},
      {key:'sellUnitType',label:'Sell unit',cls:'statusCol',value:d=>labelSellUnit(d.sellUnitType),html:d=>escapeHtml(labelSellUnit(d.sellUnitType))},
      {key:'bundleQuantity',label:'Bundle qty',cls:'moneyCol',value:d=>sortNum(d.bundleQuantity),html:d=>money(d.bundleQuantity)},
      {key:'unitCostPrice',label:'Unit cost',cls:'moneyCol',value:d=>sortNum(d.unitCostPrice),html:d=>money(d.unitCostPrice)},
      {key:'bundleCostPrice',label:'Bundle cost',cls:'moneyCol',value:d=>sortNum(d.bundleCostPrice),html:d=>money(d.bundleCostPrice)},
      {key:'name',label:'Name',cls:'nameCol',value:d=>(d.originalProductName||d.sellingTitle||''),html:d=>'<a class="productLink" data-open-detail="'+d.id+'" href="/admin?draftId='+d.id+'">'+escapeHtml(d.originalProductName||d.sellingTitle||'')+'</a><br><span class="muted">'+escapeHtml(d.sellingTitle||'')+'</span>'},
      {key:'cost',label:'Cost',cls:'moneyCol',value:d=>sortNum(d.cost),html:d=>money(d.cost)},
      {key:'shippingFee',label:'Shipping',cls:'moneyCol',value:d=>sortNum(d.shippingFee),html:d=>money(d.shippingFee)},
      {key:'coupangSalePrice',label:'Coupang',cls:'moneyCol',value:d=>sortNum(d.coupangSalePrice),html:d=>money(d.coupangSalePrice)},
      {key:'coupangExpectedProfit',label:'Coupang profit',cls:'moneyCol',value:d=>sortNum(d.coupangExpectedProfit),html:d=>moneyWithRate(d.coupangExpectedProfit,d.coupangMarginRate)},
      {key:'naverSalePrice',label:'Naver',cls:'moneyCol',value:d=>sortNum(d.naverSalePrice),html:d=>money(d.naverSalePrice)},
      {key:'naverExpectedProfit',label:'Naver profit',cls:'moneyCol',value:d=>sortNum(d.naverExpectedProfit),html:d=>moneyWithRate(d.naverExpectedProfit,d.naverMarginRate)},
      {key:'cLowest',label:'Lowest',cls:'moneyCol',value:d=>sortNum((d.coupangResearch||{}).lowestPrice),html:d=>money((d.coupangResearch||{}).lowestPrice)},
      {key:'cGap',label:'Gap %',cls:'moneyCol',value:d=>sortNum((d.coupangResearch||{}).priceGapRate),html:d=>percent((d.coupangResearch||{}).priceGapRate)},
      {key:'rocket',label:'Rocket',cls:'statusCol',value:d=>rocketLabel((d.coupangResearch||{}).rocketExists),html:d=>rocketLabel((d.coupangResearch||{}).rocketExists)},
      {key:'cMaxReviews',label:'Max reviews',cls:'moneyCol',value:d=>sortNum((d.coupangResearch||{}).maxReviewCount),html:d=>money((d.coupangResearch||{}).maxReviewCount)},
      {key:'cCompetitors',label:'Competitors',cls:'moneyCol',value:d=>sortNum((d.coupangResearch||{}).competitorCount),html:d=>money((d.coupangResearch||{}).competitorCount)},
      {key:'cScore',label:'Winner score',cls:'moneyCol',value:d=>sortNum((d.coupangResearch||{}).winnerScore),html:d=>((d.coupangResearch||{}).winnerScore??'-')},
      {key:'cWinner',label:'Winner',cls:'statusCol',value:d=>labelWinner((d.coupangResearch||{}).winnerStatus),html:d=>escapeHtml(labelWinner((d.coupangResearch||{}).winnerStatus))},
      {key:'nLowest',label:'N lowest',cls:'moneyCol',value:d=>sortNum((d.naverResearch||{}).lowestPrice),html:d=>money((d.naverResearch||{}).lowestPrice)},
      {key:'nGap',label:'N gap %',cls:'moneyCol',value:d=>sortNum((d.naverResearch||{}).priceGapRate),html:d=>percent((d.naverResearch||{}).priceGapRate)},
      {key:'nCompetitors',label:'N competitors',cls:'moneyCol',value:d=>sortNum((d.naverResearch||{}).competitorCount),html:d=>money((d.naverResearch||{}).competitorCount)},
      {key:'nScore',label:'N score',cls:'moneyCol',value:d=>sortNum((d.naverResearch||{}).winnerScore),html:d=>((d.naverResearch||{}).winnerScore??'-')},
      {key:'nWinner',label:'N winner',cls:'statusCol',value:d=>labelWinner((d.naverResearch||{}).winnerStatus),html:d=>escapeHtml(labelWinner((d.naverResearch||{}).winnerStatus))},
      {key:'finalDecision',label:'Final',cls:'statusCol',value:d=>d.finalDecision||'',html:d=>'<span class="badge status">'+escapeHtml(d.finalDecision||'-')+'</span>'},
      {key:'status',label:'Status',cls:'statusCol',value:d=>d.status||'',html:d=>'<span class="badge status">'+escapeHtml(labelStatus(d.status))+'</span>'+(d.warnings||[]).map(x=>'<span class="badge reasonBlock">'+escapeHtml(x)+'</span>').join('')},
      {key:'reasons',label:'Reasons',cls:'reasonCol',value:d=>((d.blockReasons||[]).length+(d.reviewReasons||[]).length),html:d=>[...(d.blockReasons||[]).map(x=>'<span class="badge reasonBlock">'+escapeHtml(x)+'</span>'),...(d.reviewReasons||[]).map(x=>'<span class="badge reasonReview">'+escapeHtml(x)+'</span>')].join('')||'<span class="muted">-</span>'},
      {key:'detailButton',label:'상세보기',cls:'actionCol',value:()=>0,html:d=>'<button data-open-detail="'+d.id+'">상세보기</button>'},
      {key:'sourceButton',label:'공급처',cls:'actionCol',value:()=>0,html:d=>d.supplierProductUrl?('<a href="'+attr(d.supplierProductUrl)+'" target="_blank" rel="noopener noreferrer"><button>공급처</button></a>'):'-'},
    ];

    function defaultColumnOrder(){return COLUMNS_V1.map(c=>c.key);}
    function getColumnOrder(){try{const saved=JSON.parse(localStorage.getItem('automoney.admin.columnOrder')||'null');if(Array.isArray(saved)&&saved.length===COLUMNS_V1.length&&saved.every(k=>COLUMNS_V1.some(c=>c.key===k)))return saved;}catch{}return defaultColumnOrder();}
    function saveColumnOrder(order){localStorage.setItem('automoney.admin.columnOrder',JSON.stringify(order));}
    function orderedColumns(){if(!columnOrder)columnOrder=getColumnOrder();return columnOrder.map(key=>COLUMNS_V1.find(c=>c.key===key)).filter(Boolean);}

    function toggleSort(key){if(sortState.key===key)sortState.dir=-sortState.dir;else{sortState.key=key;sortState.dir=1;}renderTable();}
    function sortedDrafts(){if(!sortState.key)return currentDrafts;const col=COLUMNS_V1.find(c=>c.key===sortState.key);if(!col)return currentDrafts;return [...currentDrafts].sort((a,b)=>{const av=col.value(a),bv=col.value(b);if(typeof av==='number'&&typeof bv==='number')return (av-bv)*sortState.dir;return String(av).localeCompare(String(bv),'ko')*sortState.dir;});}

    function renderHeader(){
      const table=document.getElementById('draftTable');
      const headRow=document.getElementById('draftHeaderRow');
      const cols=orderedColumns();
      headRow.innerHTML=cols.map(col=>{const arrow=sortState.key===col.key?('<span class="sortArrow">'+(sortState.dir===1?'▲':'▼')+'</span>'):'';return '<th class="'+col.cls+'" draggable="true" data-col-key="'+col.key+'" title="드래그: 열 이동 / 더블클릭: 정렬">'+escapeHtml(col.label)+arrow+'</th>';}).join('');
      [...headRow.querySelectorAll('th')].forEach((th,index)=>{
        th.addEventListener('click',e=>{if(e.target.classList.contains('colResize'))return;selectedColIndex=index;selectedRowIndex=null;applySelection();});
        th.addEventListener('dblclick',e=>{if(e.target.classList.contains('colResize'))return;toggleSort(th.dataset.colKey);});
        const handle=document.createElement('span');handle.className='colResize';handle.draggable=false;handle.title='Drag to resize column. Double-click to auto-fit.';th.appendChild(handle);
        handle.addEventListener('dblclick',e=>{e.preventDefault();e.stopPropagation();autoFitColumn(index,true);});
        handle.addEventListener('mousedown',e=>{e.preventDefault();e.stopPropagation();const startX=e.clientX;const startWidth=th.getBoundingClientRect().width;document.body.classList.add('resizing');const move=event=>{const width=Math.max(minColumnWidth(index),Math.round(startWidth+event.clientX-startX));setColumnWidth(table,index,width);saveColumnWidth(th.dataset.colKey,width);};const up=()=>{document.body.classList.remove('resizing');document.removeEventListener('mousemove',move);document.removeEventListener('mouseup',up);};document.addEventListener('mousemove',move);document.addEventListener('mouseup',up);});
        th.addEventListener('dragstart',e=>{e.dataTransfer.setData('text/plain',String(index));e.dataTransfer.effectAllowed='move';});
        th.addEventListener('dragover',e=>{e.preventDefault();e.dataTransfer.dropEffect='move';th.classList.add('colDragOver');});
        th.addEventListener('dragleave',()=>{th.classList.remove('colDragOver');});
        th.addEventListener('drop',e=>{e.preventDefault();th.classList.remove('colDragOver');const from=Number(e.dataTransfer.getData('text/plain'));const to=index;if(!Number.isInteger(from)||from===to)return;const order=orderedColumns().map(c=>c.key);const moved=order.splice(from,1)[0];order.splice(to,0,moved);columnOrder=order;saveColumnOrder(order);renderTable();});
      });
    }
    function rowHtml(d){const cols=orderedColumns();return '<tr class="'+(Number(selectedId)===d.id?'active':'')+'">'+cols.map(col=>'<td class="'+col.cls+'">'+col.html(d)+'</td>').join('')+'</tr>';}
    function renderTable(){renderHeader();rows.innerHTML=sortedDrafts().map(rowHtml).join('');for(const el of rows.querySelectorAll('[data-open-detail]'))el.addEventListener('click',e=>{e.preventDefault();loadDetail(el.dataset.openDetail);});bindCellSelection();applyStoredOrAutoWidths();applySelection();}

    async function loadList(){const params=new URLSearchParams();if(statusFilter.value)params.set('status',statusFilter.value);if(naverWinnerFilter.value)params.set('naverWinnerStatus',naverWinnerFilter.value);if(finalDecisionFilter.value)params.set('finalDecision',finalDecisionFilter.value);if(batchFilter.value.trim())params.set('importBatchId',batchFilter.value.trim());if(collectedOnly.checked)params.set('collectedOnly','true');const qs=params.toString()?'?'+params.toString():'';const data=await api('/api/product-drafts'+qs);currentDrafts=data.drafts;renderTable();}
    function applyStoredOrAutoWidths(){const table=document.getElementById('draftTable');const cols=orderedColumns();const saved=getColumnWidths();cols.forEach((col,index)=>{if(saved[col.key])setColumnWidth(table,index,saved[col.key]);else autoFitColumn(index,false);});}
    function autoFitColumn(index,persist){const table=document.getElementById('draftTable');const col=orderedColumns()[index];if(!col)return;const isName=col.key==='name';let max=isName?190:minColumnWidth(index);for(const row of table.rows){const cell=row.cells[index];if(!cell)continue;const text=(cell.innerText||'').replace(/\s+/g,' ').trim();const estimate=Math.min(isName?360:160,Math.max(minColumnWidth(index),text.length*7+18));max=Math.max(max,estimate);}setColumnWidth(table,index,max);if(persist)saveColumnWidth(col.key,max);}
    function setColumnWidth(table,index,width){const value=Number(width)||80;for(const row of table.rows){const cell=row.cells[index];if(cell){cell.style.width=value+'px';cell.style.minWidth=value+'px';cell.style.maxWidth=value+'px';}}}
    function minColumnWidth(index){const col=orderedColumns()[index];if(!col)return 52;if(col.cls==='nameCol')return 180;if(col.cls==='actionCol')return 58;if(col.cls==='idCol')return 44;if(col.cls==='productNoCol')return 76;return 52;}
    function getColumnWidths(){try{return JSON.parse(localStorage.getItem('automoney.admin.columnWidths')||'{}')}catch{return{}}}
    function saveColumnWidth(key,width){const saved=getColumnWidths();saved[key]=width;localStorage.setItem('automoney.admin.columnWidths',JSON.stringify(saved));}
    function bindCellSelection(){[...rows.querySelectorAll('tr')].forEach((tr,rowIndex)=>{tr.addEventListener('click',e=>{if(e.target.closest('button,a,input,select,textarea'))return;selectedRowIndex=rowIndex;selectedColIndex=e.target.closest('td')?.cellIndex??selectedColIndex;applySelection();});});}
    function applySelection(){const table=document.getElementById('draftTable');for(const cell of table.querySelectorAll('.selectedCol,.selectedCell'))cell.classList.remove('selectedCol','selectedCell');for(const row of table.querySelectorAll('tr.selectedRow'))row.classList.remove('selectedRow');if(selectedColIndex!=null){for(const row of table.rows){row.cells[selectedColIndex]?.classList.add('selectedCol');}}if(selectedRowIndex!=null){rows.rows[selectedRowIndex]?.classList.add('selectedRow');if(selectedColIndex!=null)rows.rows[selectedRowIndex]?.cells[selectedColIndex]?.classList.add('selectedCell');}}
    async function loadDetail(id,push=true){selectedId=id;if(push)history.replaceState(null,'','/admin?draftId='+encodeURIComponent(id));const data=await api('/api/product-drafts/'+id);const d=data.draft;detail.innerHTML=detailHtml(d);enhanceDetailImageSections(d);bindTabs();document.getElementById('saveButton').addEventListener('click',()=>saveDraft(id));for(const b of detail.querySelectorAll('[data-status-action]'))b.addEventListener('click',()=>setStatus(id,b.dataset.statusAction));const forceApprove=document.getElementById('forceApproveButton');if(forceApprove)forceApprove.addEventListener('click',()=>forceApproveDraft(id));document.getElementById('exportCoupangButton').addEventListener('click',()=>loadExport(id,'coupang'));document.getElementById('exportNaverButton').addEventListener('click',()=>loadExport(id,'naver'));document.getElementById('copyJsonButton').addEventListener('click',copyExportJson);document.getElementById('refreshNaverButton').addEventListener('click',()=>refreshNaver(id));document.getElementById('runSeoAnalysisButton').addEventListener('click',()=>runSeoAnalysis(id));const regenerateTitleButton=document.getElementById('regenerateTitleButton');if(regenerateTitleButton)regenerateTitleButton.addEventListener('click',()=>regenerateOptimizedTitles(id));const saveTitlesButton=document.getElementById('saveTitlesButton');if(saveTitlesButton)saveTitlesButton.addEventListener('click',()=>saveOptimizedTitles(id));const copyCoupangTitleButton=document.getElementById('copyCoupangTitleButton');if(copyCoupangTitleButton)copyCoupangTitleButton.addEventListener('click',()=>copyTitle('optimizedCoupangTitle'));const copyNaverTitleButton=document.getElementById('copyNaverTitleButton');if(copyNaverTitleButton)copyNaverTitleButton.addEventListener('click',()=>copyTitle('optimizedNaverTitle'));const regenerateDetailButton=document.getElementById('regenerateDetailButton');if(regenerateDetailButton)regenerateDetailButton.addEventListener('click',()=>regenerateGeneratedDetail(id));const toggleOriginalButton=document.getElementById('toggleOriginalDetailButton');if(toggleOriginalButton)toggleOriginalButton.addEventListener('click',toggleOriginalDetailImages);const refreshPreviewButton=document.getElementById('refreshPreviewButton');if(refreshPreviewButton)refreshPreviewButton.addEventListener('click',refreshDetailPreview);document.getElementById('saveChecklistButton').addEventListener('click',()=>saveChecklist(id));document.getElementById('preview').srcdoc=d.generatedDetailHtml||'';const naver=await api('/api/product-drafts/'+id+'/market-research/naver');fillNaverResearch(naver.research);const opt=await api('/api/product-drafts/'+id+'/registration-optimization');renderOptimization(opt.optimization);const checklist=await api('/api/product-drafts/'+id+'/registration-checklist');fillChecklist(checklist.checklist);loadCoupangLiveSection(id,d);loadAnalysisSection(id,d);loadList();}
    function detailHtml(d){const hasBlockReasons=(d.blockReasons||[]).length>0;const approvalButton=hasBlockReasons?'<button id="forceApproveButton">Force approve</button><span class="badge reasonBlock">overrideReason required</span>':'<button data-status-action="approved">Approved</button>';const warnings=(d.warnings||[]).map(x=>'<span class="badge reasonBlock">'+escapeHtml(x)+'</span>').join('');return '<div class="tabs"><button class="active" data-tab="source">원본/공급처</button><button data-tab="naver">네이버 경쟁분석</button><button data-tab="seo">SEO 키워드</button><button data-tab="title">상품명</button><button data-tab="detail">상세페이지</button><button data-tab="image">이미지 프롬프트</button><button data-tab="analysis">상품정보 분석</button><button data-tab="category">카테고리</button><button data-tab="notice">고시정보</button><button data-tab="shipping">배송정책</button><button data-tab="approval">승인조건</button><button data-tab="coupangLive">쿠팡 라이브 관리</button><button data-tab="export">Export JSON</button></div><div class="tabPanel active" data-panel="source"><div class="section"><h2>#'+d.id+' '+escapeHtml(d.supplierProductNo)+'</h2><div class="grid"><div><div class="muted">Original name</div><strong>'+escapeHtml(d.originalProductName||'')+'</strong></div><div><div class="muted">Status</div>'+escapeHtml(labelStatus(d.status))+' / '+escapeHtml(labelStatus(d.filterStatus))+' '+warnings+'</div><div>Final: <span class="badge status">'+escapeHtml(d.finalDecision||'-')+'</span></div><div>Raw price: '+escapeHtml(d.rawPriceFieldName||'-')+' = '+escapeHtml(d.rawPriceValue||'-')+'</div><div>Shipping: '+escapeHtml(d.shippingRawFieldName||'-')+' = '+escapeHtml(d.shippingRawValue||'-')+'</div><div>Coupang: '+money(d.coupangSalePrice)+' / profit '+money(d.coupangExpectedProfit)+'</div><div>Naver: '+money(d.naverSalePrice)+' / profit '+money(d.naverExpectedProfit)+'</div></div></div>'+sourceInfoHtml(d)+'<div class="section"><h2>Reasons</h2>'+reasonBadges(d.blockReasons).join('')+reasonBadges(d.reviewReasons).join('')+'</div><div class="section"><h2>Images</h2>'+imageGalleryHtml(d)+'</div><div class="section"><h2>Options</h2><table><tbody>'+d.options.map(o=>'<tr><td>'+o.index+'</td><td>'+escapeHtml(o.name||'')+'</td><td>'+escapeHtml(o.value||'')+'</td><td>'+money(o.additionalPrice)+'</td></tr>').join('')+'</tbody></table></div></div><div class="tabPanel" data-panel="naver">'+naverResearchHtml()+'</div><div class="tabPanel" data-panel="seo">'+optimizationHtml()+'</div><div class="tabPanel" data-panel="title"><div class="section"><h2>상품명</h2><div id="optimizedTitleResult" class="muted"></div></div></div><div class="tabPanel" data-panel="detail"><div class="section"><h2>수정</h2><label>sellingTitle</label><input id="sellingTitle" value="'+attr(d.sellingTitle||'')+'"><div class="grid"><div><label>coupangSalePrice</label><input id="coupangSalePrice" type="number" value="'+attr(d.coupangSalePrice??'')+'"></div><div><label>naverSalePrice</label><input id="naverSalePrice" type="number" value="'+attr(d.naverSalePrice??'')+'"></div></div><label>status</label><select id="status"><option>draft</option><option>needs_review</option><option>blocked</option><option>approved</option></select><label>상세페이지 HTML 수정</label><textarea id="generatedDetailHtml">'+escapeHtml(d.generatedDetailHtml||'')+'</textarea><label>reviewMemo</label><textarea id="reviewMemo">'+escapeHtml(d.reviewMemo||'')+'</textarea><p><button class="primary" id="saveButton">Save</button> <button data-status-action="draft">Draft</button> <button data-status-action="needs_review">Needs review</button> <button data-status-action="blocked">Blocked</button> '+approvalButton+' <button id="exportCoupangButton">쿠팡 JSON 보기</button> <button id="exportNaverButton">네이버 JSON 보기</button> <button id="copyJsonButton">JSON 복사</button></p></div><div class="section"><h2>상세페이지 미리보기</h2><iframe id="preview"></iframe></div></div><div class="tabPanel" data-panel="image"><div class="section"><h2>이미지 프롬프트</h2><pre id="imagePromptResult"></pre></div></div><div class="tabPanel" data-panel="analysis"><div class="section"><h2>상품정보 분석 (Python OCR + Codex)</h2><div id="analysisContent" class="muted">불러오는 중...</div></div></div><div class="tabPanel" data-panel="category"><div class="section"><h2>카테고리</h2><div id="categoryResult" class="muted"></div></div></div><div class="tabPanel" data-panel="notice"><div class="section"><h2>고시정보</h2><div id="noticeResult" class="muted"></div></div></div><div class="tabPanel" data-panel="shipping"><div class="section"><h2>배송정책</h2><div id="shippingResult" class="muted"></div></div></div><div class="tabPanel" data-panel="approval">'+approvalChecklistHtml()+'</div><div class="tabPanel" data-panel="coupangLive"><div class="section"><h2>쿠팡 라이브 관리</h2><div id="coupangLiveContent" class="muted">불러오는 중...</div></div></div><div class="tabPanel" data-panel="export"><div class="section"><h2>Export JSON preview</h2><pre id="exportPreview"></pre></div></div><script>document.getElementById("status").value='+JSON.stringify(d.status)+';<\\/script>';}
    function enhanceDetailImageSections(d){const panel=detail.querySelector('[data-panel="detail"]');if(!panel)return;const preview=panel.querySelector('#preview')?.closest('.section');if(preview){preview.querySelector('h2').textContent='재구성 상세페이지 미리보기';const note=document.createElement('p');note.className='muted';note.textContent='긴 원본 이미지는 참고 자료로 보관하고, 아래 HTML은 상품명/스펙/추천대상/핵심장점/배송안내 구조로 재구성한 내용입니다.';preview.insertBefore(note,preview.querySelector('iframe'));}const edit=panel.querySelector('.section');const save=document.getElementById('saveButton');if(save)save.textContent='HTML 저장';if(edit&&!document.getElementById('regenerateDetailButton')){const controls=document.createElement('p');controls.innerHTML='<button id="regenerateDetailButton" type="button">상세페이지 재생성</button> <button id="toggleOriginalDetailButton" type="button" data-include-original="true">원본 상세 이미지 포함</button> <button id="refreshPreviewButton" type="button">미리보기 새로고침</button>';edit.append(controls);}const source=document.createElement('div');source.className='section';source.innerHTML='<h2>원본 상세 이미지 보기</h2>'+imageGalleryHtml(d);panel.insertBefore(source,preview||null);const usage=document.createElement('div');usage.className='section';usage.innerHTML='<h2>원본 이미지 사용 여부</h2><div class="muted">detail_source_full은 기본적으로 원본 참고 영역에서만 사용합니다. 상세 본문 자동 삽입은 selected_for_detail 또는 regenerated_detail_asset을 우선합니다.</div>';if(preview)panel.insertBefore(usage,preview.nextSibling);const imagePanel=detail.querySelector('[data-panel="image"] h2');if(imagePanel)imagePanel.textContent='AI 이미지 생성 프롬프트';}
    function imageGalleryHtml(d){const images=d.images||[];const main=images.filter(i=>i.imageType==='main');const detailImages=images.filter(i=>i.sourceSection==='detail'&&['detail','regenerated_detail_asset'].includes(i.imageType));const sourceFull=images.filter(i=>['detail_source_full','detail_full'].includes(i.imageType));const slices=images.filter(i=>['detail_source_slice','detail_slice'].includes(i.imageType));const rejected=images.filter(i=>i.qualityStatus==='rejected'||i.rejectReason||['ad','recommendation','header','footer'].includes(i.sourceSection));const warnings=[];if(detailImages.length===0&&sourceFull.length===0&&slices.length===0)warnings.push('detail_images_missing');if(detailImages.length===0&&sourceFull.length>0)warnings.push('using_original_detail_source_only');const warn=warnings.map(x=>'<span class="badge reasonBlock">'+escapeHtml(x)+'</span>').join(' ');function meta(i){const size=(i.width||i.naturalWidth||i.renderedWidth||'-')+'x'+(i.height||i.naturalHeight||i.renderedHeight||'-');const pos=i.renderedX==null?'-':Math.round(i.renderedX)+','+Math.round(i.renderedY);const archived=String(i.storedUrl||'').startsWith('/original-images/')?'로컬 보관됨':'로컬 미보관';return '<div class="muted">'+escapeHtml(i.sourceMethod||'-')+' / '+escapeHtml(i.sourceSection||'-')+' / '+size+' / pos '+pos+' / '+archived+(i.crawlStatus?(' / '+escapeHtml(i.crawlStatus)):'')+(i.crawlError?(' / '+escapeHtml(i.crawlError)):'')+(i.sliceIndex?(' / slice '+i.sliceIndex):'')+(i.rejectReason?(' / reject '+escapeHtml(i.rejectReason)):'')+'</div><div class="muted">original: '+escapeHtml(i.originalUrl||i.url||'-')+'</div><div class="muted">stored: '+escapeHtml(i.storedUrl||'-')+'</div>';}function card(i){const url=i.storedUrl||i.url;const original=i.originalUrl||i.url;const local=i.storedUrl&&i.storedUrl!==original?'<a href="'+attr(i.storedUrl)+'" target="_blank" rel="noopener noreferrer"><button>로컬 이미지 열기</button></a>':'';return '<div style="display:inline-block;vertical-align:top;max-width:170px;margin:4px"><span class="badge">'+escapeHtml(i.imageType||'unknown')+'</span>'+meta(i)+'<a href="'+attr(url)+'" target="_blank" rel="noopener noreferrer"><img src="'+attr(url)+'" alt=""></a><br><a href="'+attr(original)+'" target="_blank" rel="noopener noreferrer"><button>원본 열기</button></a> '+local+'</div>';}function group(title,items){return '<h3>'+escapeHtml(title)+' ('+items.length+')</h3><div>'+items.map(card).join('')+'</div>';}return (warn?'<p>'+warn+'</p>':'')+group('대표 이미지',main)+group('상세페이지 이미지',detailImages)+group('원본 상세 이미지',sourceFull)+group('긴 이미지 분할 이미지',slices)+group('제외된 이미지/debug 이미지',rejected);}    function sourceInfoHtml(d){const link=d.supplierProductUrl?'<a href="'+attr(d.supplierProductUrl)+'" target="_blank" rel="noopener noreferrer"><button>공급처</button></a>':'-';return '<div class="section"><h2>공급처 정보</h2><div class="grid"><div>공급처명: '+escapeHtml(d.supplierName||'-')+'</div><div>공급마켓: '+escapeHtml(labelMarket(d.supplierMarket))+'</div><div>상품번호: '+escapeHtml(d.supplierProductNo||'-')+'</div><div>최소구매수량: '+money(d.minOrderQty)+'</div><div>주문단위: '+money(d.orderUnit)+'</div><div>판매단위: '+escapeHtml(labelSellUnit(d.sellUnitType))+'</div><div>묶음수량: '+money(d.bundleQuantity)+'</div><div>단품원가: '+money(d.unitCostPrice)+'</div><div>묶음원가: '+money(d.bundleCostPrice)+'</div><div>묶음사유: '+escapeHtml(d.bundleReason||'-')+'</div><div>공급처 원본 링크: '+link+'</div></div></div>';}
    function naverResearchHtml(){return '<div class="section"><h2>Naver shopping research</h2><label>Naver search keyword</label><input id="naverKeyword"><p><button id="refreshNaverButton">Refresh Naver research</button></p><div id="naverResearchResult" class="muted"></div><div id="naverBestItem"></div></div>';}
    function optimizationHtml(){return '<div class="section"><h2>SEO 키워드</h2><p><button id="runSeoAnalysisButton">SEO 분석 실행</button></p><div id="seoResult" class="muted"></div></div>';}
    function approvalChecklistHtml(){const items=[['supplierLinkChecked','공급처 링크 확인 완료'],['naverLowestSameItemChecked','네이버 최저가 동일상품 확인 완료'],['titleChecked','상품명 확인 완료'],['detailChecked','상세페이지 확인 완료'],['categoryChecked','카테고리 확인 완료'],['noticeChecked','고시정보 확인 완료'],['shippingPolicyChecked','배송정책 확인 완료'],['exportJsonChecked','export JSON 확인 완료']];return '<div class="section"><h2>승인조건</h2>'+items.map(([id,label])=>'<label style="display:flex;gap:8px;align-items:center"><input type="checkbox" data-check="'+id+'" style="width:auto">'+label+'</label>').join('')+'<label>overrideReason</label><textarea id="checkOverrideReason"></textarea><p><button id="saveChecklistButton">승인조건 저장</button></p><div id="checklistResult" class="muted"></div></div>';}
    async function loadCoupangLiveSection(id,draft){
      const panel=document.querySelector('#detail [data-panel="coupangLive"]');
      if(!panel)return;
      const container=panel.querySelector('#coupangLiveContent');
      const [regData,mainRes,detailRes]=await Promise.all([
        api('/api/product-drafts/'+id+'/coupang-registration'),
        api('/api/product-drafts/'+id+'/ai-workflows/main-image/results'),
        api('/api/product-drafts/'+id+'/ai-workflows/detail-page/results'),
      ]);
      const reg=regData.registration;
      const approvedMain=(mainRes.results||[]).find(r=>r.status==='approved')||null;
      const approvedDetail=(detailRes.sets||[]).find(s=>s.status==='approved')||null;
      container.innerHTML=coupangLiveHtml(draft,reg,approvedMain,approvedDetail);
      wireCoupangLiveSection(id,draft,container);
    }
    function coupangLiveHtml(draft,reg,approvedMain,approvedDetail){
      const linked=reg&&reg.sellerProductId;
      const linkSection=linked
        ?'<div><strong>연결됨</strong>: sellerProductId '+escapeHtml(reg.sellerProductId)+' / '+escapeHtml(reg.sellerProductName||'(이름 없음)')+' <span class="badge status">'+escapeHtml(reg.linkedVia||'')+'</span> / status '+escapeHtml(reg.status||'')+'</div>'
        :'<div class="muted">아직 쿠팡 상품과 연결되지 않았습니다. 스피드고전송기로 등록한 뒤 상품명으로 찾아 연결하세요.</div><label>검색어 (쿠팡 상품명)</label><input id="coupangLookupName" value="'+attr(draft.optimizedCoupangTitle||draft.sellingTitle||'')+'"><p><button id="coupangLookupButton" type="button">쿠팡에서 찾기</button></p><div id="coupangLookupResults"></div>';
      const imagesReady=approvedMain&&approvedDetail;
      const swapSection='<div class="section"><h3>이미지 반영</h3>'
        +(imagesReady
          ?'<div>승인된 대표이미지: <img src="'+attr(approvedMain.coupangStoredUrl)+'"> 승인된 상세이미지 '+approvedDetail.images.length+'장</div><p><button id="coupangSwapPreviewButton" type="button" '+(linked?'':'disabled')+'>이미지 반영 미리보기</button></p><div id="coupangSwapPreviewResult"></div>'
          :'<div class="muted">승인된 대표이미지 또는 상세이미지 세트가 아직 없습니다 (이미지 프롬프트 탭에서 먼저 승인하세요).</div>')
        +'</div>';
      const snapshotSection='<div class="section"><h3>재고·판매 현황</h3>'
        +(reg&&reg.lastSyncedAt
          ?'<div>상태: '+escapeHtml(reg.liveStatusName||'-')+' / 재고: '+money(reg.liveTotalStockQuantity)+' / 가격: '+money(reg.liveSalePrice)+'</div><div class="muted">마지막 확인: '+escapeHtml(reg.lastSyncedAt)+'</div>'
          :'<div class="muted">아직 조회한 적 없습니다.</div>')
        +'<p><button id="coupangRefreshButton" type="button" '+(linked?'':'disabled')+'>새로고침</button></p></div>';
      return '<div class="section">'+linkSection+'</div>'+swapSection+snapshotSection;
    }
    function wireCoupangLiveSection(id,draft,container){
      const lookupButton=container.querySelector('#coupangLookupButton');
      if(lookupButton)lookupButton.onclick=async()=>{
        const name=container.querySelector('#coupangLookupName').value.trim();
        const data=await api('/api/product-drafts/'+id+'/coupang-registration/lookup?name='+encodeURIComponent(name));
        const resultsEl=container.querySelector('#coupangLookupResults');
        if(!data.candidates.length){resultsEl.innerHTML='<p class="muted">검색 결과가 없습니다.</p>';return;}
        resultsEl.innerHTML=data.candidates.map(c=>'<div><label><input type="radio" name="coupangCandidate" value="'+attr(c.sellerProductId)+'" data-name="'+attr(c.sellerProductName||'')+'"> '+escapeHtml(c.sellerProductId)+' / '+escapeHtml(c.sellerProductName||'')+' / '+escapeHtml(c.statusName||'')+' / '+escapeHtml(c.createdAt||'')+'</label></div>').join('')+'<p><button id="coupangLinkButton" type="button">연결하기</button></p>';
        container.querySelector('#coupangLinkButton').onclick=async()=>{
          const checked=resultsEl.querySelector('input[name="coupangCandidate"]:checked');
          if(!checked){alert('연결할 상품을 선택하세요');return;}
          await api('/api/product-drafts/'+id+'/coupang-registration/link',{method:'POST',body:JSON.stringify({sellerProductId:checked.value,sellerProductName:checked.dataset.name})});
          await loadCoupangLiveSection(id,draft);
        };
      };
      const previewButton=container.querySelector('#coupangSwapPreviewButton');
      if(previewButton)previewButton.onclick=async()=>{
        const resultEl=container.querySelector('#coupangSwapPreviewResult');
        resultEl.innerHTML='<p class="muted">미리보기 생성 중...</p>';
        try{
          const data=await api('/api/product-drafts/'+id+'/coupang-registration/swap-images',{method:'POST',body:JSON.stringify({})});
          resultEl.innerHTML='<pre>'+escapeHtml(JSON.stringify(data.payload,null,2))+'</pre><p><button id="coupangSwapConfirmButton" type="button">위 내용으로 실제 반영</button></p>';
          container.querySelector('#coupangSwapConfirmButton').onclick=async()=>{
            if(!confirm('실제 쿠팡 상품에 이미지를 반영합니다. 되돌릴 수 없습니다. 계속할까요?'))return;
            const confirmed=await api('/api/product-drafts/'+id+'/coupang-registration/swap-images',{method:'POST',body:JSON.stringify({confirm:true})});
            resultEl.innerHTML='<p>반영 완료. statusName='+escapeHtml(confirmed.after?.statusName||'')+'</p>';
            await loadCoupangLiveSection(id,draft);
          };
        }catch(error){
          resultEl.innerHTML='<p class="muted">'+escapeHtml(error.message)+'</p>';
        }
      };
      const refreshButton=container.querySelector('#coupangRefreshButton');
      if(refreshButton)refreshButton.onclick=async()=>{
        await api('/api/product-drafts/'+id+'/coupang-registration/refresh',{method:'POST',body:'{}'});
        await loadCoupangLiveSection(id,draft);
      };
    }
    const ANALYSIS_ERROR_LABELS={CODEX_NOT_AVAILABLE:'Codex 미설치',CODEX_LOGIN_REQUIRED:'Codex 로그인 필요/만료',CODEX_RATE_LIMIT:'Codex 사용량 제한',CODEX_TIMEOUT:'Codex 응답 시간 초과',CODEX_INVALID_JSON:'Codex 결과 JSON 오류',CODEX_FAILED:'Codex 분석 실패',PYTHON_NOT_AVAILABLE:'Python 미설치',PYTHON_TIMEOUT:'Python 응답 시간 초과',PYTHON_INVALID_JSON:'Python 결과 JSON 오류',PYTHON_FAILED:'Python 분석 실패',NO_DETAIL_IMAGES:'로컬 상세이미지 없음',UNEXPECTED_ERROR:'예상치 못한 오류',ANALYSIS_FILES_MISSING:'분석 결과 없음 (먼저 실행하세요)'};
    const ANALYSIS_TIER_LABELS={auto_candidate:'자동 선택 후보 (0.90+)',needs_review:'확인 필요 (0.70~0.89)',unresolved:'미확정 (0.70 미만)'};
    const ANALYSIS_BLOCK_LABELS={NO_EVIDENCE_LEGAL_FIELD:'근거 없음 -- 법적/제조 정보는 적용 금지',CONFLICT_NEEDS_CONFIRMATION:'Python/Codex 값 충돌 -- 강제 적용 확인 필요',UNRESOLVED_NEEDS_CONFIRMATION:'미확정 -- 강제 적용 확인 필요',NO_VALUE:'값 없음'};
    async function loadAnalysisSection(id,draft){
      const panel=document.querySelector('#detail [data-panel="analysis"]');
      if(!panel)return;
      const container=panel.querySelector('#analysisContent');
      const data=await api('/api/product-drafts/'+id+'/analysis');
      container.innerHTML=analysisHtml(id,draft,data,data.latestRun);
      wireAnalysisSection(id,draft,container,data);
    }
    function analysisEvidenceHtml(evidence){
      if(!evidence||!evidence.length)return '<span class="muted">근거 없음</span>';
      return '<ul>'+evidence.map(e=>'<li>'+escapeHtml(e.engine||'')+' / '+escapeHtml(e.sourceFile||e.file||'-')+' / slice '+(e.sliceIndex??'-')+' / '+escapeHtml(e.quote||e.text||'')+'</li>').join('')+'</ul>';
    }
    function analysisFieldRowHtml(key,label,field,preview){
      const p=preview?.fields?.[key];
      const codexVal=field.codex?.value??'-';
      const pythonVal=field.python?field.python.value??'-':'(Python 미실행)';
      const mergedVal=field.merged?.value??'-';
      const tier=p?p.tier:'unresolved';
      const badge='<span class="badge status">'+escapeHtml(ANALYSIS_TIER_LABELS[tier]||tier)+'</span>'+(p?.legalField?' <span class="badge reasonReview">법적/제조정보</span>':'');
      const checkbox=p&&!p.blockedReason?'<input type="checkbox" data-apply-field="'+key+'" '+(p.autoSelected?'checked':'')+'>':'';
      const blocked=p?.blockedReason?'<div class="muted">'+escapeHtml(ANALYSIS_BLOCK_LABELS[p.blockedReason]||p.blockedReason)+(p.forceable?' <label><input type="checkbox" data-force-field="'+key+'"> 그래도 적용</label>':'')+'</div>':'';
      return '<div class="section"><h3>'+checkbox+' '+escapeHtml(label)+' '+badge+'</h3>'
        +'<table><tbody><tr><td class="muted">Python</td><td>'+escapeHtml(String(pythonVal))+'</td></tr><tr><td class="muted">Codex</td><td>'+escapeHtml(String(codexVal))+'</td></tr><tr><td class="muted">병합 최종값</td><td><strong>'+escapeHtml(String(mergedVal))+'</strong> (confidence '+(field.merged?.confidence??0)+')</td></tr></tbody></table>'
        +blocked+'<details><summary>근거 보기</summary>'+analysisEvidenceHtml(field.merged?.evidence)+'</details></div>';
    }
    function analysisHtml(id,draft,data,run){
      const runs=data.runs||[];
      const historyHtml=runs.length?'<table><tbody>'+runs.map(r=>'<tr data-analysis-run-row="'+r.id+'"><td>#'+r.runNumber+'</td><td>'+escapeHtml(r.status)+'</td><td>python:'+escapeHtml(r.pythonStatus)+'</td><td>codex:'+escapeHtml(r.codexStatus)+'</td><td>'+escapeHtml(r.errorCode?ANALYSIS_ERROR_LABELS[r.errorCode]||r.errorCode:'-')+'</td><td>'+escapeHtml(r.startedAt||'')+'</td><td><button type="button" data-view-run="'+r.id+'">보기</button></td></tr>').join('')+'</tbody></table>':'<p class="muted">아직 실행한 분석이 없습니다.</p>';
      const runButtons='<p><button id="analysisRunButton" type="button">상품정보 분석</button> '+(runs.length?'<button id="analysisRerunButton" type="button">분석 다시 실행</button>':'')+'</p><div id="analysisRunStatus" class="muted"></div>';
      if(!run){
        return runButtons+'<div class="muted">'+escapeHtml(ANALYSIS_ERROR_LABELS.ANALYSIS_FILES_MISSING)+'</div><h3>실행 이력</h3>'+historyHtml;
      }
      if(run.status!=='success'){
        const codexMsg=run.codexErrorCode?'<div>Codex: '+escapeHtml(ANALYSIS_ERROR_LABELS[run.codexErrorCode]||run.codexErrorCode)+' -- '+escapeHtml(run.codexErrorMessage||''):'';
        const pythonMsg=run.pythonErrorCode?'<div>Python: '+escapeHtml(ANALYSIS_ERROR_LABELS[run.pythonErrorCode]||run.pythonErrorCode)+' -- '+escapeHtml(run.pythonErrorMessage||''):'';
        return runButtons+'<div class="badge reasonBlock">'+escapeHtml(ANALYSIS_ERROR_LABELS[run.errorCode]||run.errorCode||'실패')+'</div>'+codexMsg+pythonMsg+'<h3>실행 이력</h3>'+historyHtml;
      }
      const merged=run.mergedAnalysis;
      const preview=data.applyPreview;
      const fieldRows=[['material','소재'],['dimensions','치수'],['manufacturer','제조자(수입자)'],['countryOfOrigin','제조국'],['handlingPrecautions','취급시 주의사항']]
        .map(([key,label])=>analysisFieldRowHtml(key,label,{python:run.pythonAnalysis?.[key],codex:run.codexAnalysis?.[key],merged:merged[key]},preview)).join('');
      const colorsPreview=preview?.colors||{saleColorCandidates:[],appearanceTraits:[]};
      const colorsCheckbox=(!colorsPreview.conflict&&(merged.colors?.confidence??0)>=0.7)?'<input type="checkbox" data-apply-field="colors" '+((merged.colors?.confidence??0)>=0.9?'checked':'')+'>':'<input type="checkbox" data-apply-field="colors" disabled> <label><input type="checkbox" data-force-field="colors"> 그래도 적용</label>';
      const colorsHtml='<div class="section"><h3>'+colorsCheckbox+' 색상</h3>'
        +'<div><strong>실제 판매 옵션 색상 후보</strong> (기존 옵션 값과 일치): '+(colorsPreview.saleColorCandidates.length?colorsPreview.saleColorCandidates.map(v=>'<span class="badge status">'+escapeHtml(v)+'</span>').join(' '):'<span class="muted">없음</span>')+'</div>'
        +'<div><strong>외관/재질 특성</strong> (판매 옵션 아님, 자동 추가되지 않음): '+(colorsPreview.appearanceTraits.length?colorsPreview.appearanceTraits.map(v=>'<span class="badge reasonReview">'+escapeHtml(v)+'</span>').join(' '):'<span class="muted">없음</span>')+'</div>'
        +'<details><summary>근거 보기</summary>'+analysisEvidenceHtml(merged.colors?.evidence)+'</details></div>';
      const searchTagsChecked=(merged.searchTags||[]).length>0;
      const searchTagsHtml='<div class="section"><h3><input type="checkbox" data-apply-field="searchTags" '+(searchTagsChecked?'checked':'')+' '+(searchTagsChecked?'':'disabled')+'> 검색어</h3><div>'+(merged.searchTags||[]).map(t=>'<span class="badge">'+escapeHtml(t)+'</span>').join(' ')+'</div></div>';
      const conflictsHtml=(merged.conflicts||[]).length?'<div class="section"><h3>충돌</h3>'+merged.conflicts.map(c=>'<div>'+escapeHtml(c.field)+': '+c.candidates.map(cand=>escapeHtml(cand.source)+'="'+escapeHtml(String(cand.value))+'"').join(' vs ')+'</div>').join('')+'</div>':'';
      const unresolvedHtml=(merged.unresolvedFields||[]).length?'<div class="section"><h3>미확정 필드</h3>'+(merged.unresolvedFields||[]).map(f=>'<span class="badge reasonReview">'+escapeHtml(f)+'</span>').join(' ')+'</div>':'';
      const applied=data.applied;
      const appliedHtml=applied?'<div class="section"><h3>현재 적용된 값 (run #'+applied.analysisRunId+')</h3><table><tbody>'
        +'<tr><td class="muted">소재</td><td>'+escapeHtml(applied.material||'-')+'</td></tr>'
        +'<tr><td class="muted">치수</td><td>'+escapeHtml(applied.dimensions||'-')+'</td></tr>'
        +'<tr><td class="muted">제조자</td><td>'+escapeHtml(applied.manufacturer||'-')+'</td></tr>'
        +'<tr><td class="muted">제조국</td><td>'+escapeHtml(applied.countryOfOrigin||'-')+'</td></tr>'
        +'<tr><td class="muted">판매 옵션 색상</td><td>'+(applied.saleColors||[]).map(escapeHtml).join(', ')+'</td></tr>'
        +'<tr><td class="muted">외관 특성</td><td>'+(applied.appearanceTraits||[]).map(escapeHtml).join(', ')+'</td></tr>'
        +'<tr><td class="muted">검색어</td><td>'+(applied.searchTags||[]).map(escapeHtml).join(', ')+'</td></tr>'
        +'</tbody></table><div class="muted">적용 시각: '+escapeHtml(applied.appliedAt||'')+'</div></div>':'<div class="muted">아직 적용된 값이 없습니다 (DB 불변).</div>';
      return runButtons+'<div>run #'+run.runNumber+' / python:'+escapeHtml(run.pythonStatus)+(run.pythonErrorCode?' ('+escapeHtml(ANALYSIS_ERROR_LABELS[run.pythonErrorCode]||run.pythonErrorCode)+')':'')+' / codex:'+escapeHtml(run.codexStatus)+'</div>'
        +fieldRows+colorsHtml+searchTagsHtml+conflictsHtml+unresolvedHtml
        +'<p><button id="analysisApplyButton" type="button" data-run-id="'+run.id+'">분석 결과 적용</button></p><div id="analysisApplyResult" class="muted"></div>'
        +appliedHtml+'<h3>실행 이력</h3>'+historyHtml;
    }
    function wireAnalysisSection(id,draft,container,data){
      const runButton=container.querySelector('#analysisRunButton');
      const rerunButton=container.querySelector('#analysisRerunButton');
      const runHandler=async()=>{
        const statusEl=container.querySelector('#analysisRunStatus');
        statusEl.textContent='분석 실행 중... (Codex 최대 3분, 서버는 계속 응답합니다)';
        if(runButton)runButton.disabled=true;if(rerunButton)rerunButton.disabled=true;
        try{
          await api('/api/product-drafts/'+id+'/analysis/run',{method:'POST',body:'{}'});
        } finally {
          await loadAnalysisSection(id,draft);
        }
      };
      if(runButton)runButton.onclick=runHandler;
      if(rerunButton)rerunButton.onclick=runHandler;
      for(const row of container.querySelectorAll('[data-view-run]')){
        row.onclick=async()=>{
          const runId=row.dataset.viewRun;
          const detail=await api('/api/product-drafts/'+id+'/analysis/runs/'+runId);
          container.innerHTML=analysisHtml(id,draft,{...data,applyPreview:detail.applyPreview},detail.run);
          wireAnalysisSection(id,draft,container,data);
        };
      }
      const applyButton=container.querySelector('#analysisApplyButton');
      if(applyButton)applyButton.onclick=async()=>{
        const runId=Number(applyButton.dataset.runId);
        const fields={};
        for(const cb of container.querySelectorAll('[data-apply-field]:checked'))fields[cb.dataset.applyField]=true;
        const forceFields=[...container.querySelectorAll('[data-force-field]:checked')].map(cb=>cb.dataset.forceField);
        const resultEl=container.querySelector('#analysisApplyResult');
        const result=await api('/api/product-drafts/'+id+'/analysis/apply',{method:'POST',body:JSON.stringify({runId,fields,forceFields})});
        resultEl.innerHTML='적용됨: '+(result.appliedFields.length?result.appliedFields.join(', '):'없음')+(result.blockedFields.length?' / 차단됨: '+result.blockedFields.map(b=>b.field+'('+(ANALYSIS_BLOCK_LABELS[b.reason]||b.reason)+')').join(', '):'');
        await loadAnalysisSection(id,draft);
      };
    }
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
    function promptCardV1(kind,label,data){const entry=kind==='main_image'?data.imagePromptState?.mainImage:data.imagePromptState?.detailPage;const r=entry?.request;const t=entry?.template;const warnings=(r?.warnings||[]).map(x=>'<span class="badge reasonReview">'+escapeHtml(x)+'</span>').join(' ');const empty=kind==='detail_page'&&data.generatedAiImageCount===0?'<p class="muted">DOCX 기반 프롬프트만 준비되어 있습니다.<br>아직 GPT Image로 생성된 상세페이지 이미지는 없습니다.</p>':'';return '<div class="section" data-ai-prompt-section="'+kind+'"><h2>'+label+'</h2><div>prompt state: '+(r?'current':'no_request')+' / DOCX: '+escapeHtml(r?.sourceFileName||t?.source_file_name||'-')+' / version '+(r?.templateVersion||'-')+' / hash '+escapeHtml((r?.templateHash||'').slice(0,12)||'-')+' / revision '+(r?.revision||'-')+'</div>'+empty+'<p><button data-prompt-create="'+kind+'">현재 DOCX 템플릿으로 최초 생성</button> <button data-prompt-regenerate="'+kind+'">명시적 재생성</button> <button data-copy-target="original-'+kind+'">원문 복사</button> <button data-copy-target="rendered-'+kind+'">치환본 복사</button> <button data-prompt-status-v1="approved" data-prompt-kind="'+kind+'">승인</button> <button data-prompt-status-v1="rejected" data-prompt-kind="'+kind+'">거절</button></p><p><button type="button" data-toggle-original="'+kind+'">원문 보기</button></p><div class="promptCollapsible" data-original-wrap="'+kind+'" hidden><label>원문</label><pre data-prompt-text="original-'+kind+'">'+escapeHtml(r?.promptOriginal||'')+'</pre></div><label>치환본</label><pre data-prompt-text="rendered-'+kind+'">'+escapeHtml(r?.promptRendered||'')+'</pre><div>'+warnings+'</div></div>';}
    function manualWorkflowHtmlV1(id,data,results){const r=data.imagePromptState?.mainImage?.request||{};const source=data.images?.mainImages?.[0]||null;const latest=results[0]||null;const history=results.map(x=>'<button type="button" data-manual-version="'+x.version+'">v'+x.version+' '+escapeHtml(x.status)+'</button>').join(' ');return '<div class="section" data-manual-main-image-workflow><h3>외부 AI 대표이미지 반수동 작업</h3><p><a class="packageDownload" data-manual-package href="/api/product-drafts/'+id+'/ai-workflows/main-image/package">⬇ 작업 패키지 다운로드</a></p><p><button type="button" data-copy-rendered>치환 프롬프트 복사</button> <button type="button" data-copy-original>원문 프롬프트 복사</button></p><div data-copy-feedback class="muted"></div><form data-manual-upload enctype="multipart/form-data"><input type="file" name="image" accept="image/png,image/jpeg,image/webp"><select name="providerCode"><option value="chatgpt">ChatGPT</option><option value="google_gemini">Google Gemini</option><option value="anthropic_claude">Anthropic Claude</option><option value="custom">Custom / 기타</option></select><input name="providerDisplayName" placeholder="Custom 공급자 이름"><textarea name="notes" placeholder="사용자 메모"></textarea><input type="hidden" name="promptRequestId" value="'+(r.id||'')+'"><input type="hidden" name="promptRevision" value="'+(r.revision||1)+'"><button type="submit">외부 AI 결과 업로드</button></form><div class="grid" data-manual-comparison><div><h4>원본 대표이미지</h4>'+(source?'<a href="'+attr(source)+'" target="_blank"><img src="'+attr(source)+'" alt="원본 대표이미지"></a>':'<p class="muted">원본 대표이미지 없음</p>')+'</div><div><h4>외부 AI 생성 이미지</h4>'+(latest?'<a href="'+attr(latest.coupangStoredUrl)+'" target="_blank"><img src="'+attr(latest.coupangStoredUrl)+'" alt="외부 AI 생성 이미지"></a><p>version '+latest.version+' / '+escapeHtml(latest.providerDisplayName||latest.providerCode)+' / '+escapeHtml(latest.status)+'</p><p>'+latest.width+'x'+latest.height+' / '+escapeHtml(latest.coupangMimeType||'')+' / '+escapeHtml(latest.createdAt||'')+'</p>':'<p class="muted" data-manual-empty>아직 업로드된 외부 AI 생성 이미지가 없습니다.</p>')+'</div></div><div data-manual-history>'+history+'</div><p><button type="button" data-manual-approve '+(latest?'':'disabled')+'>업로드 결과 승인</button> <button type="button" data-manual-reject '+(latest?'':'disabled')+'>업로드 결과 거절</button></p><div data-manual-message class="muted"></div></div>';}
    function manualDetailWorkflowHtmlV1(id,data,sets){const r=data.imagePromptState?.detailPage?.request||{},latest=sets[0]||null,thumbs=(latest?.images||[]).map(x=>'<a href="'+attr(x.normalizedStoredUrl)+'" target="_blank"><img src="'+attr(x.normalizedStoredUrl)+'" alt="'+x.imageIndex+'번 '+escapeHtml(x.sectionLabel)+'"><small>'+x.imageIndex+'. '+escapeHtml(x.sectionLabel)+' / '+x.normalizedWidth+'x'+x.normalizedHeight+'</small></a>').join('');return '<div class="section" data-manual-detail-workflow><h3>외부 AI 상세페이지 이미지 세트</h3><p><a class="packageDownload" href="/api/product-drafts/'+id+'/ai-workflows/detail-page/package">⬇ 상세페이지 작업 패키지 다운로드</a></p><p class="muted">HTML 상세페이지 v2와 반수동 AI 상세페이지 이미지 세트를 병행 관리합니다.</p><p><button type="button" data-detail-copy-rendered>상세페이지 치환 프롬프트 복사</button> <button type="button" data-detail-copy-original>상세페이지 원문 프롬프트 복사</button></p><div data-detail-copy-feedback class="muted"></div><form data-manual-detail-upload enctype="multipart/form-data"><input type="file" name="images[]" accept="image/png,image/jpeg,image/webp" multiple required><p class="muted">정확히 10장을 한 번에 선택하세요. 파일명 기준으로 자동 정렬되며, 순서가 다를 때만 썸네일을 드래그해 수정하세요.</p><ol data-detail-file-order></ol><select name="providerCode"><option value="chatgpt">ChatGPT</option><option value="google_gemini">Google Gemini</option><option value="anthropic_claude">Anthropic Claude</option><option value="custom">Custom / 기타</option></select><input name="providerDisplayName" placeholder="Custom 공급자 이름" hidden><textarea name="notes" placeholder="사용자 메모"></textarea><input type="hidden" name="promptRequestId" value="'+(r.id||'')+'"><input type="hidden" name="promptRevision" value="'+(r.revision||1)+'"><button type="submit">상세페이지 이미지 세트 업로드</button></form><div class="grid" data-detail-thumbnails>'+ (thumbs||'<p class="muted">생성된 상세페이지 이미지 세트 없음</p>')+'</div><p>세트 '+(latest?'v'+latest.setVersion+' / '+escapeHtml(latest.status)+' / '+latest.imageCount+'장':'없음')+'</p><p><button type="button" data-detail-approve '+(latest?.status==='uploaded'?'':'disabled')+'>세트 승인</button> <button type="button" data-detail-reject '+(latest?.status==='uploaded'?'':'disabled')+'>세트 거절</button></p><div data-detail-message class="muted"></div></div>';}
    async function renderAiPromptSectionsV1(id){const [data,resultData]=await Promise.all([api('/api/product-drafts/'+id+'/debug-export'),api('/api/product-drafts/'+id+'/ai-workflows/main-image/results')]);const panel=document.querySelector('#detail [data-panel="image"]');if(!panel)return;panel.innerHTML=promptCardV1('main_image','AI 대표이미지 프롬프트',data)+manualWorkflowHtmlV1(id,data,resultData.results||[])+promptCardV1('detail_page','AI 이미지형 상세페이지 프롬프트',data);panel.querySelectorAll('[data-prompt-create]').forEach(b=>b.onclick=async()=>{await api('/api/product-drafts/'+id+'/image-prompts/'+b.dataset.promptCreate,{method:'POST',body:'{}'});await renderAiPromptSectionsV1(id)});panel.querySelectorAll('[data-prompt-regenerate]').forEach(b=>b.onclick=async()=>{await api('/api/product-drafts/'+id+'/image-prompts/'+b.dataset.promptRegenerate+'/regenerate',{method:'POST',body:JSON.stringify({confirm:true})});await renderAiPromptSectionsV1(id)});panel.querySelectorAll('[data-prompt-status-v1]').forEach(b=>b.onclick=async()=>{await api('/api/product-drafts/'+id+'/image-prompts/'+b.dataset.promptKind,{method:'PATCH',body:JSON.stringify({status:b.dataset.promptStatusV1})});await renderAiPromptSectionsV1(id)});panel.querySelectorAll('[data-copy-target]').forEach(b=>b.onclick=()=>copyText(panel.querySelector('[data-prompt-text="'+b.dataset.copyTarget+'"]').textContent));panel.querySelectorAll('[data-toggle-original]').forEach(b=>b.onclick=()=>{const wrap=panel.querySelector('[data-original-wrap="'+b.dataset.toggleOriginal+'"]');wrap.hidden=!wrap.hidden;b.textContent=wrap.hidden?'원문 보기':'원문 숨기기';});const workflow=panel.querySelector('[data-manual-main-image-workflow]'),request=data.imagePromptState?.mainImage?.request||{},latest=(resultData.results||[])[0];workflow.querySelector('[data-copy-rendered]').onclick=async()=>{await copyText(request.promptRendered||'');workflow.querySelector('[data-copy-feedback]').textContent='복사 완료 / revision '+(request.revision||1)+' / '+(request.templateHash||'').slice(0,12)};workflow.querySelector('[data-copy-original]').onclick=async()=>{await copyText(request.promptOriginal||'');workflow.querySelector('[data-copy-feedback]').textContent='복사 완료 / revision '+(request.revision||1)+' / '+(request.templateHash||'').slice(0,12)};workflow.querySelector('[name="providerCode"]').onchange=e=>workflow.querySelector('[name="providerDisplayName"]').hidden=e.target.value!=='custom';workflow.querySelector('[data-manual-upload]').onsubmit=async event=>{event.preventDefault();const response=await fetch('/api/product-drafts/'+id+'/ai-workflows/main-image/upload',{method:'POST',body:new FormData(event.target)});const value=await response.json();if(!response.ok){workflow.querySelector('[data-manual-message]').textContent=value.error;return}await renderAiPromptSectionsV1(id)};workflow.querySelector('[data-manual-approve]').onclick=async()=>{if(latest){await api('/api/product-drafts/'+id+'/ai-workflows/main-image/results/'+latest.id+'/approve',{method:'POST',body:'{}'});await renderAiPromptSectionsV1(id)}};workflow.querySelector('[data-manual-reject]').onclick=async()=>{if(latest){await api('/api/product-drafts/'+id+'/ai-workflows/main-image/results/'+latest.id+'/reject',{method:'POST',body:'{}'});await renderAiPromptSectionsV1(id)}};}
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





