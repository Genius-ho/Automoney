import { writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { getProductDraft, getMarketResearch } from './admin-store.mjs';
import { listManualMainImages } from './manual-ai/workflow-store.mjs';
import { listManualDetailSets } from './manual-ai/detail-workflow-store.mjs';
import { generateMainImage, generateDetailImageSet } from './manual-ai/codex-image-runner.mjs';
import { getImageGenerationJobPaths } from './product-job-folder.mjs';
import { approveInboxImages } from './approval-inbox-service.mjs';
import { listTaskRouting } from './ai/provider-settings-store.mjs';
import { getProvider } from './ai/provider-registry.mjs';
import { checkClaudeCliAvailability } from './claude-cli-client.mjs';
import { loadClaudeCliConfig, loadCodexConfig, loadJobPathsConfig, loadNaverCommerceConfig } from './config.mjs';
import { insertImageQaReview } from './image-qa-store.mjs';
import { runSpeedgoNaverRegistration } from './speedgo-registration.mjs';

const TASK_TYPE = 'generated_image_review';
const DEFAULT_MAX_ATTEMPTS = 2;

function mimeExtFromUrl(url) {
  if (url.endsWith('.png')) return 'png';
  if (url.endsWith('.webp')) return 'webp';
  return 'jpg';
}

// The review runs through the local Claude Code CLI, which reads local
// files by path rather than accepting pre-encoded bytes -- so this just
// needs to resolve the real absolute path on disk, not read/encode it.
async function loadImageForVision(rootDir, storedUrl) {
  const relative = storedUrl.startsWith('/') ? storedUrl.slice(1) : storedUrl;
  return { filePath: join(resolve(rootDir), 'public', relative), cleanup: null };
}

// Naver's own competitor thumbnails are external https URLs (not this app's
// /public/... files, and not something the local CLI can read directly), so
// this downloads it to a scratch temp file and hands back a cleanup so the
// caller can remove it once the review call is done.
async function loadRemoteImageForVision(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch competitor thumbnail (HTTP ${response.status}): ${url}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const filePath = join(tmpdir(), `automoney-qa-competitor-${randomUUID()}.${mimeExtFromUrl(url)}`);
  await writeFile(filePath, buffer);
  return { filePath, cleanup: () => rm(filePath, { force: true }) };
}

// User explicitly chose title/price/thumbnail benchmarking only (not scraping
// a competitor's own detail page) -- reuses whatever market_research_results
// already has for this draft (getMarketResearch, admin-store.mjs) rather than
// triggering a fresh live Naver API call from the QA agent itself. Returns
// null when no research has been run yet for this draft (GUI's "네이버
// 경쟁분석 refresh" button is the only thing that populates it), in which case
// the QA prompt just skips the benchmark section entirely.
function extractBestCompetitor(research) {
  const items = research?.raw?.searchRaw?.items;
  const best = Array.isArray(items) ? items[0] : null;
  if (!best) return null;
  return {
    title: String(best.title || '').replace(/<[^>]*>/g, ''),
    mallName: best.mallName || '',
    price: Number(best.lprice) || null,
    imageUrl: best.image || null,
  };
}

// Confirmed live 2026-08-15: exact issue types a human missed on real
// generated sets this session -- leftover reference-image text unrelated to
// this product (magic hose's "7.5m" box), options/colors in the image not
// matching what's actually for sale, and fabricated spec claims.
//
// Check 3's wording was narrowed 2026-08-16 after a real false positive on
// draft 9: the operator confirmed a star-rating/"후기" graphic is an
// intentional, accepted marketing convention for this shop, not something
// to flag -- the actual problem on that draft was a real one (사이즈만 파는
// 상품인데 이미지에 없는 색상 옵션이 등장하고, 그마저 이미지끼리 서로 다르게
// 표기됨), which check 1 already covers. Only fabricated PRODUCT SPEC claims
// (durability/material/certifications/등) should still be flagged here.
function buildPrompt(draft, competitor) {
  const optionsText = (draft.options || []).map((o) => `${o.name}: ${o.value}`).join(', ') || '(단일 옵션)';
  const checks = [
    '1. 이미지에 표시된 옵션/색상/사이즈가 위 판매 옵션과 정확히 일치하는가 (실제 판매하지 않는 옵션이나 사이즈가 텍스트/소품으로 남아있지 않은가, 이미지끼리 서로 다른 옵션/색상을 표기하고 있지 않은가)',
    '2. 상품명/브랜드가 정확히 표기되었는가',
    '3. 근거 없이 과장되거나 허위인 "제품 스펙" 주장이 없는가 (내구성/소재/인증 등 실제 사실 여부를 확인할 수 없는 구체적 스펙 주장만 해당 -- 별점/후기 스타일의 연출용 그래픽은 일반적인 마케팅 관행이므로 문제로 지적하지 말 것)',
    '4. 대표이미지가 실제 이 상품을 명확하게 보여주는가 (다른 상품이 찍혀있지 않은가)',
  ];
  let benchmarkSection = '';
  if (competitor) {
    checks.push('5. 마지막 이미지는 비슷한 상품을 파는 네이버 쇼핑 상위 판매자의 대표이미지다. 이것과 비교했을 때 우리 상세페이지 구성이나 대표이미지가 두드러지게 부족해 보이는 점이 있는가 (있다면 issues에 담을 것)');
    benchmarkSection = `\n비교 대상 (네이버 쇼핑 상위 판매자):\n- 상품명: ${competitor.title}\n- 판매처: ${competitor.mallName}\n- 가격: ${competitor.price != null ? competitor.price + '원' : '알수없음'}\n(첨부된 마지막 이미지가 이 판매자의 대표이미지)\n`;
  }
  return `너는 이커머스 상품 이미지 품질 검수자다. 아래는 실제 판매될 상품의 대표이미지 1장과 상세페이지 이미지 여러 장이다.

상품명: ${draft.sellingTitle}
판매 옵션: ${optionsText}
판매가: ${draft.coupangSalePrice}원
${benchmarkSection}
다음을 확인해라:
${checks.join('\n')}

문제가 없으면 pass:true, 있으면 pass:false와 issues 배열(각 항목 {"severity":"high"|"low","description":"..."})을 담아
반드시 아래 JSON 형식으로만 답해라 (다른 텍스트 없이):
{"pass": true, "issues": []}`;
}

function parseVerdict(rawText) {
  const match = rawText.match(/\{[\s\S]*\}/);
  if (!match) throw Object.assign(new Error('QA response did not contain JSON'), { code: 'UNPARSEABLE_VERDICT' });
  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch (error) {
    throw Object.assign(new Error(`QA response JSON failed to parse: ${error.message}`), { code: 'UNPARSEABLE_VERDICT' });
  }
  if (typeof parsed.pass !== 'boolean') throw Object.assign(new Error('QA response JSON missing boolean pass field'), { code: 'INVALID_VERDICT_SHAPE' });
  return { pass: parsed.pass, issues: Array.isArray(parsed.issues) ? parsed.issues : [] };
}

function issuesToExtraInstructions(issues) {
  return issues.map((issue) => `- [${issue.severity || 'issue'}] ${issue.description}`).join('\n');
}

// Runs once per draft sitting in awaiting_image_approval (see
// processing-queue-store.mjs's getNextQaReviewItem). Internally retries up
// to maxAttempts times (default 2: the original attempt + one regeneration)
// -- a fail on the last attempt just leaves the draft exactly where it
// already was, with every attempt's review row now explaining why, same as
// before this retry loop existed. A pass at any attempt calls the exact same
// approveInboxImages() a human clicking approve already uses (which owns the
// real state transition + downstream auto-registration) -- this module never
// touches processing_queue/generated_ai_images status on its own.
export async function reviewGeneratedImages(db, rootDir, draftId, {
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  getProductDraftImpl = getProductDraft,
  getMarketResearchImpl = getMarketResearch,
  listManualMainImagesImpl = listManualMainImages,
  listManualDetailSetsImpl = listManualDetailSets,
  listTaskRoutingImpl = listTaskRouting,
  loadClaudeCliConfigImpl = loadClaudeCliConfig,
  checkClaudeCliAvailabilityImpl = checkClaudeCliAvailability,
  loadCodexConfigImpl = loadCodexConfig,
  loadJobPathsConfigImpl = loadJobPathsConfig,
  getProviderImpl = getProvider,
  approveInboxImagesImpl = approveInboxImages,
  insertImageQaReviewImpl = insertImageQaReview,
  loadImageForVisionImpl = loadImageForVision,
  loadRemoteImageForVisionImpl = loadRemoteImageForVision,
  generateMainImageImpl = generateMainImage,
  generateDetailImageSetImpl = generateDetailImageSet,
  runSpeedgoNaverRegistrationImpl = runSpeedgoNaverRegistration,
  loadNaverCommerceConfigImpl = loadNaverCommerceConfig,
} = {}) {
  const { routes } = await listTaskRoutingImpl(db);
  const route = routes.find((r) => r.taskType === TASK_TYPE);
  if (!route || !route.enabled) return { skipped: true, reason: 'TASK_DISABLED' };

  const draft = await getProductDraftImpl(db, draftId);
  if (!draft) return { skipped: true, reason: 'DRAFT_NOT_FOUND' };

  const claudeCliConfig = await loadClaudeCliConfigImpl(rootDir);
  const availability = await checkClaudeCliAvailabilityImpl({ config: claudeCliConfig });
  if (!availability.available || !availability.loggedIn) {
    return { skipped: true, reason: 'CLAUDE_CLI_UNAVAILABLE', message: availability.message };
  }

  const research = await getMarketResearchImpl(db, draftId, 'naver');
  const competitor = extractBestCompetitor(research);
  const provider = getProviderImpl(route.providerCode);

  let lastResult = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const mainImages = await listManualMainImagesImpl(db, draftId);
    const mainImage = mainImages.find((img) => img.status === 'uploaded') || mainImages.find((img) => img.status === 'approved');
    const detailSets = await listManualDetailSetsImpl(db, draftId);
    const detailSet = detailSets.find((s) => s.status === 'uploaded') || detailSets.find((s) => s.status === 'approved');
    if (!mainImage || !detailSet) return { skipped: true, reason: 'IMAGES_NOT_READY' };

    const imageUrls = [mainImage.coupangStoredUrl, ...detailSet.images.map((img) => img.normalizedStoredUrl)];
    const images = await Promise.all(imageUrls.map((url) => loadImageForVisionImpl(rootDir, url)));
    if (competitor?.imageUrl) {
      try {
        images.push(await loadRemoteImageForVisionImpl(competitor.imageUrl));
      } catch {
        // A dead/unreachable competitor thumbnail is not worth failing the
        // whole review over -- just drop the benchmark image, prompt below
        // still reflects whether `competitor` is set for the text portion.
      }
    }
    const prompt = buildPrompt(draft, competitor);

    let result;
    try {
      result = await provider.analyzeImages(
        { ...claudeCliConfig, model: route.model || claudeCliConfig.model },
        { images, prompt },
      );
    } catch (error) {
      await insertImageQaReviewImpl(db, {
        productDraftId: draftId, verdict: 'error',
        issues: [{ severity: 'high', description: error.message }],
        providerCode: route.providerCode, model: route.model,
      });
      return { verdict: 'error', error: error.message, attempt };
    } finally {
      // Only the downloaded competitor thumbnail has a real cleanup -- local
      // generated-image paths never had bytes written to a temp location.
      await Promise.all(images.map((image) => image.cleanup?.()));
    }

    let verdict;
    try {
      verdict = parseVerdict(result.rawText);
    } catch (error) {
      await insertImageQaReviewImpl(db, {
        productDraftId: draftId, verdict: 'error',
        issues: [{ severity: 'high', description: error.message }],
        providerCode: route.providerCode, model: result.model, rawResponse: result,
      });
      return { verdict: 'error', error: error.message, attempt };
    }

    await insertImageQaReviewImpl(db, {
      productDraftId: draftId,
      verdict: verdict.pass ? 'pass' : 'fail',
      issues: verdict.issues,
      providerCode: route.providerCode,
      model: result.model,
      rawResponse: result,
    });

    if (verdict.pass) {
      let approved = true;
      let registrationError = null;
      try {
        await approveInboxImagesImpl(db, rootDir, draftId);
      } catch (error) {
        // approveInboxImages (via handleApprovedImages) already recorded this
        // failure onto processing_queue -- draft 10 on 2026-08-17 hit this
        // live (REGISTRATION_NOT_READY: missing optimized title/options/etc.)
        // and the unhandled rethrow propagated all the way to the scheduler's
        // tick(), firing a critical Telegram alert meant for real infra
        // outages. The failed queue item already surfaces this in the human
        // approval inbox, so report it here instead of throwing.
        approved = false;
        registrationError = error.message;
      }

      // Naver's Speedgo path has a much lower registration bar than Coupang's
      // (no mandatory category-attribute mapping, no certification notice) and
      // already prefers the same approved image set (approvedAiDetailImages)
      // -- so it's always worth attempting, regardless of whether the Coupang
      // attempt above just succeeded or failed, rather than letting a
      // Coupang-blocked product's image-generation spend go to waste.
      // headless:true here (unattended path) -- distinct from the CLI
      // script's interactive headless:false default, which is unchanged.
      let naverOutcome;
      try {
        const naverConfig = await loadNaverCommerceConfigImpl(rootDir);
        const result = await runSpeedgoNaverRegistrationImpl(db, rootDir, draftId, { confirm: true, headless: true, naverConfig });
        naverOutcome = { ok: true, result };
      } catch (error) {
        naverOutcome = { ok: false, error: error.message, code: error.code };
      }

      return { verdict: 'pass', approved, registrationError, naverOutcome, attempt };
    }

    lastResult = { verdict: 'fail', issues: verdict.issues, attempt };
    if (attempt >= maxAttempts) return lastResult;

    const extraInstructions = issuesToExtraInstructions(verdict.issues);
    const [codexConfig, jobPathsConfig] = await Promise.all([loadCodexConfigImpl(rootDir), loadJobPathsConfigImpl(rootDir)]);
    try {
      await generateMainImageImpl(db, rootDir, jobPathsConfig.jobDir, draftId, { codexConfig, extraInstructions });
      const detailPaths = getImageGenerationJobPaths(jobPathsConfig.jobDir, draftId);
      await rm(detailPaths.generatedDetailDir, { recursive: true, force: true });
      await generateDetailImageSetImpl(db, rootDir, jobPathsConfig.jobDir, draftId, { codexConfig, extraInstructions });
    } catch (error) {
      await insertImageQaReviewImpl(db, {
        productDraftId: draftId, verdict: 'error',
        issues: [{ severity: 'high', description: `재생성 실패: ${error.message}` }],
        providerCode: route.providerCode, model: result.model,
      });
      return { verdict: 'error', error: error.message, attempt };
    }
  }
  return lastResult;
}
