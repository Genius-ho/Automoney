#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { Client } from 'pg';

import { loadDatabaseUrl } from '../src/config.mjs';
import { shouldRetainOriginalDetailImage } from '../src/image-retention.mjs';
import { runSchema } from '../src/postgres-store.mjs';
import { buildDetailHtml, cleanProductName } from '../src/processing.mjs';

const options = parseArgs(process.argv.slice(2));
const client = new Client({ connectionString: await loadDatabaseUrl(process.cwd()) });

try {
  await client.connect();
  await runSchema(client);
  const drafts = await selectDrafts(options);
  let success = 0;
  let failed = 0;
  let renderedImages = 0;
  for (const draft of drafts) {
    const cached = await hasSuccessfulCrawl(draft.id);
    if (cached && !options.force) {
      console.log(`draftId=${draft.id} status=skipped_cached`);
      continue;
    }
    const result = await crawlRenderedProductPage(draft, options);
    if (result.status === 'success') success += 1;
    else failed += 1;
    renderedImages += result.detailImageCount || 0;
    console.log(`draftId=${draft.id} status=${result.status} detailImages=${result.detailImageCount || 0}`);
    await delay(options.delayMs);
  }
  console.log(`total=${drafts.length}`);
  console.log(`success=${success}`);
  console.log(`failed=${failed}`);
  console.log(`renderedImages=${renderedImages}`);
} catch (error) {
  console.log(`errorCode=${error.code || error.name || 'ERROR'}`);
  if (String(error.message || '').includes('Executable doesn')) {
    console.log('errorMessage=Playwright browser is not installed. Run: npx playwright install chromium');
  } else {
    console.log(`errorMessage=${error.message}`);
  }
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}

export async function crawlRenderedProductPage(draft, options = {}) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: !options.headful });
  let page;
  try {
    page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
    const response = await page.goto(draft.supplier_product_url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const statusCode = response?.status() || null;
    if (statusCode === 404) return saveCrawlResult(draft, { status: 'not_found', statusCode, errorMessage: 'not_found' });
    if (statusCode && statusCode >= 400) return saveCrawlResult(draft, { status: 'failed', statusCode, errorMessage: `http_${statusCode}` });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    const beforeMorePath = options.debugScreenshot || options.debug ? await saveNamedScreenshot(page, draft.id, 'debug/before-more.png') : null;
    const more = await clickMoreButton(page);
    await slowScroll(page);
    await page.waitForTimeout(1200);
    const afterMorePath = options.debugScreenshot || options.debug ? await saveNamedScreenshot(page, draft.id, 'debug/after-more.png') : null;

    const screenshotPath = options.debugScreenshot ? await saveFullPageScreenshot(page, draft.id) : null;
    const images = await collectRenderedImages(page, { onlyDetail: options.onlyDetail });
    const evaluated = images.map(evaluateCandidate);
    const filtered = dedupeImages(evaluated.filter((image) => image.detectedSection === 'detail' && !image.rejectReason));
    const candidateJsonPath =
      options.debugScreenshot || options.debug ? await saveImageCandidates(draft.id, evaluated, { beforeMorePath, afterMorePath, more }) : null;
    await replaceRenderedImages(draft, filtered);
    await saveCrawlResult(draft, {
      status: 'success',
      statusCode,
      imageCount: images.length,
      detailImageCount: filtered.length,
      screenshotPath,
      rawSummaryJson: {
        collected: images.length,
        filtered: filtered.length,
        candidatesPath: candidateJsonPath,
        more,
        url: draft.supplier_product_url,
      },
    });
    await regenerateDraftHtml(draft.id);
    return { status: 'success', detailImageCount: filtered.length };
  } catch (error) {
    const status = /timeout/i.test(error.message || '') ? 'timeout' : classifyAccessError(error);
    await saveCrawlResult(draft, { status, errorMessage: error.message });
    return { status, detailImageCount: 0 };
  } finally {
    await page?.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function clickMoreButton(page) {
  const beforeHeight = await page.evaluate(() => document.body.scrollHeight).catch(() => 0);
  const moreTexts = ['더보기', '상품정보 더보기', '상세정보 더보기', '상세페이지 더보기', '펼쳐보기', '상품상세 더보기', '내용 더보기', 'more', 'view more'];
  try {
    const locators = page.locator('button, a, div[role="button"]');
    const count = await locators.count();
    for (let i = 0; i < count; i += 1) {
      const item = locators.nth(i);
      if (!(await item.isVisible().catch(() => false))) continue;
      const text = String(await item.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      if (!text) continue;
      if (moreTexts.some((candidate) => text.toLowerCase().includes(candidate.toLowerCase()))) {
        await item.click({ timeout: 3000 }).catch((error) => {
          throw new Error(`more_button_click_failed:${error.message}`);
        });
        await page.waitForTimeout(1500);
        await page.evaluate(() => window.scrollBy(0, Math.floor(window.innerHeight * 0.5))).catch(() => {});
        await page.waitForTimeout(700);
        const afterHeight = await page.evaluate(() => document.body.scrollHeight).catch(() => beforeHeight);
        return { status: 'clicked', text, beforeHeight, afterHeight, increased: afterHeight > beforeHeight };
      }
    }
    return { status: 'more_button_not_found', beforeHeight, afterHeight: beforeHeight, increased: false };
  } catch (error) {
    const afterHeight = await page.evaluate(() => document.body.scrollHeight).catch(() => beforeHeight);
    return { status: 'more_button_click_failed', beforeHeight, afterHeight, increased: afterHeight > beforeHeight, error: error.message };
  }
}

async function collectRenderedImages(page, { onlyDetail = false } = {}) {
  const frames = page.frames();
  const results = [];
  for (const frame of frames) {
    const frameResults = await frame.evaluate(({ onlyDetail }) => {
      const detailSelectors = [
        '#detail',
        '#itemDetail',
        '#productDetail',
        '#product_detail',
        '#goodsDetail',
        '#goods_detail',
        '#contents',
        '#content',
        '.detail',
        '.item-detail',
        '.product-detail',
        '.goods-detail',
        '.goods_view',
        '.view_detail',
        '.detail_view',
        '.prd-detail',
        '.product-description',
        '.description',
      ];
      const negativeWords = /(ad|ads|banner|recommend|related|best|event|promotion|coupon|logo|icon|btn|button|footer|header|nav|quick|floating|wing|aside|seller|shop|review|qna|category|광고|추천|관련|이벤트|베스트|리뷰|문의)/i;
      const out = [];
      const detailRoot = findDetailRoot();
      const rootRect = detailRoot?.getBoundingClientRect() || document.body.getBoundingClientRect();
      const roots = onlyDetail && detailRoot ? [detailRoot] : [detailRoot || document.body];
      function absolute(value) {
        try {
          return value ? new URL(value, location.href).href : '';
        } catch {
          return '';
        }
      }
      function selectorFor(element) {
        if (!element) return '';
        if (element.id) return `#${element.id}`;
        const cls = String(element.className || '').trim().split(/\s+/).filter(Boolean).slice(0, 3).join('.');
        return `${element.tagName.toLowerCase()}${cls ? `.${cls}` : ''}`;
      }
      function textFor(element) {
        return `${element?.id || ''} ${element?.className || ''} ${element?.getAttribute?.('alt') || ''} ${element?.innerText || ''}`.slice(0, 1000);
      }
      function findDetailRoot() {
        const candidates = [];
        for (const selector of detailSelectors) {
          for (const el of document.querySelectorAll(selector)) {
            const rect = el.getBoundingClientRect();
            const images = el.querySelectorAll('img, source').length;
            const height = Math.max(rect.height, el.scrollHeight || 0);
            const width = Math.max(rect.width, el.scrollWidth || 0);
            const neg = negativeWords.test(textFor(el)) ? 1 : 0;
            const score = images * 8 + Math.min(height / 100, 80) + Math.min(width / 100, 20) + (rect.top > 150 ? 10 : 0) - neg * 80;
            if (images > 0 || height > 600) candidates.push({ el, score });
          }
        }
        for (const el of document.querySelectorAll('div, section, article, td, iframe, body')) {
          const rect = el.getBoundingClientRect();
          const images = el.querySelectorAll('img, source').length;
          const height = Math.max(rect.height, el.scrollHeight || 0);
          const width = Math.max(rect.width, el.scrollWidth || 0);
          const neg = negativeWords.test(textFor(el)) ? 1 : 0;
          if (images < 2 && height < 800) continue;
          if (width < 400) continue;
          const score = images * 6 + Math.min(height / 120, 70) + Math.min(width / 100, 20) + (rect.top > 250 ? 20 : 0) - neg * 90;
          candidates.push({ el, score });
        }
        candidates.sort((a, b) => b.score - a.score);
        return candidates[0]?.el || null;
      }
      function sectionFor(element, parent) {
        const haystack = `${selectorFor(element)} ${selectorFor(parent)} ${textFor(parent)} ${absolute(element.currentSrc || element.src || '')}`.toLowerCase();
        if (/(header|nav|logo|gnb|lnb)/.test(haystack)) return 'header';
        if (/(footer)/.test(haystack)) return 'footer';
        if (/(recommend|related|best|seller|shop|review|qna|category|추천|관련|베스트|리뷰|문의)/.test(haystack)) return 'recommendation';
        if (/(ad|ads|banner|event|promotion|coupon|quick|floating|wing|aside|광고|배너|이벤트|쿠폰)/.test(haystack)) return 'ad';
        return detailRoot && detailRoot.contains(element) ? 'detail' : 'unknown';
      }
      function add(element, src, sourceKind, index) {
        const rect = element.getBoundingClientRect();
        const parent = element.closest('section, article, div, td, body');
        const inDetail = !!detailRoot && detailRoot.contains(element);
        const detectedSection = sectionFor(element, parent);
        out.push({
          src: absolute(src),
          currentSrc: absolute(element.currentSrc || ''),
          dataSrc: absolute(element.getAttribute('data-src') || element.getAttribute('data-original') || ''),
          srcset: element.getAttribute('srcset') || '',
          alt: element.getAttribute('alt') || '',
          className: String(element.className || ''),
          id: element.id || '',
          naturalWidth: Number(element.naturalWidth || 0),
          naturalHeight: Number(element.naturalHeight || 0),
          rendered_x: rect.x,
          rendered_y: rect.y,
          rendered_width: rect.width,
          rendered_height: rect.height,
          renderedX: rect.x,
          renderedY: rect.y,
          renderedWidth: rect.width,
          renderedHeight: rect.height,
          isInsideDetailContainer: inDetail && rect.bottom >= rootRect.top && rect.top <= rootRect.bottom,
          detectedSection,
          parentSelector: selectorFor(parent),
          closestSectionSelector: selectorFor(element.closest('section, article, main, div, body')),
          domSelector: selectorFor(parent),
          sourceKind,
          domIndex: index,
          frameUrl: location.href,
          frameName: window.name || '',
          detailContainerSelector: selectorFor(detailRoot),
        });
      }
      roots.forEach((root) => {
        [...root.querySelectorAll('img')].forEach((img, index) => {
          add(img, img.currentSrc || img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-original'), 'img', index);
        });
        [...root.querySelectorAll('source')].forEach((source, index) => {
          const srcset = source.getAttribute('srcset') || '';
          const first = srcset.split(',')[0]?.trim().split(/\s+/)[0];
          if (first) add(source, first, 'source', index);
        });
        [...root.querySelectorAll('*')].forEach((el, index) => {
          const bg = getComputedStyle(el).backgroundImage || '';
          const match = bg.match(/url\(["']?([^"')]+)["']?\)/);
          if (match) add(el, match[1], 'background', index);
        });
      });
      return out;
    }, { onlyDetail }).catch(() => []);
    results.push(...frameResults);
  }
  return results;
}

function evaluateCandidate(image) {
  const url = image.currentSrc || image.src || image.dataSrc;
  let rejectReason = '';
  if (!url || !/^https?:\/\//i.test(url)) rejectReason = 'missing_url';
  const lower = url.toLowerCase();
  const meta = `${lower} ${image.className || ''} ${image.id || ''} ${image.alt || ''} ${image.parentSelector || ''}`.toLowerCase();
  if (!rejectReason && /(icon|logo|badge|btn|button|spacer|blank|sprite|loading|header|footer|nav|quick|floating|wing|aside|seller|shop|review|qna|category|recommend|related|best|event|promotion|coupon|banner|ad)/.test(meta)) rejectReason = 'excluded_keyword';
  if (!rejectReason && (Number(image.renderedWidth || 0) < 200 || Number(image.renderedHeight || 0) < 200)) rejectReason = 'rendered_too_small';
  if (!rejectReason && Number(image.naturalWidth || 0) > 0 && Number(image.naturalWidth || 0) < 200) rejectReason = 'natural_width_too_small';
  if (!rejectReason && Number(image.naturalHeight || 0) > 0 && Number(image.naturalHeight || 0) < 200) rejectReason = 'natural_height_too_small';
  if (!rejectReason && image.detectedSection !== 'detail') rejectReason = `not_detail_section:${image.detectedSection || 'unknown'}`;
  return { ...image, url, rejectReason };
}

function dedupeImages(images) {
  const seen = new Set();
  const result = [];
  for (const image of images) {
    const url = image.currentSrc || image.src || image.dataSrc;
    const key = normalizeImageKey(url);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...image, url });
  }
  return result;
}

async function replaceRenderedImages(draft, images) {
  const retained = await client.query(
    `
      select id, content_hash
      from product_images
      where product_draft_id = $1
        and source_method in ($2, $3)
        and is_long_image = true
        and image_type in ('detail_source_full', 'detail_full')
    `,
    [draft.id, 'rendered_dom', 'element_screenshot'],
  );
  const retainedByHash = new Map(retained.rows.filter((image) => image.content_hash).map((image) => [image.content_hash, image.id]));
  await client.query(
    `
      delete from product_images
      where product_draft_id = $1
        and source_method in ($2, $3)
        and not (is_long_image = true and image_type in ('detail_source_full', 'detail_full'))
    `,
    [
    draft.id,
    'rendered_dom',
    'element_screenshot',
    ],
  );
  const next = await nextImageIndex(draft.id);
  for (const [index, image] of images.entries()) {
    const url = image.url;
    const hash = hashText(url);
    const width = Number(image.naturalWidth || image.renderedWidth || 0) || null;
    const height = Number(image.naturalHeight || image.renderedHeight || 0) || null;
    const aspectRatio = width && height ? height / width : null;
    const isLongImage = Boolean(
      image.detectedSection === 'detail' &&
        width &&
        height &&
        (height / width >= 4 || height >= 3000),
    );
    const imageType = isLongImage ? 'detail_source_full' : 'detail';
    const selectedForDetail = !isLongImage;
    const retainedId = shouldRetainOriginalDetailImage({ imageType, isLongImage }) ? retainedByHash.get(hash) : null;
    if (retainedId) {
      await client.query(
        `
          update product_images
          set url = $2,
              original_url = $2,
              stored_url = $2,
              source_page_url = $3,
              dom_selector = $4,
              dom_index = $5,
              rendered_x = $6,
              rendered_y = $7,
              rendered_width = $8,
              rendered_height = $9,
              natural_width = $10,
              natural_height = $11,
              crawl_status = 'success',
              selected_for_detail = false,
              quality_status = 'usable',
              source_section = 'detail',
              reject_reason = null,
              width = $12,
              height = $13,
              aspect_ratio = $14,
              is_long_image = true
          where id = $1
        `,
        [
          retainedId,
          url,
          draft.supplier_product_url,
          image.domSelector || null,
          image.domIndex ?? index,
          image.renderedX ?? null,
          image.renderedY ?? null,
          image.renderedWidth ?? null,
          image.renderedHeight ?? null,
          image.naturalWidth || null,
          image.naturalHeight || null,
          width,
          height,
          aspectRatio,
        ],
      );
      continue;
    }
    await client.query(
      `
        insert into product_images (
          product_draft_id, supplier_product_no, image_index, url, image_type, sort_order,
          original_url, stored_url, source_method, source_page_url, dom_selector, dom_index,
          rendered_x, rendered_y, rendered_width, rendered_height,
          natural_width, natural_height, content_hash, crawl_status, selected_for_detail, quality_status,
          source_section, reject_reason, width, height, aspect_ratio, is_long_image
        )
        values ($1,$2,$3,$4,$5,$6,$4,$4,'rendered_dom',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'success',$17,'usable','detail',null,$18,$19,$20,$21)
      `,
      [
        draft.id,
        draft.supplier_product_no,
        next + index,
        url,
        imageType,
        200 + index,
        draft.supplier_product_url,
        image.domSelector || null,
        image.domIndex ?? index,
        image.renderedX ?? null,
        image.renderedY ?? null,
        image.renderedWidth ?? null,
        image.renderedHeight ?? null,
        image.naturalWidth || null,
        image.naturalHeight || null,
        hash,
        selectedForDetail,
        width,
        height,
        aspectRatio,
        isLongImage,
      ],
    );
  }
}

async function saveFullPageScreenshot(page, draftId) {
  const dir = join(process.cwd(), 'public', 'generated-images', 'drafts', String(draftId), 'rendered');
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, 'full-page.jpg');
  await page.screenshot({ path: filePath, fullPage: true, type: 'jpeg', quality: 80 });
  return `/generated-images/drafts/${draftId}/rendered/full-page.jpg`;
}

async function saveNamedScreenshot(page, draftId, relativeName) {
  const dir = join(process.cwd(), 'public', 'generated-images', 'drafts', String(draftId));
  const filePath = join(dir, relativeName);
  await mkdir(dirname(filePath), { recursive: true });
  await page.screenshot({ path: filePath, fullPage: true });
  return `/generated-images/drafts/${draftId}/${relativeName.replaceAll('\\', '/')}`;
}

async function saveImageCandidates(draftId, candidates, meta) {
  const dir = join(process.cwd(), 'public', 'generated-images', 'drafts', String(draftId), 'debug');
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, 'image-candidates.json');
  await writeFile(
    filePath,
    JSON.stringify(
      {
        ...meta,
        candidates: candidates.map((candidate) => ({
          src: candidate.src,
          currentSrc: candidate.currentSrc,
          alt: candidate.alt,
          className: candidate.className,
          id: candidate.id,
          parentSelector: candidate.parentSelector,
          closestSectionSelector: candidate.closestSectionSelector,
          rendered_x: candidate.rendered_x,
          rendered_y: candidate.rendered_y,
          rendered_width: candidate.rendered_width,
          rendered_height: candidate.rendered_height,
          natural_width: candidate.naturalWidth,
          natural_height: candidate.naturalHeight,
          isInsideDetailContainer: candidate.isInsideDetailContainer,
          detectedSection: candidate.detectedSection || 'unknown',
          rejectReason: candidate.rejectReason || null,
          frameUrl: candidate.frameUrl,
          frameName: candidate.frameName,
          detailContainerSelector: candidate.detailContainerSelector,
        })),
      },
      null,
      2,
    ),
    'utf8',
  );
  return `/generated-images/drafts/${draftId}/debug/image-candidates.json`;
}

async function saveCrawlResult(draft, result) {
  await client.query(
    `
      insert into supplier_page_crawl_results (
        product_draft_id, supplier_product_url, status, status_code, image_count,
        detail_image_count, screenshot_path, error_message, crawled_at, raw_summary_json
      )
      values ($1,$2,$3,$4,$5,$6,$7,$8,now(),$9::jsonb)
    `,
    [
      draft.id,
      draft.supplier_product_url,
      result.status,
      result.statusCode || null,
      result.imageCount || 0,
      result.detailImageCount || 0,
      result.screenshotPath || null,
      result.errorMessage ? String(result.errorMessage).slice(0, 500) : null,
      JSON.stringify(result.rawSummaryJson || {}),
    ],
  );
}

async function regenerateDraftHtml(draftId) {
  const draftResult = await client.query('select * from product_drafts where id = $1', [draftId]);
  const draft = draftResult.rows[0];
  if (!draft) return;
  const canReplace = !String(draft.generated_detail_html || '').trim();
  if (!canReplace) return;
  const images = await client.query(
    `
      select *
      from product_images
      where product_draft_id = $1
      order by
        case
          when selected_for_detail then 0
          when image_type = 'regenerated_detail_asset' then 1
          when source_method = 'rendered_dom' then 1
          when source_method = 'element_screenshot' then 2
          when source_method in ('api', 'static_html') then 3
          when image_type in ('detail_source_full', 'detail_full') then 4
          when source_method = 'long_slice' then 5
          else 9
        end,
        coalesce(sort_order, image_index),
        coalesce(slice_index, 0)
    `,
    [draftId],
  );
  const hasRendered = images.rows.some((image) => image.source_method === 'rendered_dom');
  const imageEntries = images.rows
    .filter((image) => image.image_type === 'main' || image.source_section === 'detail' || image.source_section == null)
    .filter((image) => !(hasRendered && image.source_method === 'long_slice'))
    .slice(0, 12)
    .map((image) => ({
      url: image.stored_url || image.url,
      storedUrl: image.stored_url || image.url,
      imageType: image.image_type,
      sourceMethod: image.source_method,
      sourceSection: image.source_section,
      selectedForDetail: image.selected_for_detail,
      sortOrder: image.sort_order,
      sliceIndex: image.slice_index,
      isLongImage: image.is_long_image,
    }));
  const html = buildDetailHtml({
    name: draft.selling_title || cleanProductName(draft.cleaned_name || draft.raw_name),
    images: imageEntries.map((image) => image.storedUrl || image.url),
    imageEntries,
    cost: draft.cost,
    shippingFee: draft.shipping_fee,
    minOrderQty: draft.min_order_qty,
  });
  await client.query('update product_drafts set draft_html = $2, generated_detail_html = $2, updated_at = now() where id = $1', [
    draftId,
    html,
  ]);
}

async function selectDrafts(options) {
  if (options.draftId) {
    const result = await client.query(
      'select id, supplier_product_no, supplier_product_url from product_drafts where id = $1',
      [options.draftId],
    );
    return result.rows;
  }
  if (!options.finalCandidates) throw new Error('Use --draft-id or --final-candidates.');
  const limit = options.limit || 5;
  const result = await client.query(
    `
      select d.id, d.supplier_product_no, d.supplier_product_url
      from product_drafts d
      left join market_research_results nmr on nmr.product_draft_id = d.id and nmr.marketplace = 'naver'
      join supplier_products sp on sp.id = d.supplier_product_id
      where d.supplier_product_url is not null
        and d.status <> 'blocked'
        and jsonb_array_length(coalesce(d.block_reasons, '[]'::jsonb)) = 0
      order by
        case when nmr.winner_status = 'candidate' and coalesce(d.naver_expected_profit,0) >= 3000 then 0 else 1 end,
        nmr.winner_score desc nulls last,
        d.id desc
      limit $1
    `,
    [limit],
  );
  return result.rows;
}

async function hasSuccessfulCrawl(draftId) {
  const result = await client.query(
    "select id from supplier_page_crawl_results where product_draft_id = $1 and status = 'success' order by crawled_at desc limit 1",
    [draftId],
  );
  return result.rows.length > 0;
}

async function nextImageIndex(draftId) {
  const result = await client.query(
    'select coalesce(max(image_index), -1)::int + 1 as next_index from product_images where product_draft_id = $1',
    [draftId],
  );
  return result.rows[0]?.next_index || 0;
}

async function slowScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let y = 0;
      const step = Math.max(500, Math.floor(window.innerHeight * 0.75));
      const timer = setInterval(() => {
        y += step;
        window.scrollTo(0, y);
        if (y >= document.body.scrollHeight - window.innerHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 350);
    });
  });
}

function classifyAccessError(error) {
  const message = String(error.message || '').toLowerCase();
  if (message.includes('login')) return 'login_required';
  if (message.includes('captcha') || message.includes('blocked')) return 'blocked';
  return 'failed';
}

function normalizeImageKey(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.toLowerCase()}${parsed.pathname.toLowerCase()}`;
  } catch {
    return String(url || '').split(/[?#]/)[0].toLowerCase();
  }
}

function hashText(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

function parseArgs(args) {
  return {
    draftId: numberArg(args, '--draft-id'),
    finalCandidates: args.includes('--final-candidates'),
    limit: numberArg(args, '--limit') || 5,
    force: args.includes('--force'),
    headful: args.includes('--headful'),
    debug: args.includes('--debug'),
    debugScreenshot: args.includes('--debug-screenshot'),
    onlyDetail: args.includes('--only-detail'),
    delayMs: numberArg(args, '--delay-ms') || 1500,
  };
}

function numberArg(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = Number(args[index + 1]);
  return Number.isFinite(value) ? value : null;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
