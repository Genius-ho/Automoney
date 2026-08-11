import http from 'node:http';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

import { loadAiSecrets, loadCodexConfig, loadCoupangConfig, loadDatabaseUrl, loadDomemePrivateConfig, loadEnvConfig, loadJobPathsConfig, loadNaverCommerceConfig, loadNaverConfig, loadPricingRules, loadPythonConfig, loadTelegramConfig } from './config.mjs';
import { sendCriticalAlert } from './telegram-notifier.mjs';
import { DomemeClient } from './domeme-client.mjs';
import { runCandidateDiscoveryBatch, runDueProductAutomationStage, runNextProductAutomationStage } from './auto-discovery-batch.mjs';
import { getBatchScheduleState, updateBatchScheduleState } from './batch-schedule-store.mjs';
import { getBatchRunDetail, listBatchRuns } from './batch-run-store.mjs';
import { countActiveQueueItems, getNextQueueItem, listQueue, updateQueueItemStatus } from './processing-queue-store.mjs';
import { uploadApprovedImagesToR2 } from './r2-publisher.mjs';
import { clearProviderCredential, listProviderSettings, listTaskRouting, saveProviderSetting, saveTaskRouting, testProviderSetting } from './ai/provider-settings-store.mjs';
import { NaverShoppingClient } from './naver-shopping-client.mjs';
import { researchNaverDraft } from './naver-research.mjs';
import { CoupangApiError, CoupangClient } from './coupang-client.mjs';
import { buildImageOnlyFragments, mapLiveProductToUpdatePayload } from './coupang-payload-builder.mjs';
import { getApprovedManualMainImage } from './manual-ai/workflow-store.mjs';
import { getApprovedManualDetailSet } from './manual-ai/detail-workflow-store.mjs';
import { getCoupangRegistration, linkCoupangRegistration, listCoupangRegistrations, recordImagesSwapped, recordLiveSnapshot } from './coupang-registration-store.mjs';
import { applyProductAnalysis, buildApplyPreview, getAppliedAnalysis, getAnalysisRun, getLatestAnalysisRun, listAnalysisRuns, runProductAnalysis } from './product-analysis-orchestrator.mjs';
import { buildRegistrationPreview, createDirectRegistration, extractList, previewCategoryAndShipping, requestCoupangSaleApproval, selectRegistrationTarget, validateSellerShippingSettings } from './coupang-registration-flow.mjs';
import { getSellerShippingSettings, saveSellerShippingSettings } from './coupang-seller-settings-store.mjs';
import { NaverCommerceClient, NaverCommerceApiError } from './naver-commerce-client.mjs';
import { createNaverDirectRegistration } from './naver-registration-flow.mjs';
import { buildNaverPriceUpdatePayload } from './naver-registration-post-process.mjs';
import { getNaverRegistration, linkNaverRegistration, recordImagesSwapped as recordNaverImagesSwapped } from './naver-registration-store.mjs';
import { mapLiveNaverProductToImageSwapPayload } from './naver-payload-builder.mjs';
import { createPgPool, runSchema } from './postgres-store.mjs';
import { listChannelOrders } from './channel-orders-store.mjs';
import { maskOrderForLog } from './order-collector.mjs';
import { DomemePrivateApiError, DomemePrivateClient } from './domeme-private-client.mjs';
import { getValidDomemeSId } from './domeme-private-session.mjs';
import { listSupplierOrdersForAdmin } from './purchase-order-store.mjs';
import { approveSupplierOrder } from './purchase-order-approval.mjs';
import { listOrderExceptionsForAdmin, resolveOrderException } from './order-exception-store.mjs';
import { getDashboardSummary } from './dashboard-store.mjs';
import { listSupplierAlerts, acknowledgeSupplierAlert } from './supplier-alert-store.mjs';
import { startScheduledJobs, stopScheduledJobs } from './scheduler.mjs';
import { attemptSupplierCancellation } from './cancellation-handler.mjs';
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
import { generateDetailImageSet, generateMainImage } from './manual-ai/codex-image-runner.mjs';
import { handleApprovedImages } from './image-approval-registration.mjs';
import { listApprovalInbox } from './approval-inbox-store.mjs';
import { approveInboxImages, retryFailedInboxItem } from './approval-inbox-service.mjs';
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

const AUTO_BATCH_TICK_INTERVAL_MS = 5 * 60 * 1000;

const QUEUE_STATUS_LABELS = Object.freeze({
  queued: '대기 중', draft_created: '드래프트 생성 완료', analyzing: '분석 중', analysis_completed: '분석 완료',
  generating_images: '이미지 생성 중', awaiting_image_approval: '이미지 승인 대기', registering: '쿠팡 등록 중',
  awaiting_sale_approval: '판매승인 대기', completed: '완료', failed: '실패',
});

export function getQueueStatusLabel(status) {
  return QUEUE_STATUS_LABELS[status] || status;
}

export async function approveImageAndMaybeRegister(db, rootDir, draftId, imageId, approvalNote, {
  approveImpl,
  handleApprovedImagesImpl = handleApprovedImages,
  loadCoupangConfigImpl = loadCoupangConfig,
  loadTelegramConfigImpl = loadTelegramConfig,
  createCoupangClientImpl = (config) => new CoupangClient(config),
} = {}) {
  const result = await approveImpl(db, draftId, imageId, approvalNote || null);
  const [coupangConfig, telegramConfig] = await Promise.all([
    loadCoupangConfigImpl(rootDir), loadTelegramConfigImpl(rootDir),
  ]);
  const coupangClient = createCoupangClientImpl(coupangConfig);
  const autoRegistration = await handleApprovedImagesImpl(db, rootDir, draftId, {
    coupangConfig, telegramConfig, coupangClient,
  });
  return { result, autoRegistration };
}

export async function getApprovalInboxResponse(db, {
  listApprovalInboxImpl = listApprovalInbox,
} = {}) {
  return { status: 200, body: await listApprovalInboxImpl(db) };
}

function approvalInboxErrorResponse(error) {
  const conflicts = new Set(['QUEUE_NOT_APPROVABLE', 'IMAGES_NOT_READY', 'IMAGE_APPROVAL_FAILED', 'RETRY_NOT_SAFE']);
  return {
    status: conflicts.has(error?.code) ? 409 : 500,
    body: { error: error?.message || String(error), code: error?.code || 'APPROVAL_INBOX_ERROR' },
  };
}

export async function approveInboxImagesResponse(db, rootDir, draftId, {
  approveInboxImagesImpl = approveInboxImages,
} = {}) {
  try {
    return { status: 200, body: await approveInboxImagesImpl(db, rootDir, draftId) };
  } catch (error) {
    return approvalInboxErrorResponse(error);
  }
}

export async function retryApprovalInboxResponse(db, queueId, {
  retryFailedInboxItemImpl = retryFailedInboxItem,
} = {}) {
  try {
    return { status: 200, body: await retryFailedInboxItemImpl(db, queueId) };
  } catch (error) {
    return approvalInboxErrorResponse(error);
  }
}

// Loaded once at startup, not per-tick -- Domeme credentials, pricing rules,
// and Codex/Python/job-path config don't change during the process
// lifetime. Missing/invalid config here disables the auto-discovery
// scheduler tick (logged, not fatal) rather than crashing the whole admin
// server, since nothing else in admin-server.mjs required Domeme/
// pricing-rules.json access before this feature.
async function loadAutoBatchDeps(rootDir) {
  try {
    const envConfig = await loadEnvConfig(rootDir);
    const pricingRules = await loadPricingRules(join(rootDir, 'pricing-rules.json'));
    const domemeClientImpl = new DomemeClient({ apiKey: envConfig.domemeApiKey, endpoint: envConfig.domemeEndpoint });
    const [codexConfig, pythonConfig, jobPathsConfig] = await Promise.all([
      loadCodexConfig(rootDir), loadPythonConfig(rootDir), loadJobPathsConfig(rootDir),
    ]);
    return { domemeClientImpl, pricingRules, codexConfig, pythonConfig, jobPathsConfig };
  } catch (error) {
    console.error(`autoBatch.configUnavailable=${error.message}`);
    return null;
  }
}

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

  const autoBatchDeps = await loadAutoBatchDeps(rootDir);
  const telegramConfig = await loadTelegramConfig(rootDir);
  const tickHandle = setInterval(async () => {
    if (!autoBatchDeps) return;
    try {
      const result = await runDueProductAutomationStage(db, { rootDir, ...autoBatchDeps });
      if (!result.skipped) console.log(`autoBatch.stageTick=${result.stage}:${result.outcome?.outcome || result.outcome?.reason || 'completed'}`);
    } catch (error) {
      console.error(`autoBatch.tickError=${error.message}`);
      try {
        await sendCriticalAlert(telegramConfig, 'autoBatch.tick', error.message);
      } catch (alertError) {
        console.error(`autoBatch.tickAlertFailed=${alertError.message}`);
      }
    }
  }, AUTO_BATCH_TICK_INTERVAL_MS);
  tickHandle.unref?.();

  // Phase 6-10's own periodic sweeps (section 18) -- see scheduler.mjs's
  // header comment for why this is separate from the autoBatch tick above
  // rather than folded into it.
  const scheduledJobHandles = await startScheduledJobs(db, rootDir);

  server.on('close', () => {
    clearInterval(tickHandle);
    stopScheduledJobs(scheduledJobHandles);
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
  if (url.pathname === '/api/approval-inbox' && request.method === 'GET') {
    const result = await getApprovalInboxResponse(db);
    sendJson(response, result.status, result.body);
    return;
  }
  const approvalInboxImagesMatch = url.pathname.match(/^\/api\/approval-inbox\/drafts\/(\d+)\/approve-images$/);
  if (approvalInboxImagesMatch && request.method === 'POST') {
    const result = await approveInboxImagesResponse(db, rootDir, Number(approvalInboxImagesMatch[1]));
    sendJson(response, result.status, result.body);
    return;
  }
  const approvalInboxRetryMatch = url.pathname.match(/^\/api\/approval-inbox\/queue\/(\d+)\/retry$/);
  if (approvalInboxRetryMatch && request.method === 'POST') {
    const result = await retryApprovalInboxResponse(db, Number(approvalInboxRetryMatch[1]));
    sendJson(response, result.status, result.body);
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
  const mainImageCodexGenerateMatch=url.pathname.match(/^\/api\/product-drafts\/(\d+)\/ai-workflows\/main-image\/codex-generate$/);
  if(mainImageCodexGenerateMatch&&request.method==='POST'){
    const draftId=Number(mainImageCodexGenerateMatch[1]);
    try{
      const [codexConfig,jobPathsConfig]=await Promise.all([loadCodexConfig(rootDir),loadJobPathsConfig(rootDir)]);
      const outcome=await generateMainImage(db,rootDir,jobPathsConfig.jobDir,draftId,{codexConfig});
      sendJson(response,201,{result:outcome.result,generatedFileCount:outcome.generatedFileCount});
    }catch(error){sendWorkflowError(response,error);}
    return;
  }
  const manualUploadMatch=url.pathname.match(/^\/api\/product-drafts\/(\d+)\/ai-workflows\/main-image\/upload$/);
  if(manualUploadMatch&&request.method==='POST'){const draftId=Number(manualUploadMatch[1]);let stored=null;try{const context=await getManualMainImageWorkflowContext(db,draftId);const {image,fields}=await readManualImageMultipart(request);const metadata=validateManualWorkflowMetadata(context,fields);const validated=await validateManualMainImage(image.buffer,image.mimeType);const derivative=await createCoupangDerivative(image.buffer);const version=await getNextManualMainImageVersion(db,draftId);stored=await persistManualMainImageFiles({rootDir,draftId,revision:metadata.promptRevision,version,original:{buffer:image.buffer,mimeType:validated.mimeType},derivative});const result=await insertManualMainImage(db,{productDraftId:draftId,promptRequestId:metadata.promptRequestId,promptRevision:metadata.promptRevision,providerCode:metadata.providerCode,providerDisplayName:metadata.providerDisplayName,version,...stored,originalFileSize:validated.fileSize,coupangFileSize:derivative.fileSize,originalMimeType:validated.mimeType,originalWidth:validated.width,originalHeight:validated.height,sha256:createHash('sha256').update(image.buffer).digest('hex'),notes:metadata.notes});sendJson(response,201,{result});}catch(error){if(stored)await removeWorkflowFiles(rootDir,stored);sendWorkflowError(response,error);}return;}
  const manualActionMatch=url.pathname.match(/^\/api\/product-drafts\/(\d+)\/ai-workflows\/main-image\/results\/(\d+)\/(approve|reject)$/);
  if(manualActionMatch&&request.method==='POST'){try{const body=await readJson(request);const [draftId,imageId]=manualActionMatch.slice(1,3).map(Number);if(manualActionMatch[3]==='approve'){sendJson(response,200,await approveImageAndMaybeRegister(db,rootDir,draftId,imageId,body.approvalNote||null,{approveImpl:approveManualMainImage}));}else{sendJson(response,200,{result:await rejectManualMainImage(db,draftId,imageId,body.notes||null)});}}catch(error){sendWorkflowError(response,error);}return;}
  const detailPackageMatch=url.pathname.match(/^\/api\/product-drafts\/(\d+)\/ai-workflows\/detail-page\/package$/);
  if(detailPackageMatch&&request.method==='GET'){try{const draftId=Number(detailPackageMatch[1]);await createImagePromptRequest(db,draftId,'detail_page');const context=await getManualDetailWorkflowContext(db,draftId);const result=await buildDetailPagePackage(context,{fetchImpl:(value)=>fetchWorkflowAsset(value,rootDir),readLocalAsset:(value)=>readWorkflowAsset(value,rootDir)});sendBinary(response,200,result.buffer,'application/zip',result.filename);}catch(error){sendWorkflowError(response,error);}return;}
  const detailResultsMatch=url.pathname.match(/^\/api\/product-drafts\/(\d+)\/ai-workflows\/detail-page\/results$/);
  if(detailResultsMatch&&request.method==='GET'){sendJson(response,200,{sets:await listManualDetailSets(db,Number(detailResultsMatch[1]))});return;}
  const detailPageCodexGenerateMatch=url.pathname.match(/^\/api\/product-drafts\/(\d+)\/ai-workflows\/detail-page\/codex-generate$/);
  if(detailPageCodexGenerateMatch&&request.method==='POST'){
    const draftId=Number(detailPageCodexGenerateMatch[1]);
    try{
      const [codexConfig,jobPathsConfig]=await Promise.all([loadCodexConfig(rootDir),loadJobPathsConfig(rootDir)]);
      const outcome=await generateDetailImageSet(db,rootDir,jobPathsConfig.jobDir,draftId,{codexConfig});
      sendJson(response,201,{set:outcome.result,generatedFileCount:outcome.generatedFileCount});
    }catch(error){sendWorkflowError(response,error);}
    return;
  }
  const detailUploadMatch=url.pathname.match(/^\/api\/product-drafts\/(\d+)\/ai-workflows\/detail-page\/upload$/);
  if(detailUploadMatch&&request.method==='POST'){try{const result=await uploadManualDetailSet({db,request,rootDir,draftId:Number(detailUploadMatch[1])});sendJson(response,201,{set:result});}catch(error){sendWorkflowError(response,error);}return;}
  const detailActionMatch=url.pathname.match(/^\/api\/product-drafts\/(\d+)\/ai-workflows\/detail-page\/sets\/(\d+)\/(approve|reject)$/);
  if(detailActionMatch&&request.method==='POST'){try{const body=await readJson(request);const [draftId,setId]=detailActionMatch.slice(1,3).map(Number);if(detailActionMatch[3]==='approve'){sendJson(response,200,await approveImageAndMaybeRegister(db,rootDir,draftId,setId,body.approvalNote||null,{approveImpl:approveManualDetailSet}));}else{sendJson(response,200,{result:await rejectManualDetailSet(db,draftId,setId,body.notes||null)});}}catch(error){sendWorkflowError(response,error);}return;}
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

  const registrationTargetMatch = url.pathname === '/api/coupang-registration-flow/target';
  if (registrationTargetMatch && request.method === 'GET') {
    const preferredDraftId = Number(url.searchParams.get('preferredDraftId') || 46);
    const target = await selectRegistrationTarget(db, { preferredDraftId });
    sendJson(response, 200, { target });
    return;
  }

  const sellerSettingsMatch = url.pathname === '/api/coupang-seller-settings';
  if (sellerSettingsMatch && request.method === 'GET') {
    try {
      const coupangConfig = await loadCoupangConfig(rootDir);
      const client = new CoupangClient(coupangConfig);
      const [settings, validation, outboundRaw, returnRaw] = await Promise.all([
        getSellerShippingSettings(db),
        validateSellerShippingSettings(db, { clientImpl: client }),
        client.listOutboundShippingPlaces(),
        client.listReturnShippingCenters(),
      ]);
      sendJson(response, 200, { settings, validation, outboundCandidates: extractList(outboundRaw), returnCandidates: extractList(returnRaw) });
    } catch (error) {
      if (error instanceof CoupangApiError) { sendJson(response, 502, { error: error.message, code: 'COUPANG_API_ERROR', bodyPreview: error.bodyPreview }); return; }
      throw error;
    }
    return;
  }
  if (sellerSettingsMatch && request.method === 'POST') {
    try {
      const body = await readJson(request);
      const settings = await saveSellerShippingSettings(db, {
        outboundShippingPlaceCode: body.outboundShippingPlaceCode,
        outboundShippingPlaceName: body.outboundShippingPlaceName || null,
        returnCenterCode: body.returnCenterCode,
        returnCenterName: body.returnCenterName || null,
      });
      sendJson(response, 200, { settings });
    } catch (error) {
      sendJson(response, 422, { error: error.message });
    }
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

  // 가격 조정 (스피드고로 등록한 뒤 Claude가 이미지 교체와 함께 가격도 조정할 수 있게).
  // Coupang prices per vendorItemId, not per product -- since no vendorItemId
  // is stored anywhere (same gap order-supplier-mapper.mjs/channel-suspension.mjs
  // hit), this always fetches the live item list first so the admin can see
  // current prices and pick one. Two-step dry-run: no vendorItemId/price yet
  // -> just return the live items; vendorItemId+price without confirm ->
  // preview the planned change; confirm:true -> the real PUT.
  const coupangPriceMatch = url.pathname.match(/^\/api\/product-drafts\/(\d+)\/coupang-registration\/update-price$/);
  if (coupangPriceMatch && request.method === 'POST') {
    const draftId = Number(coupangPriceMatch[1]);
    try {
      const registration = await getCoupangRegistration(db, draftId);
      if (!registration?.sellerProductId) { sendJson(response, 409, { error: 'This draft is not linked to a Coupang sellerProductId yet', code: 'NOT_LINKED' }); return; }
      const body = await readJson(request);
      const config = await loadCoupangConfig(rootDir);
      const client = new CoupangClient(config);
      const live = await client.getProduct(registration.sellerProductId);
      const items = (live?.data?.items || []).map((item) => ({ vendorItemId: item.vendorItemId, vendorItemName: item.vendorItemName, salePrice: item.salePrice }));

      const price = Number(body.price);
      if (!body.vendorItemId || !Number.isFinite(price)) { sendJson(response, 200, { dryRun: true, items }); return; }
      if (price % 10 !== 0) { sendJson(response, 400, { error: 'price must be in increments of 10 won', code: 'INVALID_PRICE' }); return; }
      if (body.confirm !== true) { sendJson(response, 200, { dryRun: true, items, plannedChange: { vendorItemId: body.vendorItemId, price } }); return; }

      const result = await client.updateItemPrice(body.vendorItemId, price, { forceSalePriceUpdate: body.forceSalePriceUpdate === true });
      sendJson(response, 200, { dryRun: false, result });
    } catch (error) {
      if (error instanceof CoupangApiError) { sendJson(response, 502, { error: error.message, code: 'COUPANG_API_ERROR', bodyPreview: error.bodyPreview }); return; }
      throw error;
    }
    return;
  }

  const naverRegistrationSingleMatch = url.pathname.match(/^\/api\/product-drafts\/(\d+)\/naver-registration$/);
  if (naverRegistrationSingleMatch && request.method === 'GET') {
    const registration = await getNaverRegistration(db, Number(naverRegistrationSingleMatch[1]));
    sendJson(response, 200, { registration });
    return;
  }

  // 네이버 상품 링크 -- 스피드등록으로 이미 등록된 상품의 originProductNo를 이 draft에 연결.
  // Naver has no confirmed name-search endpoint (unlike Coupang's
  // listSellerProducts, see registrationLookupMatch above), so this takes
  // originProductNo directly rather than a search-and-pick flow.
  const naverRegistrationLinkMatch = url.pathname.match(/^\/api\/product-drafts\/(\d+)\/naver-registration\/link$/);
  if (naverRegistrationLinkMatch && request.method === 'POST') {
    const draftId = Number(naverRegistrationLinkMatch[1]);
    const body = await readJson(request);
    if (!body.originProductNo) { sendJson(response, 400, { error: 'originProductNo is required' }); return; }
    const registration = await linkNaverRegistration(db, draftId, { originProductNo: body.originProductNo });
    sendJson(response, 200, { registration });
    return;
  }

  // 네이버 쪽 가격 조정 -- Naver's option-stock endpoint requires optionInfo
  // even for a no-option product (confirmed live, 2026-07-26: draft 46's
  // real originProduct.detailAttribute.optionInfo is
  // { optionCombinations: [], optionStandards: [], useStockManagement: true }
  // for a plain product with no options at all) -- so this always reads the
  // live product first and passes its own optionInfo straight through
  // rather than reconstructing one, to avoid guessing at a shape for a
  // multi-option product that's never been exercised live.
  const naverPriceMatch = url.pathname.match(/^\/api\/product-drafts\/(\d+)\/naver-registration\/update-price$/);
  if (naverPriceMatch && request.method === 'POST') {
    const draftId = Number(naverPriceMatch[1]);
    try {
      const registration = await getNaverRegistration(db, draftId);
      if (!registration?.originProductNo) { sendJson(response, 409, { error: 'This draft is not linked to a Naver originProductNo yet', code: 'NOT_LINKED' }); return; }
      const body = await readJson(request);
      const config = await loadNaverCommerceConfig(rootDir);
      const client = new NaverCommerceClient(config);
      const live = await client.getProduct(registration.originProductNo);
      const currentSalePrice = live?.originProduct?.salePrice ?? null;

      const salePrice = Number(body.salePrice);
      if (!Number.isFinite(salePrice)) { sendJson(response, 200, { dryRun: true, currentSalePrice }); return; }
      const payload = buildNaverPriceUpdatePayload(live, salePrice);
      if (body.confirm !== true) { sendJson(response, 200, { dryRun: true, currentSalePrice, payload }); return; }

      await client.updateOptionStock(registration.originProductNo, payload);
      const after = await client.getProduct(registration.originProductNo);
      sendJson(response, 200, { dryRun: false, before: { salePrice: currentSalePrice }, after: { salePrice: after?.originProduct?.salePrice ?? null } });
    } catch (error) {
      if (error instanceof NaverCommerceApiError) { sendJson(response, 502, { error: error.message, code: 'NAVER_API_ERROR', bodyPreview: error.bodyPreview }); return; }
      throw error;
    }
    return;
  }

  // 네이버 이미지 교체 -- mirrors registrationSwapMatch (Coupang) above, using
  // updateOriginProduct/mapLiveNaverProductToImageSwapPayload instead.
  const naverSwapMatch = url.pathname.match(/^\/api\/product-drafts\/(\d+)\/naver-registration\/swap-images$/);
  if (naverSwapMatch && request.method === 'POST') {
    const draftId = Number(naverSwapMatch[1]);
    try {
      const body = await readJson(request);
      const registration = await getNaverRegistration(db, draftId);
      if (!registration?.originProductNo) { sendJson(response, 409, { error: 'This draft is not linked to a Naver originProductNo yet', code: 'NOT_LINKED' }); return; }
      const mainImage = await getApprovedManualMainImage(db, draftId);
      const detailSet = await getApprovedManualDetailSet(db, draftId);
      if (!mainImage || !detailSet) { sendJson(response, 409, { error: 'Approved main image and/or approved detail-page image set are missing', code: 'IMAGES_NOT_APPROVED' }); return; }
      const { mainImageUrl, detailImageUrls } = await uploadApprovedImagesToR2({
        rootDir,
        draftId,
        mainImageLocalUrl: mainImage.coupangStoredUrl,
        detailImageLocalUrls: detailSet.images.map((image) => image.normalizedStoredUrl),
      });
      const config = await loadNaverCommerceConfig(rootDir);
      const client = new NaverCommerceClient(config);
      const live = await client.getProduct(registration.originProductNo);
      const payload = mapLiveNaverProductToImageSwapPayload(live, { mainImageUrl, detailImageUrls });

      await mkdir(`${rootDir}/artifacts`, { recursive: true });
      await writeFile(`${rootDir}/artifacts/naver-swap-payload-draft-${draftId}-${Date.now()}.json`, JSON.stringify(payload, null, 2));

      if (body.confirm !== true) { sendJson(response, 200, { dryRun: true, payload }); return; }

      await client.updateOriginProduct(registration.originProductNo, payload);
      await recordNaverImagesSwapped(db, draftId);
      const after = await client.getProduct(registration.originProductNo);
      sendJson(response, 200, { dryRun: false, before: live, after });
    } catch (error) {
      if (error instanceof NaverCommerceApiError) { sendJson(response, 502, { error: error.message, code: 'NAVER_API_ERROR', bodyPreview: error.bodyPreview }); return; }
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

  const categoryPreviewMatch = url.pathname.match(/^\/api\/product-drafts\/(\d+)\/coupang-registration\/category-preview$/);
  if (categoryPreviewMatch && request.method === 'GET') {
    const draftId = Number(categoryPreviewMatch[1]);
    try {
      const coupangConfig = await loadCoupangConfig(rootDir);
      const client = new CoupangClient(coupangConfig);
      const { prediction, categoryMeta, outboundShippingPlace, returnShippingCenter, outboundCandidates, returnCandidates } =
        await previewCategoryAndShipping(db, draftId, { coupangConfig, clientImpl: client });
      sendJson(response, 200, { prediction, categoryMeta, outboundShippingPlace, returnShippingCenter, outboundCandidates, returnCandidates });
    } catch (error) {
      if (error instanceof CoupangApiError) { sendJson(response, 502, { error: error.message, code: 'COUPANG_API_ERROR', bodyPreview: error.bodyPreview }); return; }
      if (error.code === 'DRAFT_NOT_FOUND') { sendJson(response, 404, { error: error.message, code: error.code }); return; }
      throw error;
    }
    return;
  }

  const registrationPreviewMatch = url.pathname.match(/^\/api\/product-drafts\/(\d+)\/coupang-registration\/preview$/);
  if (registrationPreviewMatch && request.method === 'POST') {
    const draftId = Number(registrationPreviewMatch[1]);
    try {
      const body = await readJson(request);
      const coupangConfig = await loadCoupangConfig(rootDir);
      const client = new CoupangClient(coupangConfig);
      const preview = await buildRegistrationPreview(db, rootDir, draftId, { overrides: body.overrides || {}, coupangConfig, clientImpl: client });
      sendJson(response, 200, preview);
    } catch (error) {
      if (error instanceof CoupangApiError) { sendJson(response, 502, { error: error.message, code: 'COUPANG_API_ERROR', bodyPreview: error.bodyPreview }); return; }
      if (['DRAFT_PROTECTED', 'IMAGES_NOT_APPROVED', 'DRAFT_NOT_FOUND'].includes(error.code)) { sendJson(response, 409, { error: error.message, code: error.code }); return; }
      throw error;
    }
    return;
  }

  const registrationCreateMatch = url.pathname.match(/^\/api\/product-drafts\/(\d+)\/coupang-registration\/register$/);
  if (registrationCreateMatch && request.method === 'POST') {
    const draftId = Number(registrationCreateMatch[1]);
    try {
      const body = await readJson(request);
      const coupangConfig = await loadCoupangConfig(rootDir);
      const client = new CoupangClient(coupangConfig);
      const result = await createDirectRegistration(db, rootDir, draftId, { overrides: body.overrides || {}, confirm: body.confirm === true, coupangConfig, clientImpl: client });
      sendJson(response, 200, result);
    } catch (error) {
      if (error instanceof CoupangApiError) { sendJson(response, 502, { error: error.message, code: 'COUPANG_API_ERROR', bodyPreview: error.bodyPreview }); return; }
      if (['DRAFT_PROTECTED', 'ALREADY_REGISTERED'].includes(error.code)) { sendJson(response, 409, { error: error.message, code: error.code, existing: error.existing }); return; }
      if (error.code === 'REGISTRATION_NOT_READY') { sendJson(response, 409, { error: error.message, code: error.code, readiness: error.readiness }); return; }
      if (error.code === 'RECORD_CONFLICT_AFTER_CREATE' || error.code === 'CREATE_PRODUCT_NO_ID') { sendJson(response, 502, { error: error.message, code: error.code, sellerProductId: error.sellerProductId }); return; }
      throw error;
    }
    return;
  }

  const requestApprovalMatch = url.pathname.match(/^\/api\/product-drafts\/(\d+)\/coupang-registration\/request-approval$/);
  if (requestApprovalMatch && request.method === 'POST') {
    const draftId = Number(requestApprovalMatch[1]);
    try {
      const coupangConfig = await loadCoupangConfig(rootDir);
      const client = new CoupangClient(coupangConfig);
      const result = await requestCoupangSaleApproval(db, draftId, { coupangConfig, clientImpl: client });
      sendJson(response, 200, result);
    } catch (error) {
      if (error instanceof CoupangApiError) { sendJson(response, 502, { error: error.message, code: 'COUPANG_API_ERROR', bodyPreview: error.bodyPreview }); return; }
      if (['DRAFT_PROTECTED', 'NOT_LINKED', 'ALREADY_REQUESTED', 'NOT_TEMPORARY_SAVED'].includes(error.code)) { sendJson(response, 409, { error: error.message, code: error.code, existing: error.existing, liveStatusName: error.liveStatusName }); return; }
      throw error;
    }
    return;
  }

  if (url.pathname === '/api/auto-batch/schedule' && request.method === 'GET') {
    sendJson(response, 200, { schedule: await getBatchScheduleState(db) });
    return;
  }

  if (url.pathname === '/api/auto-batch/schedule' && request.method === 'PATCH') {
    const body = await readJson(request);
    const schedule = await updateBatchScheduleState(db, {
      intervalDays: body.intervalDays != null ? Number(body.intervalDays) : undefined,
      nextRunAt: body.nextRunAt || undefined,
      minPassingScore: body.minPassingScore != null ? Number(body.minPassingScore) : undefined,
      processingIntervalDays: body.processingIntervalDays != null ? Number(body.processingIntervalDays) : undefined,
      processingNextRunAt: body.processingNextRunAt || undefined,
    });
    sendJson(response, 200, { schedule });
    return;
  }

  if (url.pathname === '/api/auto-batch/discovery/run-now' && request.method === 'POST') {
    const autoBatchDeps = await loadAutoBatchDeps(rootDir);
    if (!autoBatchDeps) { sendJson(response, 503, { error: 'Domeme 설정 또는 pricing-rules.json을 불러올 수 없어 배치를 실행할 수 없습니다', code: 'AUTO_BATCH_CONFIG_UNAVAILABLE' }); return; }
    const result = await runCandidateDiscoveryBatch(db, { rootDir, ...autoBatchDeps });
    sendJson(response, result.skipped ? 409 : 200, result);
    return;
  }

  if (url.pathname === '/api/auto-batch/processing/run-now' && request.method === 'POST') {
    const autoBatchDeps = await loadAutoBatchDeps(rootDir);
    if (!autoBatchDeps) { sendJson(response, 503, { error: 'Domeme 설정 또는 pricing-rules.json을 불러올 수 없어 배치를 실행할 수 없습니다', code: 'AUTO_BATCH_CONFIG_UNAVAILABLE' }); return; }
    const result = await runNextProductAutomationStage(db, { rootDir, ...autoBatchDeps });
    sendJson(response, result.skipped ? 409 : 200, result);
    return;
  }

  // Phase 7 (section 12.5): "매핑 실패 관리자 표시" -- admin-facing list of
  // collected channel orders, filterable to the ones order-supplier-mapper.mjs
  // couldn't resolve. Recipient PII masked per section 21 (never in the DB
  // itself, only here and in logs -- see order-collector.mjs's maskOrderForLog).
  if (url.pathname === '/api/channel-orders' && request.method === 'GET') {
    const channel = url.searchParams.get('channel') || undefined;
    const supplierMappingStatus = url.searchParams.get('mappingStatus') || undefined;
    const orders = await listChannelOrders(db, { channel, supplierMappingStatus });
    sendJson(response, 200, { orders: orders.map(maskOrderForLog) });
    return;
  }

  // Phase 8 (section 13.1 사전 확인) -- read-only: logs in (reusing a cached
  // session when still valid) and checks the e-money balance. Never creates,
  // cancels, or otherwise touches an order. "주문 생성 API 사용 가능 여부" and
  // "배송대행 주문 지원 여부" can't be verified without placing a real order, so
  // those stay manual checklist items in the UI rather than fields this
  // route can honestly report on.
  if (url.pathname === '/api/domeme/precheck' && request.method === 'GET') {
    try {
      const config = await loadDomemePrivateConfig(rootDir);
      const client = new DomemePrivateClient(config);
      const sId = await getValidDomemeSId(db, client);
      const asset = await client.getMyAsset({ sId });
      sendJson(response, 200, {
        ok: true,
        loginId: config.loginId,
        emoneyCash: asset.emoneyCash,
        emoneyTotal: asset.emoneyTotal,
        checkedAt: new Date().toISOString(),
      });
    } catch (error) {
      if (error instanceof DomemePrivateApiError) {
        sendJson(response, 502, { ok: false, error: error.message, dcode: error.dcode, dmessage: error.dmessage });
        return;
      }
      sendJson(response, 500, { ok: false, error: error.message });
    }
    return;
  }

  // Phase 8 (section 13.4 발주안 화면) -- listing of supplier_orders drafts
  // joined with their channel-order context. The actual order-placement
  // action is the separate POST .../approve route below.
  if (url.pathname === '/api/purchase-orders' && request.method === 'GET') {
    const status = url.searchParams.get('status') || undefined;
    const orders = await listSupplierOrdersForAdmin(db, { status });
    sendJson(response, 200, { orders: orders.map(maskOrderForLog) });
    return;
  }

  // The one action in this whole app that spends real money without any
  // further confirmation step below it -- requires body.confirm === true
  // (the admin UI gets there via a native window.confirm prompt) and
  // re-validates immediately before ordering (see approveSupplierOrder's
  // own re-check). 3.4 금전 단계 승인 게이트: this route is the gate.
  const purchaseOrderApproveMatch = url.pathname.match(/^\/api\/purchase-orders\/(\d+)\/approve$/);
  if (purchaseOrderApproveMatch && request.method === 'POST') {
    const supplierOrderId = Number(purchaseOrderApproveMatch[1]);
    const body = await readJson(request);
    if (body.confirm !== true) { sendJson(response, 400, { error: 'confirm: true is required to place a real order', code: 'CONFIRM_REQUIRED' }); return; }
    try {
      const config = await loadDomemePrivateConfig(rootDir);
      const client = new DomemePrivateClient(config);
      const result = await approveSupplierOrder(db, client, supplierOrderId);
      sendJson(response, 200, { order: result });
    } catch (error) {
      if (error instanceof DomemePrivateApiError) { sendJson(response, 502, { error: error.message, dcode: error.dcode, dmessage: error.dmessage }); return; }
      const statuses = { NOT_FOUND: 404, NOT_APPROVABLE: 409, CHANNEL_ORDER_NOT_FOUND: 404, ALREADY_IN_PROGRESS: 409 };
      sendJson(response, statuses[error.code] || 500, { error: error.message, code: error.code });
    }
    return;
  }

  // 대시보드 (section 16.1) -- read-only aggregate counts.
  if (url.pathname === '/api/dashboard' && request.method === 'GET') {
    const summary = await getDashboardSummary(db);
    sendJson(response, 200, { summary });
    return;
  }

  // 공급처 감시 알림 (section 16.5) -- Phase 6's runSupplierMonitorSweep
  // alerts, persisted since channel-suspension.mjs's sweep wrapper. GET
  // lists open ones; POST acknowledge is the only status change (this app
  // never auto-resolves a price/MOQ/stock alert).
  if (url.pathname === '/api/supplier-alerts' && request.method === 'GET') {
    const status = url.searchParams.get('status') || 'open';
    const alerts = await listSupplierAlerts(db, { status });
    sendJson(response, 200, { alerts });
    return;
  }
  const supplierAlertAckMatch = url.pathname.match(/^\/api\/supplier-alerts\/(\d+)\/acknowledge$/);
  if (supplierAlertAckMatch && request.method === 'POST') {
    const alertId = Number(supplierAlertAckMatch[1]);
    const result = await acknowledgeSupplierAlert(db, alertId);
    if (!result) { sendJson(response, 404, { error: 'Supplier alert not found' }); return; }
    sendJson(response, 200, { result });
    return;
  }

  // Phase 10 (section 15) 관리자 예외 큐 -- 취소/반품/교환, none of which this
  // route ever processes automatically. GET lists it; the two POST actions
  // below are the only ways an exception's status changes.
  if (url.pathname === '/api/order-exceptions' && request.method === 'GET') {
    const status = url.searchParams.get('status') || 'open';
    const exceptionType = url.searchParams.get('exceptionType') || undefined;
    const exceptions = await listOrderExceptionsForAdmin(db, { status, exceptionType });
    sendJson(response, 200, { exceptions: exceptions.map(maskOrderForLog) });
    return;
  }

  // 15.1 "공급처 취소 가능 여부 관리자 확인" -- the one automatic action Phase 10
  // performs, and only for CANCEL_NOT_SHIPPED, only from this explicit click.
  const exceptionCancelMatch = url.pathname.match(/^\/api\/order-exceptions\/(\d+)\/attempt-supplier-cancel$/);
  if (exceptionCancelMatch && request.method === 'POST') {
    const exceptionId = Number(exceptionCancelMatch[1]);
    try {
      const config = await loadDomemePrivateConfig(rootDir);
      const client = new DomemePrivateClient(config);
      const sId = await getValidDomemeSId(db, client);
      const result = await attemptSupplierCancellation(db, client, exceptionId, { sId });
      sendJson(response, 200, { result });
    } catch (error) {
      if (error instanceof DomemePrivateApiError) { sendJson(response, 502, { error: error.message, dcode: error.dcode, dmessage: error.dmessage }); return; }
      const statuses = { NOT_FOUND: 404, NOT_OPEN: 409, WRONG_EXCEPTION_TYPE: 409, NO_ORDER_NUMBER: 409 };
      sendJson(response, statuses[error.code] || 500, { error: error.message, code: error.code });
    }
    return;
  }

  // Manual close-out for exceptions this app never automates (반품/교환,
  // CANCEL_ALREADY_SHIPPED) -- the admin handled it outside this app (도매매
  // 사이트, 고객센터 등) and is just marking it done here.
  const exceptionResolveMatch = url.pathname.match(/^\/api\/order-exceptions\/(\d+)\/resolve$/);
  if (exceptionResolveMatch && request.method === 'POST') {
    const exceptionId = Number(exceptionResolveMatch[1]);
    const body = await readJson(request);
    const result = await resolveOrderException(db, exceptionId, { resolutionNote: body.resolutionNote || null });
    if (!result) { sendJson(response, 404, { error: 'Order exception not found' }); return; }
    sendJson(response, 200, { result });
    return;
  }

  if (url.pathname === '/api/auto-batch/queue' && request.method === 'GET') {
    const status = url.searchParams.get('status') || undefined;
    const [queue, activeCount, nextItem] = await Promise.all([
      listQueue(db, { status }), countActiveQueueItems(db), getNextQueueItem(db),
    ]);
    sendJson(response, 200, { queue, queueLength: activeCount, nextItem });
    return;
  }

  // Manual "지금 등록" trigger for a queue item sitting at
  // ready_for_registration -- draft + detail-image slicing already happened
  // (prepareCandidateDraft), this is the one gated step that puts a real
  // (temporary-saved) product on Coupang. Never fired automatically by the
  // daily/discovery batches -- always a human clicking the button.
  const queueRegisterMatch = url.pathname.match(/^\/api\/auto-batch\/queue\/(\d+)\/register$/);
  if (queueRegisterMatch && request.method === 'POST') {
    const queueId = Number(queueRegisterMatch[1]);
    const queue = await listQueue(db);
    const target = queue.find((row) => row.id === queueId);
    if (!target) { sendJson(response, 404, { error: 'Queue item not found', code: 'QUEUE_ITEM_NOT_FOUND' }); return; }
    if (!target.draftId) { sendJson(response, 409, { error: '아직 draft가 준비되지 않은 큐 항목입니다', code: 'DRAFT_NOT_READY' }); return; }
    try {
      const coupangConfig = await loadCoupangConfig(rootDir);
      const client = new CoupangClient(coupangConfig);
      const result = await createDirectRegistration(db, rootDir, target.draftId, { mode: 'raw', confirm: true, coupangConfig, clientImpl: client });
      await updateQueueItemStatus(db, queueId, { status: 'analyzing' });
      sendJson(response, 200, { result });
    } catch (error) {
      sendJson(response, error.code === 'REGISTRATION_NOT_READY' ? 422 : 500, { error: error.message, code: error.code || 'REGISTER_FAILED', readiness: error.readiness });
    }
    return;
  }

  // Naver counterpart of the queue-register endpoint above -- independent
  // action, never gated on the Coupang registration having happened first
  // or vice versa. Does not itself change queue status (only the Coupang
  // registration does, since that's the channel treated as primary/required
  // for the queue item to be considered "registered" -- see
  // auto-discovery-batch.mjs's runDailyProcessingBatch).
  const queueRegisterNaverMatch = url.pathname.match(/^\/api\/auto-batch\/queue\/(\d+)\/register-naver$/);
  if (queueRegisterNaverMatch && request.method === 'POST') {
    const queueId = Number(queueRegisterNaverMatch[1]);
    const queue = await listQueue(db);
    const target = queue.find((row) => row.id === queueId);
    if (!target) { sendJson(response, 404, { error: 'Queue item not found', code: 'QUEUE_ITEM_NOT_FOUND' }); return; }
    if (!target.draftId) { sendJson(response, 409, { error: '아직 draft가 준비되지 않은 큐 항목입니다', code: 'DRAFT_NOT_READY' }); return; }
    try {
      const naverConfig = await loadNaverCommerceConfig(rootDir);
      const client = new NaverCommerceClient(naverConfig);
      const result = await createNaverDirectRegistration(db, rootDir, target.draftId, { confirm: true, naverConfig, clientImpl: client });
      sendJson(response, 200, { result });
    } catch (error) {
      sendJson(response, error.code === 'REGISTRATION_NOT_READY' ? 422 : 500, { error: error.message, code: error.code || 'REGISTER_FAILED', readiness: error.readiness });
    }
    return;
  }

  if (url.pathname === '/api/auto-batch/runs' && request.method === 'GET') {
    const limit = Number(url.searchParams.get('limit') || 20);
    sendJson(response, 200, { runs: await listBatchRuns(db, { limit }) });
    return;
  }

  const autoBatchRunDetailMatch = url.pathname.match(/^\/api\/auto-batch\/runs\/(\d+)$/);
  if (autoBatchRunDetailMatch && request.method === 'GET') {
    const detail = await getBatchRunDetail(db, Number(autoBatchRunDetailMatch[1]));
    if (!detail) { sendJson(response, 404, { error: 'Batch run not found', code: 'BATCH_RUN_NOT_FOUND' }); return; }
    sendJson(response, 200, { run: detail });
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

function sendWorkflowError(response,error){const statuses={DRAFT_NOT_FOUND:404,MAIN_IMAGE_PROMPT_MISSING:409,MAIN_IMAGE_PROMPT_STALE:409,MAIN_IMAGE_PROMPT_INVALID:422,SOURCE_MAIN_IMAGE_MISSING:409,DETAIL_PAGE_PROMPT_MISSING:409,DETAIL_PAGE_PROMPT_STALE:409,DETAIL_PAGE_PROMPT_INVALID:422,DETAIL_PACKAGE_IMAGES_MISSING:409,PROMPT_REQUEST_MISMATCH:409,PROMPT_REVISION_MISMATCH:409,MANUAL_IMAGE_NOT_FOUND:404,MANUAL_DETAIL_SET_NOT_FOUND:404,UPLOAD_TOO_LARGE:413,IMAGE_TOO_LARGE:413,UNSUPPORTED_IMAGE_FORMAT:415,IMAGE_MIME_MISMATCH:415,CORRUPT_IMAGE:422,IMAGE_DIMENSIONS_INVALID:422,IMAGE_PIXELS_INVALID:422,IMAGE_NOT_SQUARE:422,DERIVATIVE_TOO_LARGE:422,DETAIL_IMAGE_COUNT_INVALID:422,DETAIL_IMAGE_OPTIMIZATION_FAILED:422,DETAIL_IMAGE_AGGREGATE_TOO_LARGE:422,DETAIL_IMAGE_AGGREGATE_INVALID:422,CODEX_NOT_AVAILABLE:503,CODEX_LOGIN_REQUIRED:401,IMAGE_GENERATION_UNAVAILABLE:503,CODEX_TIMEOUT:504,CODEX_FAILED:502,NO_GENERATED_FILES:502,MAIN_IMAGE_VALIDATION_FAILED:422,DETAIL_IMAGE_COUNT_INSUFFICIENT:502,DETAIL_IMAGE_VALIDATION_FAILED:422};const payload={error:error.message||String(error),code:error.code||'MANUAL_WORKFLOW_ERROR'};for(const key of ['expectedCount','receivedCount','actualCount','imageIndex','maxFileSize','maxRequestSize','totalFileSize'])if(error[key]!==undefined)payload[key]=error[key];if(error.log)payload.log=String(error.log).slice(-4000);sendJson(response,statuses[error.code]||400,payload);}

async function fetchWorkflowAsset(value,rootDir){if(/^https?:\/\//i.test(value))return fetch(value);const publicRoot=resolve(rootDir,'public'),filePath=resolve(join(publicRoot,String(value).replace(/^\/+/,'')));if(!filePath.startsWith(publicRoot))return{ok:false,status:403};try{const body=await readFile(filePath);return{ok:true,status:200,arrayBuffer:async()=>body,headers:new Headers({'content-type':contentType(filePath)})};}catch{return{ok:false,status:404};}}
async function readWorkflowAsset(value,rootDir){const publicRoot=resolve(rootDir,'public'),filePath=resolve(join(publicRoot,String(value).replace(/^\/+/,'')));if(!filePath.startsWith(publicRoot))throw Object.assign(new Error('Forbidden workflow asset'),{code:'DETAIL_PACKAGE_IMAGES_MISSING'});return readFile(filePath);}
async function removeWorkflowFiles(rootDir,stored){for(const value of [stored.originalStoredUrl,stored.coupangStoredUrl]){const target=resolve(join(rootDir,'public',String(value).replace(/^\/+/,'')));await rm(target,{force:true}).catch(()=>{});}}

// Approved main/detail images are served locally by this admin server
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

export function adminHtml() {
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
    main{display:grid;grid-template-rows:minmax(420px,52vh) 1fr;min-height:calc(100vh - 57px)}main.singleView{grid-template-rows:1fr}
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
    .approvalInbox{padding:16px;max-width:1400px;margin:0 auto}.approvalSummary{display:grid;grid-template-columns:repeat(4,minmax(140px,1fr));gap:10px;margin-bottom:14px}.approvalMetric{background:#fff;border:1px solid #d8dee7;padding:14px;text-align:center}.approvalMetric strong{display:block;font-size:28px;color:#1f6feb}.approvalCard{background:#fff;border:1px solid #d8dee7;border-left:5px solid #1f6feb;padding:16px;margin-bottom:14px}.approvalCard.failed{border-left-color:#cf222e}.approvalCard h2{margin:0 0 8px;font-size:17px}.approvalImages{display:flex;gap:14px;align-items:flex-start;overflow:auto;margin:12px 0}.approvalMainImage img{width:180px;height:180px;max-width:none;max-height:none}.approvalDetailImages{display:flex;flex-wrap:wrap}.approvalDetailImages img{width:82px;height:105px}.approvalActions{display:flex;gap:8px;align-items:center}.approvalActions button{font-weight:700}.approvalError{color:#a8071a;background:#fff1f0;border:1px solid #ffccc7;padding:10px;margin:10px 0}@media(max-width:760px){.approvalSummary{grid-template-columns:repeat(2,1fr)}}
  </style>
</head>
<body>
  <header><h1>Automoney Admin</h1><span class="muted">Product draft review</span><button id="aiSettingsButton" type="button">AI API 설정</button></header>
  <main class="singleView">
    <section class="list">
      <div class="viewNav">
        <button id="viewApprovalInboxButton" class="primary" type="button">승인함</button>
        <button id="viewDashboardButton" type="button">대시보드</button>
        <button id="viewAllButton" type="button">전체</button>
        <button id="viewRecommendButton" type="button">추천</button>
        <button id="viewRegistrationsButton" type="button">등록·재고관리</button>
        <button id="viewAutoBatchButton" type="button">자동배치</button>
        <button id="viewChannelOrdersButton" type="button">주문</button>
        <button id="viewDomemePrecheckButton" type="button">발주(도매매)</button>
        <button id="viewPurchaseOrdersButton" type="button">발주안</button>
        <button id="viewOrderExceptionsButton" type="button">예외 큐</button>
      </div>
      <div class="toolbar" hidden>
        <select id="statusFilter"><option value="">all</option><option value="draft">draft</option><option value="needs_review">needs_review</option><option value="blocked">blocked</option><option value="approved">approved</option></select>
        <select id="naverWinnerFilter"><option value="">naver all</option><option value="candidate">candidate</option><option value="needs_review">needs_review</option><option value="reject">reject</option></select>
        <select id="finalDecisionFilter"><option value="">final all</option><option value="등록후보">등록후보</option><option value="검수필요">검수필요</option><option value="제외">제외</option></select>
        <input id="batchFilter" placeholder="importBatchId">
        <label style="display:flex;align-items:center;gap:4px;margin:0;color:#1f2933;"><input id="collectedOnly" type="checkbox" style="width:auto;"> collected</label>
        <button id="naverCandidateButton">N winner Candidate</button>
        <button id="reloadButton">Reload</button>
      </div>
      <div class="tableWrap" hidden><table id="draftTable"><thead><tr id="draftHeaderRow"></tr></thead><tbody id="draftRows"></tbody></table></div>
      <div id="specialView" class="tableWrap"></div>
    </section>
    <section class="detail" id="detail" hidden>Select a product.</section>
  </main>
  <section id="aiSettings" class="detail" hidden><div class="section"><h2>AI API 설정</h2><p class="muted">현재 이미지 생성은 반수동 외부 AI workflow를 사용합니다. API 설정은 향후 자동 생성 기능을 위한 선택 사항입니다.</p><div id="aiProviderCards" class="grid"></div></div><div class="section"><h2>AI 작업별 모델 설정</h2><div id="aiTaskRouting"></div></div></section>
  <script>
    let selectedId=null;let selectedColIndex=null;let selectedRowIndex=null;const rows=document.getElementById('draftRows');const detail=document.getElementById('detail');
    const statusFilter=document.getElementById('statusFilter');const naverWinnerFilter=document.getElementById('naverWinnerFilter');const finalDecisionFilter=document.getElementById('finalDecisionFilter');const batchFilter=document.getElementById('batchFilter');const collectedOnly=document.getElementById('collectedOnly');
    document.getElementById('reloadButton').addEventListener('click',loadList);document.getElementById('naverCandidateButton').addEventListener('click',()=>{naverWinnerFilter.value='candidate';loadList();});statusFilter.addEventListener('change',loadList);naverWinnerFilter.addEventListener('change',loadList);finalDecisionFilter.addEventListener('change',loadList);batchFilter.addEventListener('change',loadList);collectedOnly.addEventListener('change',loadList);
    let currentView='approvalInbox';
    const viewButtons={approvalInbox:document.getElementById('viewApprovalInboxButton'),dashboard:document.getElementById('viewDashboardButton'),all:document.getElementById('viewAllButton'),recommend:document.getElementById('viewRecommendButton'),registrations:document.getElementById('viewRegistrationsButton'),autoBatch:document.getElementById('viewAutoBatchButton'),channelOrders:document.getElementById('viewChannelOrdersButton'),domemePrecheck:document.getElementById('viewDomemePrecheckButton'),purchaseOrders:document.getElementById('viewPurchaseOrdersButton'),orderExceptions:document.getElementById('viewOrderExceptionsButton')};
    for(const [view,button] of Object.entries(viewButtons))button.addEventListener('click',()=>switchView(view));
    function switchView(view){
      currentView=view;
      for(const [key,button] of Object.entries(viewButtons))button.classList.toggle('primary',key===view);
      document.querySelector('#draftTable').closest('.tableWrap').hidden=view!=='all';
      document.getElementById('specialView').hidden=view==='all';
      document.querySelector('.toolbar').hidden=view!=='all';
      detail.hidden=view!=='all';
      document.querySelector('main').classList.toggle('singleView',view!=='all');
      if(view==='approvalInbox')loadApprovalInbox();
      else if(view==='dashboard')loadDashboardView();
      else if(view==='all')loadList();
      else if(view==='recommend')loadRecommendView();
      else if(view==='registrations')loadRegistrationsView();
      else if(view==='autoBatch')loadAutoBatchView();
      else if(view==='channelOrders')loadChannelOrdersView();
      else if(view==='domemePrecheck')loadDomemePrecheckView();
      else if(view==='purchaseOrders')loadPurchaseOrdersView();
      else if(view==='orderExceptions')loadOrderExceptionsView();
    }
    const APPROVAL_TYPE_LABELS={image:'이미지 승인',sale:'판매 승인',purchase:'발주 승인',failed:'처리 실패'};
    async function loadApprovalInbox(){
      const el=document.getElementById('specialView');
      el.innerHTML='<div class="approvalInbox"><p class="muted">승인할 항목을 불러오는 중...</p></div>';
      try{
        const data=await api('/api/approval-inbox');
        el.innerHTML=approvalInboxHtml(data);
        bindApprovalInboxActions(el);
      }catch(error){
        el.innerHTML='<div class="approvalInbox"><div class="approvalError">승인함을 불러오지 못했습니다: '+escapeHtml(error.message)+'</div><button type="button" data-reload-approval-inbox>다시 불러오기</button></div>';
        el.querySelector('[data-reload-approval-inbox]').onclick=loadApprovalInbox;
      }
    }
    function approvalInboxHtml(data){
      const counts=data.counts||{};
      const metrics=[['이미지 승인',counts.image],['판매 승인',counts.sale],['발주 승인',counts.purchase],['처리 실패',counts.failed]];
      const summary='<div class="approvalSummary">'+metrics.map(([label,count])=>'<div class="approvalMetric"><strong>'+(Number(count)||0)+'</strong>'+label+'</div>').join('')+'</div>';
      const cards=(data.cards||[]).map(approvalCardHtml).join('');
      return '<div class="approvalInbox"><h2>승인함</h2><p class="muted">지금 사람이 결정해야 하는 항목만 모았습니다.</p>'+summary+(cards||'<div class="section"><strong>현재 승인할 항목이 없습니다.</strong></div>')+'</div>';
    }
    function approvalCardHtml(card){
      const p=card.pricing||{};
      const price='<div>원가 '+money(p.unitCostPrice)+'원 · 판매가 '+money(p.salePrice)+'원 · 예상 마진 '+money(p.expectedProfit)+'원</div>';
      const main=card.mainImage?.url?'<div class="approvalMainImage"><div class="muted">대표 이미지</div><a href="'+attr(card.mainImage.url)+'" target="_blank"><img src="'+attr(card.mainImage.url)+'" alt="대표 이미지"></a></div>':'';
      const details=(card.detailImages||[]).length?'<div><div class="muted">상세 이미지 '+card.detailImages.length+'장</div><div class="approvalDetailImages">'+card.detailImages.map((url,index)=>'<a href="'+attr(url)+'" target="_blank"><img src="'+attr(url)+'" alt="상세 이미지 '+(index+1)+'"></a>').join('')+'</div></div>':'';
      const images=main||details?'<div class="approvalImages">'+main+details+'</div>':'';
      const failure=card.error?'<div class="approvalError"><strong>'+escapeHtml(card.error.stage||'처리 실패')+'</strong><br>'+escapeHtml(card.error.message||'오류 내용 없음')+'</div>':'';
      const actions=(card.availableActions||[]).map(action=>approvalActionButtonHtml(action,card)).join('');
      return '<article class="approvalCard '+(card.type==='failed'?'failed':'')+'" data-approval-key="'+attr(card.key)+'"><h2>'+escapeHtml(card.title)+' <small>#'+escapeHtml(card.draftId??'-')+'</small></h2><div><span class="badge status">'+escapeHtml(APPROVAL_TYPE_LABELS[card.type]||card.type)+'</span> '+escapeHtml(card.status||'')+'</div>'+price+images+failure+'<div class="approvalActions">'+(actions||'<span class="muted">자동 재시도할 수 없습니다. 외부 상태 확인이 필요합니다.</span>')+'<span data-action-result class="muted"></span></div></article>';
    }
    function approvalActionButtonHtml(action,card){
      if(action==='approve_images')return '<button class="primary" type="button" data-approve-images-draft-id="'+card.draftId+'">전체 이미지 승인</button>';
      if(action==='request_sale_approval')return '<button class="primary" type="button" data-request-sale-approval-draft-id="'+card.draftId+'">쿠팡 판매 승인</button>';
      if(action==='approve_purchase_order')return '<button class="primary" type="button" data-approve-purchase-order-id="'+card.supplierOrderId+'">실제 발주 승인</button>';
      if(action==='retry')return '<button type="button" data-retry-queue-id="'+card.queueId+'">다시 시도</button>';
      return '';
    }
    function bindApprovalInboxActions(el){
      el.querySelectorAll('.approvalCard button').forEach(button=>button.onclick=async()=>{
        const card=button.closest('.approvalCard'),result=card.querySelector('[data-action-result]');
        let path=null,body='{}';
        if(button.dataset.approveImagesDraftId)path='/api/approval-inbox/drafts/'+button.dataset.approveImagesDraftId+'/approve-images';
        else if(button.dataset.requestSaleApprovalDraftId)path='/api/product-drafts/'+button.dataset.requestSaleApprovalDraftId+'/coupang-registration/request-approval';
        else if(button.dataset.approvePurchaseOrderId){if(!confirm('도매매에 실제 발주합니다. 승인하시겠습니까?'))return;path='/api/purchase-orders/'+button.dataset.approvePurchaseOrderId+'/approve';body=JSON.stringify({confirm:true});}
        else if(button.dataset.retryQueueId)path='/api/approval-inbox/queue/'+button.dataset.retryQueueId+'/retry';
        if(!path)return;
        card.querySelectorAll('button').forEach(item=>item.disabled=true);result.textContent='처리 중...';
        try{await api(path,{method:'POST',body});result.textContent='처리 완료';await loadApprovalInbox();}
        catch(error){result.textContent='오류: '+error.message;card.querySelectorAll('button').forEach(item=>item.disabled=false);}
      });
    }
    const DASHBOARD_METRIC_LABELS={todayRegistrations:'오늘 등록 수',todayImprovements:'오늘 개선 수',newOrders:'신규 주문 수',awaitingApproval:'발주 승인 대기 수',awaitingInvoice:'송장 대기 수',supplierAlerts:'품절/가격변동 수',automationErrors:'자동화 오류 수'};
    const ALERT_CODE_LABELS={SUPPLIER_OUT_OF_STOCK:'공급처 품절',SUPPLIER_BACK_IN_STOCK:'공급처 재입고',SUPPLIER_PRICE_INCREASED:'공급가 상승',SUPPLIER_PRICE_DECREASED:'공급가 하락',SUPPLIER_MOQ_CHANGED:'최소주문수량 변경',SUPPLIER_DATA_ERROR:'공급처 데이터 오류'};
    async function loadDashboardView(){
      const el=document.getElementById('specialView');
      el.innerHTML='<p class="muted" style="padding:12px">불러오는 중...</p>';
      const [dashboardData,alertsData]=await Promise.all([api('/api/dashboard'),api('/api/supplier-alerts?status=open')]);
      const summary=dashboardData.summary||{};
      const alerts=alertsData.alerts||[];
      el.innerHTML='<div style="padding:12px">'
        +'<div class="section"><h3>대시보드 (16.1)</h3>'
        +'<div class="grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;">'
        +Object.entries(DASHBOARD_METRIC_LABELS).map(([key,label])=>'<div class="section" style="text-align:center;padding:16px;"><div style="font-size:28px;font-weight:bold;">'+(summary[key]??'-')+'</div><div class="muted">'+label+'</div></div>').join('')
        +'</div></div>'
        +'<div class="section"><h3>공급처 감시 알림 (16.5, Phase 6)</h3>'
        +'<div id="dashboardAlertsActionResult" class="muted"></div>'
        +'<div id="dashboardAlertsList">'+dashboardSupplierAlertsListHtml(alerts)+'</div>'
        +'</div></div>';
      for(const b of document.querySelectorAll('[data-alert-acknowledge-id]')){
        b.addEventListener('click',async()=>{
          const id=b.dataset.alertAcknowledgeId;
          try{ await api('/api/supplier-alerts/'+id+'/acknowledge',{method:'POST',body:'{}'}); }
          catch(error){document.getElementById('dashboardAlertsActionResult').textContent='오류: '+error.message;}
          await loadDashboardView();
        });
      }
    }
    function dashboardSupplierAlertsListHtml(alerts){
      if(!alerts||!alerts.length)return '<p class="muted">열려 있는 알림이 없습니다.</p>';
      return '<table><thead><tr><th>공급처 상품번호</th><th>유형</th><th>내용</th><th>발생시각</th><th>액션</th></tr></thead><tbody>'
        +alerts.map(a=>'<tr><td>'+escapeHtml(a.supplierProductNo||'-')+'</td>'
          +'<td><span class="badge reasonBlock">'+escapeHtml(ALERT_CODE_LABELS[a.code]||a.code)+'</span></td>'
          +'<td>'+escapeHtml(a.message||'-')+'</td><td>'+escapeHtml(a.createdAt||'-')+'</td>'
          +'<td><button type="button" data-alert-acknowledge-id="'+a.id+'">확인 처리</button></td></tr>').join('')
        +'</tbody></table>';
    }
    const QUEUE_STATUS_LABELS=${JSON.stringify(QUEUE_STATUS_LABELS)};
    async function loadAutoBatchView(){
      const el=document.getElementById('specialView');
      el.innerHTML='<p class="muted" style="padding:12px">불러오는 중...</p>';
      const [scheduleData,runsData,queueData]=await Promise.all([api('/api/auto-batch/schedule'),api('/api/auto-batch/runs?limit=10'),api('/api/auto-batch/queue')]);
      const s=scheduleData.schedule||{};
      const next=queueData.nextItem;
      el.innerHTML='<div style="padding:12px">'
        +'<div class="section"><h3>고정 상품 자동화 일정 (한국 시간)</h3>'
        +'<div>실행 중: '+(s.isRunning?'예':'아니오')+'</div>'
        +'<div>07:00 드래프트: '+escapeHtml(s.draftNextRunAt||'-')+' / 최근 '+escapeHtml(s.draftLastOutcome||'-')+'</div>'
        +'<div>08:00 분석: '+escapeHtml(s.analysisNextRunAt||'-')+' / 최근 '+escapeHtml(s.analysisLastOutcome||'-')+'</div>'
        +'<div>09:00 이미지: '+escapeHtml(s.imagesNextRunAt||'-')+' / 최근 '+escapeHtml(s.imagesLastOutcome||'-')+'</div>'
        +'<div>3일마다 10:00 후보 발굴: '+escapeHtml(s.discoveryNextRunAt||s.nextRunAt||'-')+' / 최근 '+escapeHtml(s.discoveryLastOutcome||'-')+'</div>'
        +'<label>발굴 주기 (일)</label><input id="autoBatchIntervalDays" type="number" min="1" value="'+(s.intervalDays??3)+'">'
        +'<label>최소 통과 점수</label><input id="autoBatchMinScore" type="number" min="0" max="100" value="'+(s.minPassingScore??60)+'">'
        +'<p><button id="autoBatchSaveScheduleButton" type="button">스케줄 저장</button> <button id="autoBatchDiscoveryRunNowButton" type="button">발굴 지금 실행</button></p>'
        +'</div>'
        +'<div class="section"><h3>상품 단계 수동 실행</h3>'
        +'<p><button id="autoBatchProcessingRunNowButton" type="button">처리 지금 실행</button></p>'
        +'<div id="autoBatchActionResult" class="muted"></div>'
        +'</div>'
        +'<div class="section"><h3>큐 상태</h3>'
        +'<div>현재 큐 길이 (미완료): '+queueData.queueLength+'</div>'
        +'<div>오늘/다음 처리 대상: '+(next?escapeHtml(next.name||next.supplierProductNo)+' (점수 '+next.score+', 상태 '+escapeHtml(QUEUE_STATUS_LABELS[next.status]||next.status)+')':'없음')+'</div>'
        +'<div id="autoBatchQueueList">'+autoBatchQueueListHtml(queueData.queue)+'</div>'
        +'</div>'
        +'<div class="section"><h3>발굴 실행 이력</h3><div id="autoBatchRunsList">'+autoBatchRunsListHtml(runsData.runs)+'</div></div>'
        +'<div id="autoBatchRunDetail"></div>'
        +'</div>';
      document.getElementById('autoBatchSaveScheduleButton').onclick=async()=>{
        const resultEl=document.getElementById('autoBatchActionResult');
        resultEl.textContent='저장 중...';
        try{
          await api('/api/auto-batch/schedule',{method:'PATCH',body:JSON.stringify({intervalDays:Number(document.getElementById('autoBatchIntervalDays').value),minPassingScore:Number(document.getElementById('autoBatchMinScore').value)})});
          resultEl.textContent='저장 완료';
          await loadAutoBatchView();
        }catch(error){resultEl.textContent=error.message;}
      };
      document.getElementById('autoBatchDiscoveryRunNowButton').onclick=async()=>{
        const resultEl=document.getElementById('autoBatchActionResult');
        resultEl.textContent='후보 발굴 실행 중...';
        try{
          const result=await api('/api/auto-batch/discovery/run-now',{method:'POST',body:'{}'});
          resultEl.textContent=result.skipped?('건너뜀: '+result.reason):'발굴 완료 (runId='+result.run.id+', 신규 큐 적재 '+result.enqueued.length+'건)';
          await loadAutoBatchView();
        }catch(error){resultEl.textContent=error.message;}
      };
      document.getElementById('autoBatchProcessingRunNowButton').onclick=async()=>{
        const resultEl=document.getElementById('autoBatchActionResult');
        resultEl.textContent='오늘의 상품 처리 중... (분석·이미지 생성에 시간이 걸릴 수 있습니다)';
        try{
          const result=await api('/api/auto-batch/processing/run-now',{method:'POST',body:'{}'});
          resultEl.textContent=result.skipped?('건너뜀: '+result.reason):'처리 완료: '+result.outcome+(result.draftId?(' (draft #'+result.draftId+')'):'');
          await loadAutoBatchView();
        }catch(error){resultEl.textContent=error.message;}
      };
      for(const button of el.querySelectorAll('[data-auto-batch-run-id]')){
        button.onclick=()=>loadAutoBatchRunDetail(Number(button.dataset.autoBatchRunId));
      }
      for(const button of el.querySelectorAll('[data-queue-register-id]')){
        button.onclick=async()=>{
          const queueId=Number(button.dataset.queueRegisterId);
          const resultEl=document.getElementById('autoBatchActionResult');
          button.disabled=true;
          resultEl.textContent='쿠팡에 등록 중... (임시저장 상태로 실제 상품이 생성됩니다)';
          try{
            const data=await api('/api/auto-batch/queue/'+queueId+'/register',{method:'POST',body:'{}'});
            resultEl.textContent='등록 완료: sellerProductId='+data.result.sellerProductId;
            await loadAutoBatchView();
          }catch(error){
            resultEl.textContent='등록 실패: '+error.message+(error.details?.readiness?(' / 미확정: '+JSON.stringify(error.details.readiness.missing)):'');
            button.disabled=false;
          }
        };
      }
      for(const button of el.querySelectorAll('[data-queue-register-naver-id]')){
        button.onclick=async()=>{
          const queueId=Number(button.dataset.queueRegisterNaverId);
          const resultEl=document.getElementById('autoBatchActionResult');
          button.disabled=true;
          resultEl.textContent='네이버에 등록 중...';
          try{
            const data=await api('/api/auto-batch/queue/'+queueId+'/register-naver',{method:'POST',body:'{}'});
            resultEl.textContent='네이버 등록 완료: originProductNo='+data.result.originProductNo;
          }catch(error){
            resultEl.textContent='네이버 등록 실패: '+error.message+(error.details?.readiness?(' / 미확정: '+JSON.stringify(error.details.readiness.missing)):'');
            button.disabled=false;
          }
        };
      }
    }
    function autoBatchQueueListHtml(queue){
      if(!queue||!queue.length)return '<p class="muted">큐가 비어 있습니다.</p>';
      return '<table><thead><tr><th>상품</th><th>점수</th><th>상태</th><th>draft</th><th>실패사유</th><th>액션</th></tr></thead><tbody>'
        +queue.map(q=>'<tr><td>'+escapeHtml(q.name||q.supplierProductNo)+'</td><td>'+(q.score??'-')+'</td><td>'+escapeHtml(QUEUE_STATUS_LABELS[q.status]||q.status)+'</td>'
          +'<td>'+(q.draftId?'<a href="/admin?draftId='+q.draftId+'">#'+q.draftId+'</a>':'-')+'</td>'
          +'<td>'+(q.failureMessage?escapeHtml(q.failureStage||'')+': '+escapeHtml(q.failureMessage):'-')+'</td>'
          +'<td>-</td></tr>').join('')
        +'</tbody></table>';
    }
    function autoBatchRunsListHtml(runs){
      if(!runs||!runs.length)return '<p class="muted">아직 실행 이력이 없습니다.</p>';
      return runs.map(r=>'<div><button type="button" data-auto-batch-run-id="'+r.id+'">#'+r.id+'</button> '
        +escapeHtml(r.status)+' / '+escapeHtml(r.stageReached||'-')+' / '+escapeHtml(r.startedAt||'-')
        +(r.errorMessage?' / <span class="badge reasonBlock">'+escapeHtml(r.errorMessage)+'</span>':'')+'</div>').join('');
    }
    const SUPPLIER_ORDER_STATUS_LABELS={detected:'감지됨',mapping_required:'매핑 필요',validating_supplier:'검증/차단됨',order_draft_ready:'발주안 준비됨',awaiting_purchase_approval:'승인 대기',supplier_ordering:'발주 중',supplier_ordered:'발주 완료',supplier_order_failed:'발주 실패',cancelled:'취소됨'};
    const BLOCK_REASON_LABELS={ORDER_CANCELLED:'채널 주문 취소됨',ADDRESS_INCOMPLETE:'배송지 정보 불완전',OPTION_MISMATCH:'옵션 매칭 실패',DRAFT_NOT_FOUND:'draft를 찾을 수 없음',SUPPLIER_FETCH_FAILED:'공급처 조회 실패',SUPPLIER_SOLD_OUT:'공급처 품절',SUPPLIER_SALE_STOPPED:'공급처 판매중지',MOQ_CHANGED:'최소주문수량 변경됨',LOSS_AT_CURRENT_PRICE:'현재가 기준 손실',MARKET_UNRESOLVED:'도매꾹/도매매 구분 확인 불가'};
    let purchaseOrdersStatusFilter='awaiting_purchase_approval';
    async function loadPurchaseOrdersView(){
      const el=document.getElementById('specialView');
      el.innerHTML='<p class="muted" style="padding:12px">불러오는 중...</p>';
      const query=purchaseOrdersStatusFilter?('?status='+encodeURIComponent(purchaseOrdersStatusFilter)):'';
      const data=await api('/api/purchase-orders'+query);
      const orders=data.orders||[];
      el.innerHTML='<div style="padding:12px">'
        +'<div class="section"><h3>발주안 (Phase 8, 13.4) -- 승인 시 도매매에 실제 발주됩니다 (되돌릴 수 없음)</h3>'
        +'<select id="purchaseOrdersStatusFilter"><option value="">전체</option>'
        +'<option value="awaiting_purchase_approval">승인 대기</option>'
        +'<option value="validating_supplier">검증/차단됨</option>'
        +'<option value="supplier_ordered">발주 완료</option></select>'
        +'<div id="purchaseOrdersActionResult" class="muted"></div>'
        +'<div id="purchaseOrdersList">'+purchaseOrdersListHtml(orders)+'</div>'
        +'</div></div>';
      const filterEl=document.getElementById('purchaseOrdersStatusFilter');
      filterEl.value=purchaseOrdersStatusFilter;
      filterEl.addEventListener('change',()=>{purchaseOrdersStatusFilter=filterEl.value;loadPurchaseOrdersView();});
      for(const b of document.querySelectorAll('[data-purchase-order-approve-id]')){
        b.addEventListener('click',async()=>{
          const id=b.dataset.purchaseOrderApproveId;
          if(!confirm('실제로 도매매에 발주합니다 (공급가 x 발주수량만큼 e-money가 즉시 차감되며 되돌릴 수 없습니다). 계속할까요?'))return;
          const resultEl=document.getElementById('purchaseOrdersActionResult');
          resultEl.textContent='발주 처리 중...';
          try{
            const data=await api('/api/purchase-orders/'+id+'/approve',{method:'POST',body:JSON.stringify({confirm:true})});
            resultEl.textContent=data.order.status==='supplier_ordered'?('발주 완료 (도매매 주문번호 '+data.order.domemeOrderNo+')'):('발주 실패/차단: '+(data.order.failureMessage||JSON.stringify(data.order.blockReasons||[])));
          }catch(error){resultEl.textContent='오류: '+error.message+(error.details&&error.details.dmessage?(' ('+error.details.dmessage+')'):'');}
          await loadPurchaseOrdersView();
        });
      }
    }
    const CHANNEL_SHIP_STATUS_LABELS={not_shipped:'미발송',sent:'발송완료',mapping_failed:'택배사 매핑 실패',failed:'발송 실패',cancelled_skip:'취소로 건너뜀',unsupported_channel:'미지원 채널'};
    function purchaseOrdersListHtml(orders){
      if(!orders||!orders.length)return '<p class="muted">발주안이 없습니다.</p>';
      return '<table><thead><tr><th>채널</th><th>공급처 상품번호</th><th>시장</th><th>옵션코드</th><th>판매수량</th><th>발주수량</th><th>판매금액</th><th>공급가</th><th>예상순이익</th><th>상태</th><th>차단사유</th><th>택배사</th><th>송장번호</th><th>채널발송</th><th>액션</th></tr></thead><tbody>'
        +orders.map(o=>'<tr><td>'+escapeHtml(o.channel||'-')+'</td><td>'+escapeHtml(o.supplierProductNo||'-')+'</td><td>'+escapeHtml(o.supplierMarket||'-')+'</td><td>'+escapeHtml(o.supplierOptionCode||'-')+'</td>'
          +'<td>'+(o.saleQty??'-')+'</td><td>'+(o.supplierOrderQty??'-')+'</td><td>'+money(o.salePrice)+'</td><td>'+money(o.supplierUnitPrice)+'</td><td>'+money(o.estimatedProfit)+'</td>'
          +'<td>'+(o.status==='awaiting_purchase_approval'?'<span class="badge">':'<span class="badge reasonBlock">')+escapeHtml(SUPPLIER_ORDER_STATUS_LABELS[o.status]||o.status)+'</span></td>'
          +'<td>'+(o.blockReasons&&o.blockReasons.length?o.blockReasons.map(r=>escapeHtml(BLOCK_REASON_LABELS[r]||r)).join(', '):'-')+'</td>'
          +'<td>'+escapeHtml(o.carrierName||'-')+'</td><td>'+escapeHtml(o.trackingNumber||'-')+'</td>'
          +'<td>'+(o.channelShipStatus==='sent'?'<span class="badge">':(o.channelShipStatus&&o.channelShipStatus!=='not_shipped'?'<span class="badge reasonBlock">':'<span class="badge">'))+escapeHtml(CHANNEL_SHIP_STATUS_LABELS[o.channelShipStatus]||o.channelShipStatus||'-')+'</span>'+(o.channelShipError?'<br><span class="muted">'+escapeHtml(o.channelShipError)+'</span>':'')+'</td>'
          +'<td>'+(o.status==='awaiting_purchase_approval'?'<button type="button" data-purchase-order-approve-id="'+o.id+'">발주 승인</button>':'-')+'</td></tr>').join('')
        +'</tbody></table>';
    }
    const EXCEPTION_TYPE_LABELS={CANCEL_NOT_SHIPPED:'취소 - 미출고 (공급처 취소 시도 가능)',CANCEL_ALREADY_SHIPPED:'취소 - 이미 출고 (수동 처리 필요)',RETURN_REQUESTED:'반품 요청',EXCHANGE_REQUESTED:'교환 요청'};
    let orderExceptionsTypeFilter='';
    async function loadOrderExceptionsView(){
      const el=document.getElementById('specialView');
      el.innerHTML='<p class="muted" style="padding:12px">불러오는 중...</p>';
      const query=orderExceptionsTypeFilter?('?status=open&exceptionType='+encodeURIComponent(orderExceptionsTypeFilter)):'?status=open';
      const data=await api('/api/order-exceptions'+query);
      const exceptions=data.exceptions||[];
      el.innerHTML='<div style="padding:12px">'
        +'<div class="section"><h3>관리자 예외 큐 (Phase 10, 15.1/15.3) -- 자동 처리되지 않는 취소/반품/교환</h3>'
        +'<select id="orderExceptionsTypeFilter"><option value="">전체</option>'
        +'<option value="CANCEL_NOT_SHIPPED">취소 - 미출고</option>'
        +'<option value="CANCEL_ALREADY_SHIPPED">취소 - 이미 출고</option>'
        +'<option value="RETURN_REQUESTED">반품 요청</option>'
        +'<option value="EXCHANGE_REQUESTED">교환 요청</option></select>'
        +'<div id="orderExceptionsActionResult" class="muted"></div>'
        +'<div id="orderExceptionsList">'+orderExceptionsListHtml(exceptions)+'</div>'
        +'</div></div>';
      const filterEl=document.getElementById('orderExceptionsTypeFilter');
      filterEl.value=orderExceptionsTypeFilter;
      filterEl.addEventListener('change',()=>{orderExceptionsTypeFilter=filterEl.value;loadOrderExceptionsView();});
      for(const b of document.querySelectorAll('[data-exception-cancel-id]')){
        b.addEventListener('click',async()=>{
          const id=b.dataset.exceptionCancelId;
          if(!confirm('도매매에 실제로 발주 취소를 요청합니다. 계속할까요?'))return;
          const resultEl=document.getElementById('orderExceptionsActionResult');
          resultEl.textContent='공급처 취소 요청 중...';
          try{
            const data=await api('/api/order-exceptions/'+id+'/attempt-supplier-cancel',{method:'POST',body:'{}'});
            resultEl.textContent=data.result.status==='resolved'?'공급처 취소 완료':('공급처 취소 미확정: '+JSON.stringify(data.result.domemeResult||data.result));
          }catch(error){resultEl.textContent='오류: '+error.message+(error.details&&error.details.dmessage?(' ('+error.details.dmessage+')'):'');}
          await loadOrderExceptionsView();
        });
      }
      for(const b of document.querySelectorAll('[data-exception-resolve-id]')){
        b.addEventListener('click',async()=>{
          const id=b.dataset.exceptionResolveId;
          const note=prompt('처리 메모 (선택)')||'';
          try{ await api('/api/order-exceptions/'+id+'/resolve',{method:'POST',body:JSON.stringify({resolutionNote:note})}); }
          catch(error){document.getElementById('orderExceptionsActionResult').textContent='오류: '+error.message;}
          await loadOrderExceptionsView();
        });
      }
    }
    function orderExceptionsListHtml(exceptions){
      if(!exceptions||!exceptions.length)return '<p class="muted">열려 있는 예외가 없습니다.</p>';
      return '<table><thead><tr><th>채널</th><th>채널 주문번호</th><th>유형</th><th>수령인</th><th>도매매 주문번호</th><th>송장번호</th><th>주문상태</th><th>액션</th></tr></thead><tbody>'
        +exceptions.map(e=>'<tr><td>'+escapeHtml(e.channel||'-')+'</td><td>'+escapeHtml(e.channelOrderId||'-')+'</td>'
          +'<td><span class="badge reasonBlock">'+escapeHtml(EXCEPTION_TYPE_LABELS[e.exceptionType]||e.exceptionType)+'</span></td>'
          +'<td>'+escapeHtml(e.recipientName||'-')+'</td><td>'+escapeHtml(e.domemeOrderNo||'-')+'</td><td>'+escapeHtml(e.trackingNumber||'-')+'</td><td>'+escapeHtml(e.orderStatus||'-')+'</td>'
          +'<td>'+(e.exceptionType==='CANCEL_NOT_SHIPPED'?'<button type="button" data-exception-cancel-id="'+e.id+'">공급처 취소 시도</button> ':'')
          +'<button type="button" data-exception-resolve-id="'+e.id+'">수동 처리 완료</button></td></tr>').join('')
        +'</tbody></table>';
    }
    const ORDER_MAPPING_STATUS_LABELS={mapping_required:'매핑 필요',mapped:'매핑 완료'};
    const ORDER_CHANNEL_LABELS={coupang:'쿠팡',naver:'네이버'};
    let channelOrdersMappingFilter='';
    async function loadChannelOrdersView(){
      const el=document.getElementById('specialView');
      el.innerHTML='<p class="muted" style="padding:12px">불러오는 중...</p>';
      const query=channelOrdersMappingFilter?('?mappingStatus='+encodeURIComponent(channelOrdersMappingFilter)):'';
      const data=await api('/api/channel-orders'+query);
      const orders=data.orders||[];
      const needsMapping=orders.filter(o=>o.supplierMappingStatus==='mapping_required').length;
      el.innerHTML='<div style="padding:12px">'
        +'<div class="section"><h3>쿠팡·네이버 주문 수집 (Phase 7)</h3>'
        +'<div>표시된 '+orders.length+'건 중 매핑 필요: '+needsMapping+'건</div>'
        +'<select id="channelOrdersMappingFilter"><option value="">전체</option><option value="mapping_required">매핑 필요</option><option value="mapped">매핑 완료</option></select>'
        +'<div id="channelOrdersList">'+channelOrdersListHtml(orders)+'</div>'
        +'</div></div>';
      const filterEl=document.getElementById('channelOrdersMappingFilter');
      filterEl.value=channelOrdersMappingFilter;
      filterEl.addEventListener('change',()=>{channelOrdersMappingFilter=filterEl.value;loadChannelOrdersView();});
    }
    function channelOrdersListHtml(orders){
      if(!orders||!orders.length)return '<p class="muted">수집된 주문이 없습니다.</p>';
      return '<table><thead><tr><th>채널</th><th>주문번호</th><th>옵션</th><th>수량</th><th>금액</th><th>주문상태</th><th>수령인</th><th>주문시각</th><th>매핑상태</th><th>draft</th></tr></thead><tbody>'
        +orders.map(o=>'<tr><td>'+escapeHtml(ORDER_CHANNEL_LABELS[o.channel]||o.channel)+'</td><td>'+escapeHtml(o.channelOrderId||'-')+'</td>'
          +'<td>'+escapeHtml(o.optionInfo||'-')+'</td><td>'+(o.quantity??'-')+'</td><td>'+money(o.salePrice)+'</td>'
          +'<td>'+escapeHtml(o.orderStatus||'-')+'</td><td>'+escapeHtml(o.recipientName||'-')+'</td><td>'+escapeHtml(o.orderedAt||'-')+'</td>'
          +'<td>'+(o.supplierMappingStatus==='mapping_required'?'<span class="badge reasonBlock">':'<span class="badge">')+escapeHtml(ORDER_MAPPING_STATUS_LABELS[o.supplierMappingStatus]||o.supplierMappingStatus)+'</span></td>'
          +'<td>'+(o.productDraftId?'<a href="/admin?draftId='+o.productDraftId+'">#'+o.productDraftId+'</a>':'-')+'</td></tr>').join('')
        +'</tbody></table>';
    }
    async function loadDomemePrecheckView(){
      const el=document.getElementById('specialView');
      el.innerHTML='<p class="muted" style="padding:12px">확인 중...</p>';
      let data;
      try{ data=await api('/api/domeme/precheck'); }
      catch(error){ data={ok:false,error:error.message,dcode:error.details&&error.details.dcode,dmessage:error.details&&error.details.dmessage}; }
      el.innerHTML='<div style="padding:12px">'
        +'<div class="section"><h3>도매매 발주 사전 확인 (Phase 8, 13.1)</h3>'
        +(data.ok
          ?('<div>로그인/세션: <span class="badge">정상</span> (id: '+escapeHtml(data.loginId)+')</div>'
            +'<div>e-money 잔액 조회: <span class="badge">정상</span></div>'
            +'<div>현금성 이머니 잔액: '+money(data.emoneyCash)+'</div>'
            +'<div>총 이머니 잔액: '+money(data.emoneyTotal)+'</div>'
            +'<div class="muted">마지막 확인: '+escapeHtml(data.checkedAt)+'</div>')
          :('<div>로그인/세션: <span class="badge reasonBlock">실패</span></div>'
            +'<div class="muted">'+escapeHtml(data.dmessage||data.error||'알 수 없는 오류')+(data.dcode?(' ('+escapeHtml(data.dcode)+')'):'')+'</div>'))
        +'<p><button id="domemePrecheckRefreshButton" type="button">다시 확인</button></p>'
        +'<h4>수동 확인 필요 항목 (API로 검증 불가)</h4>'
        +'<ul>'
        +'<li>주문 생성 API 사용 가능 여부 -- 실제 발주 전에는 확인할 방법이 없음 (테스트 발주 자체가 실제 주문/실제 결제)</li>'
        +'<li>배송대행 주문 지원 여부 -- 도매매 관리자센터에서 직접 확인 필요</li>'
        +'<li>테스트 주문 취소 가능 여부 -- 실제 주문 발생 후에만 setOrdDeny로 확인 가능</li>'
        +'</ul>'
        +'</div></div>';
      const refreshButton=document.getElementById('domemePrecheckRefreshButton');
      if(refreshButton)refreshButton.addEventListener('click',loadDomemePrecheckView);
    }
    const AUTO_BATCH_STATUS_LABELS={selected:'선정됨',draft_created:'draft 생성됨',analysis_running:'분석 중',analysis_completed:'분석 완료',image_generation_running:'이미지 생성 중',awaiting_image_approval:'이미지 승인 대기',failed:'실패'};
    async function loadAutoBatchRunDetail(runId){
      const el=document.getElementById('autoBatchRunDetail');
      el.innerHTML='<p class="muted">불러오는 중...</p>';
      const data=await api('/api/auto-batch/runs/'+runId);
      const run=data.run;
      const byCategory={};
      for(const c of run.candidates||[]){(byCategory[c.categoryPolicyId]=byCategory[c.categoryPolicyId]||{categoryName:c.categoryName,segmentName:c.segmentName,items:[]}).items.push(c);}
      const groups=await Promise.all(Object.values(byCategory).map(async(group)=>{
        const winner=group.items.find(i=>i.isWinner);
        let stage2Html='';
        if(winner&&winner.processingStatus){
          let thumbHtml='';
          if(winner.draftId){
            try{
              const mainImages=await api('/api/product-drafts/'+winner.draftId+'/ai-workflows/main-image/results');
              const latest=(mainImages.results||[])[0];
              if(latest)thumbHtml='<img src="'+attr(latest.coupangStoredUrl)+'" alt="대표이미지"> <span class="badge">'+escapeHtml(latest.status)+'</span>';
            }catch(e){}
          }
          stage2Html='<div class="section" style="background:#f8fafc"><h5>배치 처리 상태: '+escapeHtml(AUTO_BATCH_STATUS_LABELS[winner.processingStatus]||winner.processingStatus)+'</h5>'
            +(winner.draftId?'<p><a href="/admin?draftId='+winner.draftId+'">draft #'+winner.draftId+' 이동 →</a> (이미지 프롬프트 탭에서 승인)</p>':'')
            +thumbHtml
            +'<div>Python 실행: '+(winner.pythonRan==null?'-':winner.pythonRan?'성공':'실패/미실행')+' / Codex 실행: '+(winner.codexRan==null?'-':winner.codexRan?'성공':'실패')+'</div>'
            +'<div>미확정 필드 수: '+(winner.unresolvedFieldsCount??'-')+'</div>'
            +'<div>대표이미지 생성: '+(winner.mainImageGenerated==null?'-':winner.mainImageGenerated?'완료':'미완료')+' / 상세이미지 생성: '+(winner.detailImagesGeneratedCount??0)+'/10</div>'
            +(winner.processingStatus==='awaiting_image_approval'?'<div class="badge">승인 대기 중 -- 실제 등록/승인 없음</div>':'')
            +(winner.failureStage?'<div class="badge reasonBlock">실패 단계: '+escapeHtml(winner.failureStage)+' -- '+escapeHtml(winner.failureMessage||'')+'</div>':'')
            +'</div>';
        }
        return '<div class="section"><h4>'+escapeHtml(group.segmentName)+' / '+escapeHtml(group.categoryName)+'</h4>'
          +(winner
            ?'<div><strong>선정: '+escapeHtml(winner.name||winner.supplierProductNo)+'</strong> (점수 '+winner.score+')</div><ul>'+Object.entries(winner.scoreBreakdown||{}).map(([k,v])=>'<li>'+escapeHtml(k)+': '+v.points+'/'+v.max+' -- '+escapeHtml(v.reason)+'</li>').join('')+'</ul>'+stage2Html
            :'<div class="muted">기준 미달로 선정된 상품 없음</div>')
          +'<div class="muted">평가 후보 상위 '+group.items.length+'개 중 표시</div>'
          +'</div>';
      }));
      el.innerHTML='<h3>실행 #'+run.id+' 상세</h3><div>상태: '+escapeHtml(run.status)+' / stage='+escapeHtml(run.stageReached||'-')+'</div>'+groups.join('');
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
      const [data,targetData,settingsData]=await Promise.all([api('/api/coupang-registrations'),api('/api/coupang-registration-flow/target'),api('/api/coupang-seller-settings')]);
      const el=document.getElementById('specialView');
      const settingsPanel=shippingSettingsHtml(settingsData);
      const banner=targetBannerHtml(targetData.target);
      const rows=data.registrations.length?data.registrations.map(registrationRowHtml).join(''):'<p class="muted">표시할 항목이 없습니다.</p>';
      el.innerHTML='<div style="padding:12px">'+settingsPanel+banner+rows+'</div>';
      wireShippingSettingsSection(el);
    }
    function shippingCandidateRadioHtml(name,candidates,codeField,currentCode){
      if(!candidates.length)return '<p class="muted">API에서 조회된 후보가 없습니다.</p>';
      return candidates.map(c=>{
        const code=String(c[codeField]);
        const address=(c.placeAddresses||[]).map(a=>a.returnAddress).filter(Boolean).join(', ')||'(주소 없음)';
        const checked=currentCode&&String(currentCode)===code?'checked':'';
        return '<label style="display:block;padding:4px 0"><input type="radio" name="'+name+'" value="'+attr(code)+'" data-name="'+attr(c.shippingPlaceName||'')+'" '+checked+' style="width:auto"> '
          +escapeHtml(c.shippingPlaceName||'(이름 없음)')+' / code='+escapeHtml(code)+' / '+escapeHtml(address)+' / usable='+(c.usable!==false)+'</label>';
      }).join('');
    }
    function shippingSettingsHtml(data){
      const v=data.validation;
      const statusBadge=!v.configured?'<span class="badge reasonBlock">미확정</span>':(v.blocked?'<span class="badge reasonBlock">확인 필요</span>':'<span class="badge status">정상</span>');
      const reasons=(v.reasons||[]).map(r=>'<div class="muted">'+escapeHtml(r)+'</div>').join('');
      const current=data.settings.outboundShippingPlaceCode
        ?('<div>현재 저장된 출고지: code='+escapeHtml(data.settings.outboundShippingPlaceCode)+' ('+escapeHtml(data.settings.outboundShippingPlaceName||'')+') / 반품지: code='+escapeHtml(data.settings.returnCenterCode)+' ('+escapeHtml(data.settings.returnCenterName||'')+')</div>')
        :'<div class="muted">아직 저장된 코드가 없습니다.</div>';
      return '<div class="section" data-shipping-settings><h3>공통 판매자 설정 -- 출고지/반품지 (표시 이름이 아니라 코드로 저장, 등록 시 API에서 코드 존재+usable 재확인)</h3>'
        +statusBadge+current+reasons
        +'<details><summary>출고지/반품지 확인 및 변경</summary>'
        +'<h4>출고지 후보</h4>'+shippingCandidateRadioHtml('shipOutbound',data.outboundCandidates,'outboundShippingPlaceCode',data.settings.outboundShippingPlaceCode)
        +'<h4>반품지 후보</h4>'+shippingCandidateRadioHtml('shipReturn',data.returnCandidates,'returnCenterCode',data.settings.returnCenterCode)
        +'<p><button id="saveShippingSettingsButton" type="button">선택한 코드로 저장</button></p><div id="shippingSettingsSaveResult" class="muted"></div>'
        +'</details></div>';
    }
    function wireShippingSettingsSection(el){
      const button=el.querySelector('#saveShippingSettingsButton');
      if(!button)return;
      button.onclick=async()=>{
        const outbound=el.querySelector('input[name="shipOutbound"]:checked');
        const ret=el.querySelector('input[name="shipReturn"]:checked');
        const resultEl=el.querySelector('#shippingSettingsSaveResult');
        if(!outbound||!ret){resultEl.textContent='출고지와 반품지를 모두 선택하세요.';return;}
        await api('/api/coupang-seller-settings',{method:'POST',body:JSON.stringify({
          outboundShippingPlaceCode:outbound.value,outboundShippingPlaceName:outbound.dataset.name,
          returnCenterCode:ret.value,returnCenterName:ret.dataset.name,
        })});
        await loadRegistrationsView();
      };
    }
    function targetBannerHtml(t){
      if(!t)return'';
      const preferred=t.preferredDisqualifiedReason
        ?'<div>추천 대상 #'+t.preferredDraftId+': <span class="badge reasonBlock">제외됨</span> '+escapeHtml(t.preferredDisqualifiedReason)+'</div>'
        :'<div>추천 대상 #'+t.preferredDraftId+': <span class="badge status">적합</span></div>';
      const selected=t.noEligibleCandidate
        ?'<div class="badge reasonBlock">현재 등록 가능한 조건(승인 이미지 보유 + 등록 이력 없음 + draft 64 제외)을 만족하는 상품이 없습니다.</div>'
        :'<div>선택된 등록 대상: <a class="productLink" href="/admin?draftId='+t.selectedDraftId+'">#'+t.selectedDraftId+' →</a></div>';
      return '<div class="section"><h3>신규 등록 대상 추천</h3>'+preferred+selected+'</div>';
    }
    function registrationRowHtml(r){
      const linked=r.sellerProductId;
      return '<div class="section"><h3>#'+r.productDraftId+' '+escapeHtml(r.optimizedCoupangTitle||r.sellingTitle||'')+'</h3>'
        +(linked
          ?'<div>sellerProductId '+escapeHtml(r.sellerProductId)+' / 상태 '+escapeHtml(r.liveStatusName||r.status||'-')+' / 재고 '+money(r.liveTotalStockQuantity)+' / 가격 '+money(r.liveSalePrice)+'</div><div class="muted">마지막 확인: '+escapeHtml(r.lastSyncedAt||'-')+'</div>'
          :'<div class="muted">아직 쿠팡 상품과 연결되지 않았습니다.</div>')
        +'<p><a class="productLink" href="/admin?draftId='+r.productDraftId+'">상세보기(연결/이미지반영/새로고침) →</a></p></div>';
    }
    window.__adminUiDiagnostics=window.__adminUiDiagnostics||{};window.__adminUiDiagnostics.scriptLoaded=true;const initialId=new URL(location.href).searchParams.get('draftId');window.__adminUiDiagnostics.initialId=Number(initialId)||null;window.__adminUiDiagnostics.initialLoadDetailCallAttempted=Boolean(initialId);if(initialId)switchView('all');else loadApprovalInbox();window.__initialLoadPromise=initialId?Promise.resolve(loadDetail(initialId,false)):Promise.resolve();

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
    async function loadDetail(id,push=true){selectedId=id;if(push)history.replaceState(null,'','/admin?draftId='+encodeURIComponent(id));const data=await api('/api/product-drafts/'+id);const d=data.draft;detail.innerHTML=detailHtml(d);enhanceDetailImageSections(d);bindTabs();document.getElementById('saveButton').addEventListener('click',()=>saveDraft(id));for(const b of detail.querySelectorAll('[data-status-action]'))b.addEventListener('click',()=>setStatus(id,b.dataset.statusAction));const forceApprove=document.getElementById('forceApproveButton');if(forceApprove)forceApprove.addEventListener('click',()=>forceApproveDraft(id));document.getElementById('exportCoupangButton').addEventListener('click',()=>loadExport(id,'coupang'));document.getElementById('exportNaverButton').addEventListener('click',()=>loadExport(id,'naver'));document.getElementById('copyJsonButton').addEventListener('click',copyExportJson);document.getElementById('refreshNaverButton').addEventListener('click',()=>refreshNaver(id));document.getElementById('runSeoAnalysisButton').addEventListener('click',()=>runSeoAnalysis(id));const regenerateTitleButton=document.getElementById('regenerateTitleButton');if(regenerateTitleButton)regenerateTitleButton.addEventListener('click',()=>regenerateOptimizedTitles(id));const saveTitlesButton=document.getElementById('saveTitlesButton');if(saveTitlesButton)saveTitlesButton.addEventListener('click',()=>saveOptimizedTitles(id));const copyCoupangTitleButton=document.getElementById('copyCoupangTitleButton');if(copyCoupangTitleButton)copyCoupangTitleButton.addEventListener('click',()=>copyTitle('optimizedCoupangTitle'));const copyNaverTitleButton=document.getElementById('copyNaverTitleButton');if(copyNaverTitleButton)copyNaverTitleButton.addEventListener('click',()=>copyTitle('optimizedNaverTitle'));const regenerateDetailButton=document.getElementById('regenerateDetailButton');if(regenerateDetailButton)regenerateDetailButton.addEventListener('click',()=>regenerateGeneratedDetail(id));const toggleOriginalButton=document.getElementById('toggleOriginalDetailButton');if(toggleOriginalButton)toggleOriginalButton.addEventListener('click',toggleOriginalDetailImages);const refreshPreviewButton=document.getElementById('refreshPreviewButton');if(refreshPreviewButton)refreshPreviewButton.addEventListener('click',refreshDetailPreview);document.getElementById('saveChecklistButton').addEventListener('click',()=>saveChecklist(id));document.getElementById('preview').srcdoc=d.generatedDetailHtml||'';const naver=await api('/api/product-drafts/'+id+'/market-research/naver');fillNaverResearch(naver.research);const opt=await api('/api/product-drafts/'+id+'/registration-optimization');renderOptimization(opt.optimization);const checklist=await api('/api/product-drafts/'+id+'/registration-checklist');fillChecklist(checklist.checklist);loadCoupangLiveSection(id,d);loadNaverLiveSection(id,d);loadAnalysisSection(id,d);loadList();}
    function detailHtml(d){const hasBlockReasons=(d.blockReasons||[]).length>0;const approvalButton=hasBlockReasons?'<button id="forceApproveButton">Force approve</button><span class="badge reasonBlock">overrideReason required</span>':'<button data-status-action="approved">Approved</button>';const warnings=(d.warnings||[]).map(x=>'<span class="badge reasonBlock">'+escapeHtml(x)+'</span>').join('');return '<div class="tabs"><button class="active" data-tab="source">원본/공급처</button><button data-tab="naver">네이버 경쟁분석</button><button data-tab="seo">SEO 키워드</button><button data-tab="title">상품명</button><button data-tab="detail">상세페이지</button><button data-tab="image">이미지 프롬프트</button><button data-tab="analysis">상품정보 분석</button><button data-tab="category">카테고리</button><button data-tab="notice">고시정보</button><button data-tab="shipping">배송정책</button><button data-tab="approval">승인조건</button><button data-tab="coupangLive">쿠팡 라이브 관리</button><button data-tab="naverLive">네이버 라이브 관리</button><button data-tab="export">Export JSON</button></div><div class="tabPanel active" data-panel="source"><div class="section"><h2>#'+d.id+' '+escapeHtml(d.supplierProductNo)+'</h2><div class="grid"><div><div class="muted">Original name</div><strong>'+escapeHtml(d.originalProductName||'')+'</strong></div><div><div class="muted">Status</div>'+escapeHtml(labelStatus(d.status))+' / '+escapeHtml(labelStatus(d.filterStatus))+' '+warnings+'</div><div>Final: <span class="badge status">'+escapeHtml(d.finalDecision||'-')+'</span></div><div>Raw price: '+escapeHtml(d.rawPriceFieldName||'-')+' = '+escapeHtml(d.rawPriceValue||'-')+'</div><div>Shipping: '+escapeHtml(d.shippingRawFieldName||'-')+' = '+escapeHtml(d.shippingRawValue||'-')+'</div><div>Coupang: '+money(d.coupangSalePrice)+' / profit '+money(d.coupangExpectedProfit)+'</div><div>Naver: '+money(d.naverSalePrice)+' / profit '+money(d.naverExpectedProfit)+'</div></div></div>'+sourceInfoHtml(d)+'<div class="section"><h2>Reasons</h2>'+reasonBadges(d.blockReasons).join('')+reasonBadges(d.reviewReasons).join('')+'</div><div class="section"><h2>Images</h2>'+imageGalleryHtml(d)+'</div><div class="section"><h2>Options</h2><table><tbody>'+d.options.map(o=>'<tr><td>'+o.index+'</td><td>'+escapeHtml(o.name||'')+'</td><td>'+escapeHtml(o.value||'')+'</td><td>'+money(o.additionalPrice)+'</td></tr>').join('')+'</tbody></table></div></div><div class="tabPanel" data-panel="naver">'+naverResearchHtml()+'</div><div class="tabPanel" data-panel="seo">'+optimizationHtml()+'</div><div class="tabPanel" data-panel="title"><div class="section"><h2>상품명</h2><div id="optimizedTitleResult" class="muted"></div></div></div><div class="tabPanel" data-panel="detail"><div class="section"><h2>수정</h2><label>sellingTitle</label><input id="sellingTitle" value="'+attr(d.sellingTitle||'')+'"><div class="grid"><div><label>coupangSalePrice</label><input id="coupangSalePrice" type="number" value="'+attr(d.coupangSalePrice??'')+'"></div><div><label>naverSalePrice</label><input id="naverSalePrice" type="number" value="'+attr(d.naverSalePrice??'')+'"></div></div><label>status</label><select id="status"><option>draft</option><option>needs_review</option><option>blocked</option><option>approved</option></select><label>상세페이지 HTML 수정</label><textarea id="generatedDetailHtml">'+escapeHtml(d.generatedDetailHtml||'')+'</textarea><label>reviewMemo</label><textarea id="reviewMemo">'+escapeHtml(d.reviewMemo||'')+'</textarea><p><button class="primary" id="saveButton">Save</button> <button data-status-action="draft">Draft</button> <button data-status-action="needs_review">Needs review</button> <button data-status-action="blocked">Blocked</button> '+approvalButton+' <button id="exportCoupangButton">쿠팡 JSON 보기</button> <button id="exportNaverButton">네이버 JSON 보기</button> <button id="copyJsonButton">JSON 복사</button></p></div><div class="section"><h2>상세페이지 미리보기</h2><iframe id="preview"></iframe></div></div><div class="tabPanel" data-panel="image"><div class="section"><h2>이미지 프롬프트</h2><pre id="imagePromptResult"></pre></div></div><div class="tabPanel" data-panel="analysis"><div class="section"><h2>상품정보 분석 (Python OCR + Codex)</h2><div id="analysisContent" class="muted">불러오는 중...</div></div></div><div class="tabPanel" data-panel="category"><div class="section"><h2>카테고리</h2><div id="categoryResult" class="muted"></div></div></div><div class="tabPanel" data-panel="notice"><div class="section"><h2>고시정보</h2><div id="noticeResult" class="muted"></div></div></div><div class="tabPanel" data-panel="shipping"><div class="section"><h2>배송정책</h2><div id="shippingResult" class="muted"></div></div></div><div class="tabPanel" data-panel="approval">'+approvalChecklistHtml()+'</div><div class="tabPanel" data-panel="coupangLive"><div class="section"><h2>쿠팡 라이브 관리</h2><div id="coupangLiveContent" class="muted">불러오는 중...</div></div></div><div class="tabPanel" data-panel="naverLive"><div class="section"><h2>네이버 라이브 관리</h2><div id="naverLiveContent" class="muted">불러오는 중...</div></div></div><div class="tabPanel" data-panel="export"><div class="section"><h2>Export JSON preview</h2><pre id="exportPreview"></pre></div></div><script>document.getElementById("status").value='+JSON.stringify(d.status)+';<\\/script>';}
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
      const priceSection='<div class="section"><h3>가격 조정</h3>'
        +(linked
          ?'<p><button id="coupangPriceLoadButton" type="button">현재 옵션별 가격 불러오기</button></p><div id="coupangPriceResult"></div>'
          :'<div class="muted">먼저 쿠팡 상품과 연결해야 합니다.</div>')
        +'</div>';
      const directRegisterSection=linked?'':directRegisterHtml(imagesReady);
      return '<div class="section">'+linkSection+'</div>'+directRegisterSection+swapSection+snapshotSection+priceSection;
    }
    function directRegisterHtml(imagesReady){
      if(!imagesReady)return '<div class="section"><h3>신규 등록 (관리자 화면에서 직접 등록)</h3><div class="muted">승인된 대표이미지/상세이미지 세트가 있어야 진행할 수 있습니다.</div></div>';
      return '<div class="section" data-direct-register><h3>신규 등록 (관리자 화면에서 직접 등록, requested=false)</h3>'
        +'<p class="muted">1) 상품정보 분석 탭에서 분석·적용을 먼저 완료하세요. 2) 아래에서 카테고리를 조회하고 3) 미확정 항목을 입력한 뒤 4) 미리보기를 만들고 5) 최종 확인 후 임시등록합니다. 승인 요청은 하지 않습니다.</p>'
        +'<p><button id="categoryPreviewButton" type="button">1. 쿠팡 카테고리 예측 조회</button></p>'
        +'<div id="categoryPreviewResult"></div>'
        +'<div id="registrationOverridesForm"></div>'
        +'<p><button id="registrationPreviewButton" type="button">2. 등록 미리보기 생성 (R2 업로드 + payload 조립)</button></p>'
        +'<div id="registrationPreviewResult"></div>'
        +'<div id="registrationResult" class="muted"></div>'
        +'</div>';
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
      const priceLoadButton=container.querySelector('#coupangPriceLoadButton');
      if(priceLoadButton)priceLoadButton.onclick=async()=>{
        const resultEl=container.querySelector('#coupangPriceResult');
        resultEl.innerHTML='<p class="muted">불러오는 중...</p>';
        try{
          const data=await api('/api/product-drafts/'+id+'/coupang-registration/update-price',{method:'POST',body:JSON.stringify({})});
          if(!data.items.length){resultEl.innerHTML='<p class="muted">옵션이 없습니다.</p>';return;}
          resultEl.innerHTML='<table><tr><th>옵션</th><th>현재가</th><th>새 가격</th></tr>'
            +data.items.map(it=>'<tr><td>'+escapeHtml(it.vendorItemName||String(it.vendorItemId))+'</td><td>'+money(it.salePrice)+'</td><td><input type="number" step="10" data-vendor-item-id="'+attr(it.vendorItemId)+'" value="'+attr(it.salePrice)+'" style="width:8em"></td></tr>').join('')
            +'</table><p><button id="coupangPricePreviewButton" type="button">가격 변경 미리보기</button></p><div id="coupangPricePreviewResult"></div>';
          resultEl.querySelector('#coupangPricePreviewButton').onclick=async()=>{
            const previewEl=resultEl.querySelector('#coupangPricePreviewResult');
            const changed=[...resultEl.querySelectorAll('input[data-vendor-item-id]')].filter(inp=>{
              const original=data.items.find(it=>String(it.vendorItemId)===inp.dataset.vendorItemId);
              return original&&Number(inp.value)!==Number(original.salePrice);
            });
            if(!changed.length){previewEl.innerHTML='<p class="muted">변경된 가격이 없습니다.</p>';return;}
            previewEl.innerHTML='<p class="muted">미리보기 생성 중...</p>';
            const previews=[];
            for(const inp of changed){
              const vendorItemId=Number(inp.dataset.vendorItemId);
              const price=Number(inp.value);
              const preview=await api('/api/product-drafts/'+id+'/coupang-registration/update-price',{method:'POST',body:JSON.stringify({vendorItemId,price})});
              previews.push({vendorItemId,price,inp});
            }
            previewEl.innerHTML='<pre>'+escapeHtml(JSON.stringify(previews.map(p=>({vendorItemId:p.vendorItemId,price:p.price})),null,2))+'</pre><p><button id="coupangPriceConfirmButton" type="button">위 내용으로 실제 반영</button></p>';
            previewEl.querySelector('#coupangPriceConfirmButton').onclick=async()=>{
              if(!confirm('실제 쿠팡 가격을 변경합니다. 되돌릴 수 없습니다. 계속할까요?'))return;
              for(const p of previews){
                await api('/api/product-drafts/'+id+'/coupang-registration/update-price',{method:'POST',body:JSON.stringify({vendorItemId:p.vendorItemId,price:p.price,confirm:true})});
              }
              previewEl.innerHTML='<p>반영 완료.</p>';
              await loadCoupangLiveSection(id,draft);
            };
          };
        }catch(error){
          resultEl.innerHTML='<p class="muted">'+escapeHtml(error.message)+'</p>';
        }
      };
      wireDirectRegisterSection(id,draft,container);
    }
    function collectRegistrationOverrides(section){
      const val=(fieldId)=>{const el=section.querySelector('#'+fieldId);return el&&el.value.trim()?el.value.trim():null;};
      const overrides={};
      if(val('ovMaterial'))overrides.material=val('ovMaterial');
      if(val('ovDimensions'))overrides.dimensions=val('ovDimensions');
      if(val('ovSizeAttribute'))overrides.sizeAttributeValue=val('ovSizeAttribute');
      if(val('ovManufacturer'))overrides.manufacturer=val('ovManufacturer');
      if(val('ovCountryOfOrigin'))overrides.countryOfOrigin=val('ovCountryOfOrigin');
      if(val('ovNoticeTemplate'))overrides.noticeCategoryTemplateName=val('ovNoticeTemplate');
      if(val('ovDisplayCategoryCode'))overrides.displayCategoryCode=Number(val('ovDisplayCategoryCode'));
      if(val('ovHandlingCaution'))overrides.handlingCaution=val('ovHandlingCaution');
      if(val('ovGtin'))overrides.gtin=val('ovGtin');
      if(val('ovMpn'))overrides.mpn=val('ovMpn');
      return overrides;
    }
    function wireDirectRegisterSection(id,draft,container){
      const section=container.querySelector('[data-direct-register]');
      if(!section)return;
      const categoryButton=section.querySelector('#categoryPreviewButton');
      if(categoryButton)categoryButton.onclick=async()=>{
        const resultEl=section.querySelector('#categoryPreviewResult');
        resultEl.innerHTML='<p class="muted">조회 중...</p>';
        try{
          const data=await api('/api/product-drafts/'+id+'/coupang-registration/category-preview');
          resultEl.innerHTML='<div>예측 카테고리: '+escapeHtml(data.prediction.displayCategoryCode||'-')+' / '+escapeHtml(data.prediction.categoryName||'-')+' (resultType='+escapeHtml(data.prediction.predictionResultType||'-')+')</div>'
            +'<div>출고지("행당"): '+(data.outboundShippingPlace?escapeHtml(data.outboundShippingPlace.shippingPlaceName):'<span class="badge reasonBlock">찾지 못함 -- 수동 확인 필요</span>')+'</div>'
            +'<div>반품지("행당"): '+(data.returnShippingCenter?escapeHtml(data.returnShippingCenter.shippingPlaceName):'<span class="badge reasonBlock">찾지 못함 -- 수동 확인 필요</span>')+'</div>'
            +(data.categoryMeta
              ?('<div>필수 구매옵션: '+escapeHtml(JSON.stringify(data.categoryMeta.mandatoryOptionNames))+'</div><div>고시정보 템플릿 후보: '+data.categoryMeta.noticeCategoryTemplates.map(t=>escapeHtml(t.noticeCategoryName)).join(', ')+'</div>')
              :'<div class="muted">카테고리 메타 없음</div>');
          const templates=data.categoryMeta?.noticeCategoryTemplates||[];
          const templateOptions=templates.map(t=>'<option value="'+attr(t.noticeCategoryName)+'">'+escapeHtml(t.noticeCategoryName)+'</option>').join('');
          section.querySelector('#registrationOverridesForm').innerHTML='<div class="section"><h4>미확정값 입력 (비워두면 상품정보 분석 적용값/공급처 데이터를 자동 사용)</h4>'
            +'<label>소재</label><input id="ovMaterial">'
            +'<label>치수(고시정보 문구)</label><input id="ovDimensions">'
            +'<label>필수 옵션 사이즈 속성값(짧은 값)</label><input id="ovSizeAttribute">'
            +'<label>제조자(수입자)</label><input id="ovManufacturer">'
            +'<label>제조국</label><input id="ovCountryOfOrigin">'
            +'<label>고시정보 템플릿</label><select id="ovNoticeTemplate"><option value="">(자동 선택: 첫 번째 후보)</option>'+templateOptions+'</select>'
            +'<label>displayCategoryCode 재지정(선택)</label><input id="ovDisplayCategoryCode" value="'+attr(data.prediction.displayCategoryCode||'')+'">'
            +'<label>취급시 주의사항</label><input id="ovHandlingCaution">'
            +'<label>GTIN(바코드, 공식 식별번호가 있을 때만)</label><input id="ovGtin">'
            +'<label>MPN(제조사 모델번호, 공식 식별번호가 있을 때만)</label><input id="ovMpn">'
            +'</div>';
        }catch(error){
          resultEl.innerHTML='<p class="muted">'+escapeHtml(error.message)+'</p>';
        }
      };
      const previewButton=section.querySelector('#registrationPreviewButton');
      if(previewButton)previewButton.onclick=async()=>{
        const resultEl=section.querySelector('#registrationPreviewResult');
        resultEl.innerHTML='<p class="muted">미리보기 생성 중 (R2 업로드 포함, 시간이 걸릴 수 있습니다)...</p>';
        try{
          const overrides=collectRegistrationOverrides(section);
          const data=await api('/api/product-drafts/'+id+'/coupang-registration/preview',{method:'POST',body:JSON.stringify({overrides})});
          const readyHtml=data.readiness.ready.map(x=>'<div>✔ '+escapeHtml(x)+'</div>').join('');
          const missingHtml=data.readiness.missing.map(x=>'<div class="badge reasonReview">'+escapeHtml(x)+'</div>').join('');
          resultEl.innerHTML='<h4>WING 검수 항목</h4><div><strong>준비됨</strong></div>'+(readyHtml||'<div class="muted">없음</div>')+'<div><strong>미확정</strong></div>'+(missingHtml||'<div class="muted">없음</div>')
            +'<h4>R2 공개 이미지 URL</h4><div>대표: <a href="'+attr(data.mainImageUrl)+'" target="_blank" rel="noopener noreferrer">'+escapeHtml(data.mainImageUrl)+'</a></div><div>상세: '+data.detailImageUrls.length+'장</div>'
            +'<h4>payload 미리보기 (requested=false)</h4><pre>'+escapeHtml(JSON.stringify(data.payload,null,2))+'</pre>'
            +'<p><button id="registerConfirmButton" type="button" '+(data.readiness.blocked?'disabled':'')+'>3. 최종 확인 후 임시등록 (requested=false, 승인요청 아님)</button></p>'
            +(data.readiness.blocked?'<div class="muted">미확정 항목이 남아있어 등록 버튼이 비활성화되어 있습니다. 위 입력값을 채운 뒤 다시 미리보기를 생성하세요.</div>':'');
          const registerButton=section.querySelector('#registerConfirmButton');
          if(registerButton)registerButton.onclick=async()=>{
            if(!confirm('실제 쿠팡에 상품을 생성합니다 (requested=false, 승인요청 아님). sellerProductId가 새로 발급되며 되돌릴 수 없습니다. 계속할까요?'))return;
            const overridesNow=collectRegistrationOverrides(section);
            const registerResultEl=section.querySelector('#registrationResult');
            registerResultEl.textContent='등록 중...';
            try{
              const registered=await api('/api/product-drafts/'+id+'/coupang-registration/register',{method:'POST',body:JSON.stringify({overrides:overridesNow,confirm:true})});
              registerResultEl.innerHTML='<div>등록 완료: sellerProductId='+escapeHtml(registered.sellerProductId)+' / requested=false</div>';
              await api('/api/product-drafts/'+id+'/coupang-registration/refresh',{method:'POST',body:'{}'});
              await loadCoupangLiveSection(id,draft);
            }catch(error){
              registerResultEl.innerHTML='<p class="muted">'+escapeHtml(error.message)+'</p>';
            }
          };
        }catch(error){
          resultEl.innerHTML='<p class="muted">'+escapeHtml(error.message)+'</p>';
        }
      };
    }
    async function loadNaverLiveSection(id,draft){
      const panel=document.querySelector('#detail [data-panel="naverLive"]');
      if(!panel)return;
      const container=panel.querySelector('#naverLiveContent');
      const [regData,mainRes,detailRes]=await Promise.all([
        api('/api/product-drafts/'+id+'/naver-registration'),
        api('/api/product-drafts/'+id+'/ai-workflows/main-image/results'),
        api('/api/product-drafts/'+id+'/ai-workflows/detail-page/results'),
      ]);
      const reg=regData.registration;
      const approvedMain=(mainRes.results||[]).find(r=>r.status==='approved')||null;
      const approvedDetail=(detailRes.sets||[]).find(s=>s.status==='approved')||null;
      container.innerHTML=naverLiveHtml(draft,reg,approvedMain,approvedDetail);
      wireNaverLiveSection(id,draft,container);
    }
    function naverLiveHtml(draft,reg,approvedMain,approvedDetail){
      const linked=reg&&reg.originProductNo;
      const linkSection=linked
        ?'<div><strong>연결됨</strong>: originProductNo '+escapeHtml(reg.originProductNo)+' <span class="badge status">'+escapeHtml(reg.linkedVia||'')+'</span> / status '+escapeHtml(reg.status||'')+'</div>'
        :'<div class="muted">아직 네이버 상품과 연결되지 않았습니다. 스피드등록으로 등록한 뒤 네이버 커머스센터에서 originProductNo를 확인해 입력하세요.</div><label>originProductNo</label><input id="naverLinkOriginProductNo"><p><button id="naverLinkButton" type="button">연결하기</button></p>';
      const imagesReady=approvedMain&&approvedDetail;
      const swapSection='<div class="section"><h3>이미지 반영</h3>'
        +(imagesReady
          ?'<div>승인된 대표이미지: <img src="'+attr(approvedMain.coupangStoredUrl)+'"> 승인된 상세이미지 '+approvedDetail.images.length+'장</div><p><button id="naverSwapPreviewButton" type="button" '+(linked?'':'disabled')+'>이미지 반영 미리보기</button></p><div id="naverSwapPreviewResult"></div>'
          :'<div class="muted">승인된 대표이미지 또는 상세이미지 세트가 아직 없습니다 (이미지 프롬프트 탭에서 먼저 승인하세요).</div>')
        +'</div>';
      const priceSection='<div class="section"><h3>가격 조정</h3>'
        +(linked
          ?'<p><button id="naverPriceLoadButton" type="button">현재 가격 불러오기</button></p><div id="naverPriceResult"></div>'
          :'<div class="muted">먼저 네이버 상품과 연결해야 합니다.</div>')
        +'</div>';
      return '<div class="section">'+linkSection+'</div>'+swapSection+priceSection;
    }
    function wireNaverLiveSection(id,draft,container){
      const linkButton=container.querySelector('#naverLinkButton');
      if(linkButton)linkButton.onclick=async()=>{
        const originProductNo=container.querySelector('#naverLinkOriginProductNo').value.trim();
        if(!originProductNo){alert('originProductNo를 입력하세요');return;}
        await api('/api/product-drafts/'+id+'/naver-registration/link',{method:'POST',body:JSON.stringify({originProductNo})});
        await loadNaverLiveSection(id,draft);
      };
      const swapPreviewButton=container.querySelector('#naverSwapPreviewButton');
      if(swapPreviewButton)swapPreviewButton.onclick=async()=>{
        const resultEl=container.querySelector('#naverSwapPreviewResult');
        resultEl.innerHTML='<p class="muted">미리보기 생성 중...</p>';
        try{
          const data=await api('/api/product-drafts/'+id+'/naver-registration/swap-images',{method:'POST',body:JSON.stringify({})});
          resultEl.innerHTML='<pre>'+escapeHtml(JSON.stringify(data.payload,null,2))+'</pre><p><button id="naverSwapConfirmButton" type="button">위 내용으로 실제 반영</button></p>';
          resultEl.querySelector('#naverSwapConfirmButton').onclick=async()=>{
            if(!confirm('실제 네이버 상품에 이미지를 반영합니다. 되돌릴 수 없습니다. 계속할까요?'))return;
            const confirmed=await api('/api/product-drafts/'+id+'/naver-registration/swap-images',{method:'POST',body:JSON.stringify({confirm:true})});
            resultEl.innerHTML='<p>반영 완료. statusType='+escapeHtml(confirmed.after?.originProduct?.statusType||'')+'</p>';
            await loadNaverLiveSection(id,draft);
          };
        }catch(error){
          resultEl.innerHTML='<p class="muted">'+escapeHtml(error.message)+'</p>';
        }
      };
      const priceLoadButton=container.querySelector('#naverPriceLoadButton');
      if(priceLoadButton)priceLoadButton.onclick=async()=>{
        const resultEl=container.querySelector('#naverPriceResult');
        resultEl.innerHTML='<p class="muted">불러오는 중...</p>';
        try{
          const data=await api('/api/product-drafts/'+id+'/naver-registration/update-price',{method:'POST',body:JSON.stringify({})});
          resultEl.innerHTML='<div>현재 가격: '+money(data.currentSalePrice)+'</div><label>새 가격</label><input id="naverNewPrice" type="number" value="'+attr(data.currentSalePrice??'')+'"><p><button id="naverPricePreviewButton" type="button">가격 변경 미리보기</button></p><div id="naverPricePreviewResult"></div>';
          resultEl.querySelector('#naverPricePreviewButton').onclick=async()=>{
            const previewEl=resultEl.querySelector('#naverPricePreviewResult');
            const salePrice=Number(resultEl.querySelector('#naverNewPrice').value);
            if(!Number.isFinite(salePrice)){previewEl.innerHTML='<p class="muted">유효한 가격을 입력하세요.</p>';return;}
            previewEl.innerHTML='<p class="muted">미리보기 생성 중...</p>';
            const preview=await api('/api/product-drafts/'+id+'/naver-registration/update-price',{method:'POST',body:JSON.stringify({salePrice})});
            previewEl.innerHTML='<pre>'+escapeHtml(JSON.stringify(preview.payload,null,2))+'</pre><p><button id="naverPriceConfirmButton" type="button">위 내용으로 실제 반영</button></p>';
            previewEl.querySelector('#naverPriceConfirmButton').onclick=async()=>{
              if(!confirm('실제 네이버 가격을 변경합니다. 되돌릴 수 없습니다. 계속할까요?'))return;
              const confirmed=await api('/api/product-drafts/'+id+'/naver-registration/update-price',{method:'POST',body:JSON.stringify({salePrice,confirm:true})});
              previewEl.innerHTML='<p>반영 완료. 새 가격='+money(confirmed.after?.salePrice)+'</p>';
              await loadNaverLiveSection(id,draft);
            };
          };
        }catch(error){
          resultEl.innerHTML='<p class="muted">'+escapeHtml(error.message)+'</p>';
        }
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
    async function api(path,options={}){const response=await fetch(path,{headers:{'content-type':'application/json'},...options});const data=await response.json();if(!response.ok)throw Object.assign(new Error(data.error||'Request failed'),{code:data.code,details:data});return data;}
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
    renderAiPromptSectionsV1=async function(id){await renderAiPromptSectionsBaseV1(id);const panel=document.querySelector('#detail [data-panel="image"]');if(!panel)return;const [data,result]=await Promise.all([api('/api/product-drafts/'+id+'/debug-export'),api('/api/product-drafts/'+id+'/ai-workflows/detail-page/results')]);panel.insertAdjacentHTML('beforeend',manualDetailWorkflowHtmlV1(id,data,result.sets||[]));const workflow=panel.querySelector('[data-manual-detail-workflow]'),request=data.imagePromptState?.detailPage?.request||{},latest=(result.sets||[])[0],files=workflow.querySelector('[name="images[]"]'),order=workflow.querySelector('[data-detail-file-order]');const showOrder=()=>{order.innerHTML=[...files.files].map((file,index)=>'<li>'+String(index+1)+'. '+escapeHtml(file.name)+'</li>').join('');};files.onchange=showOrder;workflow.querySelector('[data-detail-copy-rendered]').onclick=async()=>{await copyText(request.promptRendered||'');workflow.querySelector('[data-detail-copy-feedback]').textContent='복사 완료 / revision '+(request.revision||1)+' / expectedImageCount=10 / '+(request.templateHash||'').slice(0,12)};workflow.querySelector('[data-detail-copy-original]').onclick=async()=>{await copyText(request.promptOriginal||'');workflow.querySelector('[data-detail-copy-feedback]').textContent='복사 완료 / revision '+(request.revision||1)+' / expectedImageCount=10 / '+(request.templateHash||'').slice(0,12)};workflow.querySelector('[name="providerCode"]').onchange=e=>workflow.querySelector('[name="providerDisplayName"]').hidden=e.target.value!=='custom';workflow.querySelector('[data-manual-detail-upload]').onsubmit=async event=>{event.preventDefault();if(files.files.length!==10){workflow.querySelector('[data-detail-message]').textContent='상세페이지 이미지는 정확히 10장을 업로드해야 합니다.';return;}const response=await fetch('/api/product-drafts/'+id+'/ai-workflows/detail-page/upload',{method:'POST',body:new FormData(event.target)}),value=await response.json();if(!response.ok){workflow.querySelector('[data-detail-message]').textContent=value.error;return;}await renderAiPromptSectionsV1(id)};workflow.querySelector('[data-detail-approve]').onclick=async()=>{if(latest?.status==='uploaded'){await api('/api/product-drafts/'+id+'/ai-workflows/detail-page/sets/'+latest.id+'/approve',{method:'POST',body:'{}'});await renderAiPromptSectionsV1(id)}};workflow.querySelector('[data-detail-reject]').onclick=async()=>{if(latest?.status==='uploaded'){await api('/api/product-drafts/'+id+'/ai-workflows/detail-page/sets/'+latest.id+'/reject',{method:'POST',body:'{}'});await renderAiPromptSectionsV1(id)}};workflow.querySelector('[data-codex-generate-detail]').onclick=async()=>{const statusEl=workflow.querySelector('[data-codex-detail-status]');statusEl.textContent='Codex 상세이미지 10장 생성 중... (수 분~수십 분 소요될 수 있습니다, 서버는 계속 응답합니다)';try{const value=await api('/api/product-drafts/'+id+'/ai-workflows/detail-page/codex-generate',{method:'POST',body:'{}'});statusEl.textContent='생성 완료: set v'+value.set.setVersion+' / status='+value.set.status+' (승인 대기, 아직 자동 승인되지 않음) / '+value.set.imageCount+'장 / 파일 '+value.generatedFileCount+'개 감지됨';await renderAiPromptSectionsV1(id);}catch(error){const detail=error.details?.actualCount!=null?(' (생성된 파일 '+error.details.actualCount+'/'+ (error.details.expectedCount||10)+'장)'):'';statusEl.textContent='생성 실패 ['+(error.code||'ERROR')+']: '+error.message+detail;}};workflow.querySelector('[data-codex-refresh-detail]').onclick=async()=>{await renderAiPromptSectionsV1(id);};};
    function renderHtmlDetailSectionV1(d){return '<div class="section" data-html-detail-helper="true"><h2>HTML 상세페이지 v2</h2><p class="muted">현재 판매 등록용 HTML 상세페이지입니다.</p><div>HTML '+((d.generated_detail_html??d.generatedDetailHtml??'')?'있음':'없음')+' / 길이 '+(d.generated_detail_html??d.generatedDetailHtml??'').length+'</div></div>';}
    function insertHtmlDetailSectionV1(d){window.__adminUiDiagnostics.callSiteReached=true;const panel=document.querySelector('#detail [data-panel="detail"]');if(!panel)return;panel.querySelector('[data-html-detail-helper="true"]')?.remove();panel.insertAdjacentHTML('beforeend',renderHtmlDetailSectionV1(d));window.__adminUiDiagnostics.htmlDetailRenderCalls=(window.__adminUiDiagnostics.htmlDetailRenderCalls||0)+1;window.__adminUiDiagnostics.helperOutputInserted=Boolean(panel.querySelector('[data-html-detail-helper="true"]'));}
    const runtimeInitialId=Number(new URL(location.href).searchParams.get('draftId'))||null;
    window.__adminUiDiagnostics.initialId=runtimeInitialId;
    window.__adminUiDiagnostics.initialLoadDetailCallAttempted=Boolean(runtimeInitialId);
    window.__adminUiDiagnostics.loadDetailInvocations=runtimeInitialId?[{draftId:runtimeInitialId,calledAt:new Date().toISOString()}]:[];
    window.__adminUiDiagnostics.actualLoadDetailEntered=Boolean(runtimeInitialId);
    function promptCardV1(kind,label,data){const entry=kind==='main_image'?data.imagePromptState?.mainImage:data.imagePromptState?.detailPage;const r=entry?.request;const t=entry?.template;const warnings=(r?.warnings||[]).map(x=>'<span class="badge reasonReview">'+escapeHtml(x)+'</span>').join(' ');const empty=kind==='detail_page'&&data.generatedAiImageCount===0?'<p class="muted">DOCX 기반 프롬프트만 준비되어 있습니다.<br>아직 GPT Image로 생성된 상세페이지 이미지는 없습니다.</p>':'';return '<div class="section" data-ai-prompt-section="'+kind+'"><h2>'+label+'</h2><div>prompt state: '+(r?'current':'no_request')+' / DOCX: '+escapeHtml(r?.sourceFileName||t?.source_file_name||'-')+' / version '+(r?.templateVersion||'-')+' / hash '+escapeHtml((r?.templateHash||'').slice(0,12)||'-')+' / revision '+(r?.revision||'-')+'</div>'+empty+'<p><button data-prompt-create="'+kind+'">현재 DOCX 템플릿으로 최초 생성</button> <button data-prompt-regenerate="'+kind+'">명시적 재생성</button> <button data-copy-target="original-'+kind+'">원문 복사</button> <button data-copy-target="rendered-'+kind+'">치환본 복사</button> <button data-prompt-status-v1="approved" data-prompt-kind="'+kind+'">승인</button> <button data-prompt-status-v1="rejected" data-prompt-kind="'+kind+'">거절</button></p><p><button type="button" data-toggle-original="'+kind+'">원문 보기</button></p><div class="promptCollapsible" data-original-wrap="'+kind+'" hidden><label>원문</label><pre data-prompt-text="original-'+kind+'">'+escapeHtml(r?.promptOriginal||'')+'</pre></div><label>치환본</label><pre data-prompt-text="rendered-'+kind+'">'+escapeHtml(r?.promptRendered||'')+'</pre><div>'+warnings+'</div></div>';}
    function manualWorkflowHtmlV1(id,data,results){const r=data.imagePromptState?.mainImage?.request||{};const source=data.images?.mainImages?.[0]||null;const latest=results[0]||null;const history=results.map(x=>'<button type="button" data-manual-version="'+x.version+'">v'+x.version+' '+escapeHtml(x.status)+'</button>').join(' ');return '<div class="section" data-manual-main-image-workflow><h3>외부 AI 대표이미지 반수동 작업</h3><p><a class="packageDownload" data-manual-package href="/api/product-drafts/'+id+'/ai-workflows/main-image/package">⬇ 작업 패키지 다운로드</a></p><p><button type="button" data-copy-rendered>치환 프롬프트 복사</button> <button type="button" data-copy-original>원문 프롬프트 복사</button></p><div data-copy-feedback class="muted"></div><p><button type="button" data-codex-generate-main>Codex 대표이미지 생성</button> <button type="button" data-codex-refresh-main>생성 결과 새로고침</button></p><div data-codex-main-status class="muted"></div><form data-manual-upload enctype="multipart/form-data"><input type="file" name="image" accept="image/png,image/jpeg,image/webp"><select name="providerCode"><option value="chatgpt">ChatGPT</option><option value="google_gemini">Google Gemini</option><option value="anthropic_claude">Anthropic Claude</option><option value="custom">Custom / 기타</option></select><input name="providerDisplayName" placeholder="Custom 공급자 이름"><textarea name="notes" placeholder="사용자 메모"></textarea><input type="hidden" name="promptRequestId" value="'+(r.id||'')+'"><input type="hidden" name="promptRevision" value="'+(r.revision||1)+'"><button type="submit">외부 AI 결과 업로드</button></form><div class="grid" data-manual-comparison><div><h4>원본 대표이미지</h4>'+(source?'<a href="'+attr(source)+'" target="_blank"><img src="'+attr(source)+'" alt="원본 대표이미지"></a>':'<p class="muted">원본 대표이미지 없음</p>')+'</div><div><h4>외부 AI 생성 이미지</h4>'+(latest?'<a href="'+attr(latest.coupangStoredUrl)+'" target="_blank"><img src="'+attr(latest.coupangStoredUrl)+'" alt="외부 AI 생성 이미지"></a><p>version '+latest.version+' / '+escapeHtml(latest.providerDisplayName||latest.providerCode)+' / '+escapeHtml(latest.status)+'</p><p>'+latest.width+'x'+latest.height+' / '+escapeHtml(latest.coupangMimeType||'')+' / '+escapeHtml(latest.createdAt||'')+'</p>':'<p class="muted" data-manual-empty>아직 업로드된 외부 AI 생성 이미지가 없습니다.</p>')+'</div></div><div data-manual-history>'+history+'</div><p><button type="button" data-manual-approve '+(latest?'':'disabled')+'>업로드 결과 승인</button> <button type="button" data-manual-reject '+(latest?'':'disabled')+'>업로드 결과 거절</button></p><div data-manual-message class="muted"></div></div>';}
    function manualDetailWorkflowHtmlV1(id,data,sets){const r=data.imagePromptState?.detailPage?.request||{},latest=sets[0]||null,thumbs=(latest?.images||[]).map(x=>'<a href="'+attr(x.normalizedStoredUrl)+'" target="_blank"><img src="'+attr(x.normalizedStoredUrl)+'" alt="'+x.imageIndex+'번 '+escapeHtml(x.sectionLabel)+'"><small>'+x.imageIndex+'. '+escapeHtml(x.sectionLabel)+' / '+x.normalizedWidth+'x'+x.normalizedHeight+'</small></a>').join('');return '<div class="section" data-manual-detail-workflow><h3>외부 AI 상세페이지 이미지 세트</h3><p><a class="packageDownload" href="/api/product-drafts/'+id+'/ai-workflows/detail-page/package">⬇ 상세페이지 작업 패키지 다운로드</a></p><p class="muted">HTML 상세페이지 v2와 반수동 AI 상세페이지 이미지 세트를 병행 관리합니다.</p><p><button type="button" data-detail-copy-rendered>상세페이지 치환 프롬프트 복사</button> <button type="button" data-detail-copy-original>상세페이지 원문 프롬프트 복사</button></p><div data-detail-copy-feedback class="muted"></div><p><button type="button" data-codex-generate-detail>Codex 상세이미지 생성</button> <button type="button" data-codex-refresh-detail>생성 결과 새로고침</button></p><div data-codex-detail-status class="muted"></div><form data-manual-detail-upload enctype="multipart/form-data"><input type="file" name="images[]" accept="image/png,image/jpeg,image/webp" multiple required><p class="muted">정확히 10장을 한 번에 선택하세요. 파일명 기준으로 자동 정렬되며, 순서가 다를 때만 썸네일을 드래그해 수정하세요.</p><ol data-detail-file-order></ol><select name="providerCode"><option value="chatgpt">ChatGPT</option><option value="google_gemini">Google Gemini</option><option value="anthropic_claude">Anthropic Claude</option><option value="custom">Custom / 기타</option></select><input name="providerDisplayName" placeholder="Custom 공급자 이름" hidden><textarea name="notes" placeholder="사용자 메모"></textarea><input type="hidden" name="promptRequestId" value="'+(r.id||'')+'"><input type="hidden" name="promptRevision" value="'+(r.revision||1)+'"><button type="submit">상세페이지 이미지 세트 업로드</button></form><div class="grid" data-detail-thumbnails>'+ (thumbs||'<p class="muted">생성된 상세페이지 이미지 세트 없음</p>')+'</div><p>세트 '+(latest?'v'+latest.setVersion+' / '+escapeHtml(latest.status)+' / '+latest.imageCount+'장':'없음')+'</p><p><button type="button" data-detail-approve '+(latest?.status==='uploaded'?'':'disabled')+'>세트 승인</button> <button type="button" data-detail-reject '+(latest?.status==='uploaded'?'':'disabled')+'>세트 거절</button></p><div data-detail-message class="muted"></div></div>';}
    async function renderAiPromptSectionsV1(id){const [data,resultData]=await Promise.all([api('/api/product-drafts/'+id+'/debug-export'),api('/api/product-drafts/'+id+'/ai-workflows/main-image/results')]);const panel=document.querySelector('#detail [data-panel="image"]');if(!panel)return;panel.innerHTML=promptCardV1('main_image','AI 대표이미지 프롬프트',data)+manualWorkflowHtmlV1(id,data,resultData.results||[])+promptCardV1('detail_page','AI 이미지형 상세페이지 프롬프트',data);panel.querySelectorAll('[data-prompt-create]').forEach(b=>b.onclick=async()=>{await api('/api/product-drafts/'+id+'/image-prompts/'+b.dataset.promptCreate,{method:'POST',body:'{}'});await renderAiPromptSectionsV1(id)});panel.querySelectorAll('[data-prompt-regenerate]').forEach(b=>b.onclick=async()=>{await api('/api/product-drafts/'+id+'/image-prompts/'+b.dataset.promptRegenerate+'/regenerate',{method:'POST',body:JSON.stringify({confirm:true})});await renderAiPromptSectionsV1(id)});panel.querySelectorAll('[data-prompt-status-v1]').forEach(b=>b.onclick=async()=>{await api('/api/product-drafts/'+id+'/image-prompts/'+b.dataset.promptKind,{method:'PATCH',body:JSON.stringify({status:b.dataset.promptStatusV1})});await renderAiPromptSectionsV1(id)});panel.querySelectorAll('[data-copy-target]').forEach(b=>b.onclick=()=>copyText(panel.querySelector('[data-prompt-text="'+b.dataset.copyTarget+'"]').textContent));panel.querySelectorAll('[data-toggle-original]').forEach(b=>b.onclick=()=>{const wrap=panel.querySelector('[data-original-wrap="'+b.dataset.toggleOriginal+'"]');wrap.hidden=!wrap.hidden;b.textContent=wrap.hidden?'원문 보기':'원문 숨기기';});const workflow=panel.querySelector('[data-manual-main-image-workflow]'),request=data.imagePromptState?.mainImage?.request||{},latest=(resultData.results||[])[0];workflow.querySelector('[data-copy-rendered]').onclick=async()=>{await copyText(request.promptRendered||'');workflow.querySelector('[data-copy-feedback]').textContent='복사 완료 / revision '+(request.revision||1)+' / '+(request.templateHash||'').slice(0,12)};workflow.querySelector('[data-copy-original]').onclick=async()=>{await copyText(request.promptOriginal||'');workflow.querySelector('[data-copy-feedback]').textContent='복사 완료 / revision '+(request.revision||1)+' / '+(request.templateHash||'').slice(0,12)};workflow.querySelector('[name="providerCode"]').onchange=e=>workflow.querySelector('[name="providerDisplayName"]').hidden=e.target.value!=='custom';workflow.querySelector('[data-manual-upload]').onsubmit=async event=>{event.preventDefault();const response=await fetch('/api/product-drafts/'+id+'/ai-workflows/main-image/upload',{method:'POST',body:new FormData(event.target)});const value=await response.json();if(!response.ok){workflow.querySelector('[data-manual-message]').textContent=value.error;return}await renderAiPromptSectionsV1(id)};workflow.querySelector('[data-manual-approve]').onclick=async()=>{if(latest){await api('/api/product-drafts/'+id+'/ai-workflows/main-image/results/'+latest.id+'/approve',{method:'POST',body:'{}'});await renderAiPromptSectionsV1(id)}};workflow.querySelector('[data-manual-reject]').onclick=async()=>{if(latest){await api('/api/product-drafts/'+id+'/ai-workflows/main-image/results/'+latest.id+'/reject',{method:'POST',body:'{}'});await renderAiPromptSectionsV1(id)}};workflow.querySelector('[data-codex-generate-main]').onclick=async()=>{const statusEl=workflow.querySelector('[data-codex-main-status]');statusEl.textContent='Codex 대표이미지 생성 중... (최대 수 분 소요, 서버는 계속 응답합니다)';try{const value=await api('/api/product-drafts/'+id+'/ai-workflows/main-image/codex-generate',{method:'POST',body:'{}'});statusEl.textContent='생성 완료: version '+value.result.version+' / status='+value.result.status+' (승인 대기, 아직 자동 승인되지 않음) / 파일 '+value.generatedFileCount+'개 감지됨';await renderAiPromptSectionsV1(id);}catch(error){statusEl.textContent='생성 실패 ['+(error.code||'ERROR')+']: '+error.message;}};workflow.querySelector('[data-codex-refresh-main]').onclick=async()=>{await renderAiPromptSectionsV1(id);};}
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





