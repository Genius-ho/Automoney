// "URL로 상품 등록" -- 사람이 도매매/도매꾹에서 직접 고른 상품의 URL(또는 상품번호)을
// 붙여넣으면 그 상품 하나만 초안으로 만든다. 3일 주기 자동발굴과 달리 스코어링/화이트
// 리스트 없이 바로 저장 -- 사람이 이미 상품을 직접 보고 골랐으므로(오늘 쿠팡 키워드
// 소싱에서 화이트리스트를 뺀 것과 같은 이유). evaluateCandidates/saveEvaluatedCandidate를
// 그대로 재사용해 나머지 파이프라인(이미지 생성, 승인함, 등록)과 완전히 동일한 경로를 탄다.
import { evaluateCandidates, saveEvaluatedCandidate } from './candidate-collector.mjs';
import { loadCodexConfig, loadJobPathsConfig, loadTelegramConfig } from './config.mjs';
import { generateDetailImageSet, generateMainImage } from './manual-ai/codex-image-runner.mjs';
import { sendTelegramMessage } from './telegram-notifier.mjs';

export function parseSupplierProductNo(input) {
  const text = String(input || '').trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return text;
  try {
    const url = new URL(text);
    const no = url.searchParams.get('no');
    if (no && /^\d+$/.test(no)) return no;
  } catch {
    return null;
  }
  return null;
}

export async function importDraftFromSupplierUrl(domemeClient, input, pricingRules, {
  db,
  importBatchPrefix = 'manual-url-import',
  evaluateCandidatesImpl = evaluateCandidates,
  saveEvaluatedCandidateImpl = saveEvaluatedCandidate,
} = {}) {
  const productNo = parseSupplierProductNo(input);
  if (!productNo) {
    const error = new Error('상품 URL 또는 상품번호를 인식하지 못했습니다');
    error.code = 'INVALID_INPUT';
    throw error;
  }

  const [candidate] = await evaluateCandidatesImpl(domemeClient, [{ productNo }], pricingRules, {
    includeNeedsReview: true,
    includeDomeggook: true,
  });
  if (candidate.error) throw candidate.error;

  const saved = await saveEvaluatedCandidateImpl(db, candidate, {
    importBatchId: `${importBatchPrefix}-${Date.now()}`,
    collectedAt: new Date().toISOString(),
  });
  if (!saved.saved) throw saved.error;

  return {
    draftId: saved.draftId,
    supplierProductId: saved.supplierProductId,
    dbAction: saved.dbAction,
    filterStatus: candidate.filter.filterStatus,
    sourceMarket: candidate.normalized?.sourceMarket || null,
  };
}

// Runs after a draft is created -- whether via the "URL 등록" HTTP route or a
// Telegram registration-button tap (coupang-keyword-telegram.mjs) -- so both
// entry points get identical behavior. Codex main + detail image generation
// can take minutes, so neither caller holds its response/callback open for
// it. Reuses the exact same generateMainImage/generateDetailImageSet calls
// the manual-ai workflow's own "Codex 생성" buttons already use for an
// existing draft -- this just triggers them automatically once, right after
// import, instead of waiting for someone to click. Leaves the draft at
// whatever awaiting-approval state those already leave it in; approval/
// registration still goes through the existing 승인함/detail-page GUI
// untouched.
export async function generateManualImportImagesAndNotify(db, rootDir, draftId, {
  loadCodexConfigImpl = loadCodexConfig,
  loadJobPathsConfigImpl = loadJobPathsConfig,
  loadTelegramConfigImpl = loadTelegramConfig,
  generateMainImageImpl = generateMainImage,
  generateDetailImageSetImpl = generateDetailImageSet,
  sendTelegramMessageImpl = sendTelegramMessage,
} = {}) {
  const [codexConfig, jobPathsConfig, telegramConfig] = await Promise.all([
    loadCodexConfigImpl(rootDir), loadJobPathsConfigImpl(rootDir), loadTelegramConfigImpl(rootDir),
  ]);
  let message;
  try {
    await generateMainImageImpl(db, rootDir, jobPathsConfig.jobDir, draftId, { codexConfig });
    await generateDetailImageSetImpl(db, rootDir, jobPathsConfig.jobDir, draftId, { codexConfig });
    message = `✅ 초안 #${draftId} 1차 가공(대표+상세 이미지) 완료 -- 확인하고 승인해주세요.\nhttp://hoaiserver:3000/admin?draftId=${draftId}`;
  } catch (error) {
    message = `⚠️ 초안 #${draftId} 이미지 생성 실패: ${error.message}`;
  }
  await sendTelegramMessageImpl(telegramConfig, message).catch((error) => {
    console.error(`manualUrlImport.telegramFailed=${error.message}`);
  });
}
