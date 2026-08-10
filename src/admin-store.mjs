import { calculateWinnerScore } from './winner-score.mjs';
import { buildRegistrationOptimization } from './registration-optimization.mjs';
import { buildDetailHtml, cleanProductName } from './processing.mjs';
import { renderImagePrompt } from './image-prompt-templates.mjs';
import { createHash } from 'node:crypto';
import { computeImagePromptState } from './image-prompt-state.mjs';
import { getDetailPageSections } from './manual-ai/detail-sections.mjs';
import { getApprovedManualMainImage, listManualMainImages } from './manual-ai/workflow-store.mjs';
import { getApprovedManualDetailSet, listManualDetailSets } from './manual-ai/detail-workflow-store.mjs';

const VALID_STATUSES = new Set(['draft', 'needs_review', 'blocked', 'approved']);
const VALID_MARKETPLACES = new Set(['coupang', 'naver']);
const VALID_FINAL_DECISIONS = new Set(['등록후보', '검수필요', '제외']);
const FINAL_DECISION_SQL = `
  case
    when d.status = 'blocked' then '제외'
    when jsonb_array_length(coalesce(d.block_reasons, '[]'::jsonb)) > 0 then '제외'
    when coalesce(d.min_order_qty, 1) >= 5 then '제외'
    when nmr.winner_status = 'reject' then '제외'
    when sp.source_market = 'domeggook' then '검수필요'
    when coalesce(sp.source_market, 'unknown') = 'unknown' then '검수필요'
    when coalesce(d.order_unit, 1) > 1 then '검수필요'
    when nmr.winner_status = 'candidate' and coalesce(d.naver_expected_profit, 0) >= 3000 then '등록후보'
    when nmr.winner_status = 'needs_review' then '검수필요'
    when nmr.winner_status is null then '검수필요'
    else '검수필요'
  end
`;

export async function listProductDrafts(db, { status, importBatchId, collectedOnly, naverWinnerStatus, finalDecision, limit } = {}) {
  const params = [];
  const where = [];
  if (status) {
    if (!VALID_STATUSES.has(status)) throw new Error(`Invalid status: ${status}`);
    params.push(status);
    where.push(`d.status = $${params.length}`);
  }
  if (importBatchId) {
    params.push(importBatchId);
    where.push(`d.import_batch_id = $${params.length}`);
  }
  if (collectedOnly) {
    where.push('d.collected_at is not null');
  }
  if (naverWinnerStatus) {
    params.push(naverWinnerStatus);
    where.push(`nmr.winner_status = $${params.length}`);
  }
  if (finalDecision) {
    if (!VALID_FINAL_DECISIONS.has(finalDecision)) throw new Error(`Invalid finalDecision: ${finalDecision}`);
    params.push(finalDecision);
    where.push(`${FINAL_DECISION_SQL} = $${params.length}`);
  }
  let parsedLimit = null;
  if (limit !== undefined && limit !== null) {
    parsedLimit = Number(limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit <= 0) throw new Error(`Invalid limit: ${limit}`);
  }

  const result = await db.query(
    `
      select
        d.id,
        d.supplier_product_no,
        d.raw_name,
        d.cleaned_name,
        d.selling_title,
        d.cost,
        d.shipping_fee,
        d.min_order_qty,
        d.order_unit,
        d.supplier_product_url,
        d.sell_unit_type,
        d.bundle_quantity,
        d.unit_cost_price,
        d.bundle_cost_price,
        d.bundle_reason,
        d.coupang_sale_price,
        d.coupang_expected_profit,
        d.coupang_margin_rate,
        d.naver_sale_price,
        d.naver_expected_profit,
        d.naver_margin_rate,
        d.filter_status,
        d.block_reasons,
        d.review_reasons,
        d.status,
        d.import_batch_id,
        d.collected_at,
        d.updated_at,
        coalesce(img.main_images, 0)::int as main_images,
        coalesce(img.detail_images, 0)::int as detail_images,
        coalesce(img.total_images, 0)::int as total_images,
        cmr.lowest_price as coupang_lowest_price,
        cmr.price_gap_rate as coupang_price_gap_rate,
        cmr.rocket_exists as coupang_rocket_exists,
        cmr.max_review_count as coupang_max_review_count,
        cmr.competitor_count as coupang_competitor_count,
        cmr.winner_score as coupang_winner_score,
        cmr.winner_status as coupang_winner_status,
        nmr.lowest_price as naver_lowest_price,
        nmr.price_gap_rate as naver_price_gap_rate,
        nmr.competitor_count as naver_competitor_count,
        nmr.winner_score as naver_winner_score,
        nmr.winner_status as naver_winner_status,
        ${FINAL_DECISION_SQL} as final_decision,
        sp.source_market,
        sp.raw_json #>> '{domeggook,basis,title}' as domeggook_title,
        sp.raw_json ->> 'productName' as product_name
      from product_drafts d
      join supplier_products sp on sp.id = d.supplier_product_id
      left join lateral (
        select
          count(*) filter (where image_type = 'main') as main_images,
          count(*) filter (where source_section = 'detail' and image_type <> 'main') as detail_images,
          count(*) as total_images
        from product_images pi
        where pi.product_draft_id = d.id
      ) img on true
      left join market_research_results cmr on cmr.product_draft_id = d.id and cmr.marketplace = 'coupang'
      left join market_research_results nmr on nmr.product_draft_id = d.id and nmr.marketplace = 'naver'
      ${where.length ? `where ${where.join(' and ')}` : ''}
      order by
        case ${FINAL_DECISION_SQL} when '등록후보' then 0 when '검수필요' then 1 else 2 end,
        nmr.winner_score desc nulls last,
        nmr.price_gap_rate asc nulls last,
        d.naver_expected_profit desc nulls last,
        d.updated_at desc,
        d.id desc
      ${parsedLimit ? `limit $${params.push(parsedLimit)}` : ''}
    `,
    params,
  );

  return result.rows.map(toDraftListItem);
}

export async function getProductDraft(db, id) {
  const draftResult = await db.query(
    `
      select
        d.*,
        coalesce(img.main_images, 0)::int as main_images,
        coalesce(img.detail_images, 0)::int as detail_images,
        coalesce(img.total_images, 0)::int as total_images,
        sp.source_market,
        sp.raw_json,
        sp.original_detail_html,
        sp.raw_json #>> '{domeggook,basis,title}' as domeggook_title,
        sp.raw_json ->> 'productName' as product_name
      from product_drafts d
      join supplier_products sp on sp.id = d.supplier_product_id
      left join lateral (
        select
          count(*) filter (where image_type = 'main') as main_images,
          count(*) filter (where source_section = 'detail' and image_type <> 'main') as detail_images,
          count(*) as total_images
        from product_images pi
        where pi.product_draft_id = d.id
      ) img on true
      where d.id = $1
    `,
    [id],
  );
  if (draftResult.rows.length === 0) return null;

  const [images, options] = await Promise.all([
    db.query(
      `
        select
          id, image_index, url, image_type, sort_order, original_url, stored_url,
          width, height, aspect_ratio, is_long_image, parent_image_id, slice_index,
          source_method, source_page_url, dom_selector, dom_index,
          rendered_x, rendered_y, rendered_width, rendered_height,
          natural_width, natural_height, content_hash, crawl_status, crawl_error,
          selected_for_detail, quality_status, source_section, reject_reason
        from product_images
        where product_draft_id = $1
        order by coalesce(sort_order, image_index), coalesce(slice_index, 0), image_index
      `,
      [id],
    ),
    db.query(
      `
        select id, option_index, name, value, additional_price, stock_quantity, option_code, raw_json
        from product_options
        where product_draft_id = $1
        order by option_index
      `,
      [id],
    ),
  ]);

  return toDraftDetail(draftResult.rows[0], images.rows, options.rows);
}

export async function updateProductDraft(db, id, patch) {
  if (patch.status === 'approved') {
    await assertApprovalAllowed(db, id, patch.overrideReason);
  }

  const fields = [];
  const params = [];
  addPatch(fields, params, patch, 'sellingTitle', 'selling_title');
  const hasOptimizedTitlePatch = Object.hasOwn(patch, 'optimizedCoupangTitle') || Object.hasOwn(patch, 'optimizedNaverTitle');
  addPatch(fields, params, patch, 'optimizedCoupangTitle', 'optimized_coupang_title');
  addPatch(fields, params, patch, 'optimizedNaverTitle', 'optimized_naver_title');
  if (hasOptimizedTitlePatch) fields.push('title_generated_at = now()');
  addPatch(fields, params, patch, 'coupangSalePrice', 'coupang_sale_price', toIntegerOrNull);
  addPatch(fields, params, patch, 'naverSalePrice', 'naver_sale_price', toIntegerOrNull);
  addPatch(fields, params, patch, 'generatedDetailHtml', 'generated_detail_html');
  addPatch(fields, params, patch, 'reviewMemo', 'review_memo');
  if (Object.hasOwn(patch, 'status')) {
    if (!VALID_STATUSES.has(patch.status)) throw new Error(`Invalid status: ${patch.status}`);
    params.push(patch.status);
    fields.push(`status = $${params.length}`);
  }
  if (fields.length === 0) return getProductDraft(db, id);

  params.push(id);
  const result = await db.query(
    `
      update product_drafts
      set ${fields.join(', ')}, updated_at = now()
      where id = $${params.length}
      returning id
    `,
    params,
  );
  if (result.rows.length === 0) return null;
  return getProductDraft(db, id);
}

export async function setProductDraftStatus(db, id, status) {
  if (!VALID_STATUSES.has(status)) throw new Error(`Invalid status: ${status}`);
  return updateProductDraft(db, id, { status });
}

export function shouldCreateGeneratedDetailHtml(value) {
  return !String(value || '').trim();
}

export function shouldOverwriteOptimizedTitles(coupangTitle, naverTitle, explicitRegeneration = false) {
  return explicitRegeneration || (!String(coupangTitle || '').trim() && !String(naverTitle || '').trim());
}

export function buildGeneratedDetailHtmlV2(draft, { includeOriginalDetailImages = true } = {}) {
  const images = (draft.images || [])
    .filter((image) => includeOriginalDetailImages || !['detail_source_full', 'detail_full'].includes(image.imageType))
    .map((image) => ({
      ...image,
      url: image.storedUrl || image.originalUrl || image.url,
      storedUrl: image.storedUrl || null,
    }));
  return buildDetailHtml({
    name: cleanGeneratedDetailTitle(draft.sellingTitle || draft.cleanedName || draft.rawName || draft.originalProductName || ''),
    categoryText: draft.categoryText || '',
    cost: draft.cost,
    shippingFee: draft.shippingFee,
    minOrderQty: draft.minOrderQty,
    sellUnitType: draft.sellUnitType,
    bundleQuantity: draft.bundleQuantity,
    unitCostPrice: draft.unitCostPrice,
    bundleCostPrice: draft.bundleCostPrice,
    rawPriceFieldName: draft.rawPriceFieldName,
    rawPriceValue: draft.rawPriceValue,
    shippingRawFieldName: draft.shippingRawFieldName,
    shippingRawValue: draft.shippingRawValue,
    imageEntries: images,
    options: draft.options || [],
  });
}

export async function regenerateGeneratedDetailHtml(db, id, { includeOriginalDetailImages = true } = {}) {
  const draft = await getProductDraft(db, id);
  if (!draft) return null;
  const html = buildGeneratedDetailHtmlV2(draft, { includeOriginalDetailImages });
  await db.query(
    'update product_drafts set generated_detail_html = $2, updated_at = now() where id = $1',
    [id, html],
  );
  return getProductDraft(db, id);
}

export async function generateRegistrationOptimization(db, id, { overwriteTitles = false } = {}) {
  const draft = await getProductDraft(db, id);
  if (!draft) return null;
  const naverResearch = await getMarketResearch(db, id, 'naver');
  const optimization = buildRegistrationOptimization({ draft, naverResearch });
  await saveRegistrationOptimization(db, id, optimization, {
    createGeneratedDetailHtml: shouldCreateGeneratedDetailHtml(draft.generatedDetailHtml),
    overwriteTitles: shouldOverwriteOptimizedTitles(
      draft.optimizedCoupangTitle,
      draft.optimizedNaverTitle,
      overwriteTitles,
    ),
  });
  return getRegistrationOptimization(db, id);
}

export async function analyzeSeoKeywords(db, id) {
  return generateRegistrationOptimization(db, id, { overwriteTitles: false });
}

export async function regenerateOptimizedTitles(db, id) {
  return generateRegistrationOptimization(db, id, { overwriteTitles: true });
}

function cleanGeneratedDetailTitle(value) {
  return cleanProductName(value)
    .replace(/\[(?:GS마켓|싸더라|신상꿀템)\]/gi, ' ')
    .replace(/(?:당일출고|특가|인기|추천|도매|대량)/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export async function getRegistrationOptimization(db, id) {
  const [seo, category, notice, shipping] = await Promise.all([
    db.query('select * from seo_keyword_analysis where product_draft_id = $1 order by marketplace', [id]),
    db.query('select * from category_mapping where product_draft_id = $1', [id]),
    db.query('select * from product_notice_info where product_draft_id = $1 order by marketplace', [id]),
    db.query('select * from product_shipping_policies where product_draft_id = $1 order by marketplace', [id]),
  ]);
  const draft = await getProductDraft(db, id);
  if (!draft) return null;
  return {
    seo: seo.rows.map(toSeoAnalysis),
    titles: {
      optimizedCoupangTitle: draft.optimizedCoupangTitle,
      optimizedNaverTitle: draft.optimizedNaverTitle,
      titleKeywords: draft.titleKeywords || [],
      titleWarnings: draft.titleWarnings || [],
      titleGeneratedAt: draft.titleGeneratedAt,
    },
    imagePrompts: {
      heroImagePrompt: draft.heroImagePrompt,
      detailBannerPrompt: draft.detailBannerPrompt,
      usageScenePrompt: draft.usageScenePrompt,
      specCardPrompt: draft.specCardPrompt,
    },
    category: category.rows[0] ? toCategoryMapping(category.rows[0]) : null,
    notice: notice.rows.map(toNoticeInfo),
    shippingPolicies: shipping.rows.map(toShippingPolicy),
  };
}

export async function getRegistrationChecklist(db, id) {
  const result = await db.query('select * from product_registration_checks where product_draft_id = $1', [id]);
  return result.rows[0] ? toRegistrationChecklist(result.rows[0]) : defaultRegistrationChecklist(id);
}

export async function updateRegistrationChecklist(db, id, patch) {
  const value = {
    supplierLinkChecked: toBoolean(patch.supplierLinkChecked),
    naverLowestSameItemChecked: toBoolean(patch.naverLowestSameItemChecked),
    titleChecked: toBoolean(patch.titleChecked),
    detailChecked: toBoolean(patch.detailChecked),
    categoryChecked: toBoolean(patch.categoryChecked),
    noticeChecked: toBoolean(patch.noticeChecked),
    shippingPolicyChecked: toBoolean(patch.shippingPolicyChecked),
    exportJsonChecked: toBoolean(patch.exportJsonChecked),
    overrideReason: patch.overrideReason ? String(patch.overrideReason) : null,
  };
  const result = await db.query(
    `
      insert into product_registration_checks (
        product_draft_id,
        supplier_link_checked,
        naver_lowest_same_item_checked,
        title_checked,
        detail_checked,
        category_checked,
        notice_checked,
        shipping_policy_checked,
        export_json_checked,
        override_reason,
        updated_at
      )
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
      on conflict (product_draft_id) do update set
        supplier_link_checked = excluded.supplier_link_checked,
        naver_lowest_same_item_checked = excluded.naver_lowest_same_item_checked,
        title_checked = excluded.title_checked,
        detail_checked = excluded.detail_checked,
        category_checked = excluded.category_checked,
        notice_checked = excluded.notice_checked,
        shipping_policy_checked = excluded.shipping_policy_checked,
        export_json_checked = excluded.export_json_checked,
        override_reason = excluded.override_reason,
        updated_at = now()
      returning *
    `,
    [
      id,
      value.supplierLinkChecked,
      value.naverLowestSameItemChecked,
      value.titleChecked,
      value.detailChecked,
      value.categoryChecked,
      value.noticeChecked,
      value.shippingPolicyChecked,
      value.exportJsonChecked,
      value.overrideReason,
    ],
  );
  if (value.categoryChecked) {
    await db.query(
      'update category_mapping set confirmed_by_user = true, updated_at = now() where product_draft_id = $1',
      [id],
    );
  }
  if (value.shippingPolicyChecked) {
    await db.query(
      "update product_shipping_policies set status = 'confirmed', updated_at = now() where product_draft_id = $1",
      [id],
    );
  }
  return toRegistrationChecklist(result.rows[0]);
}

async function saveRegistrationOptimization(db, id, optimization, { createGeneratedDetailHtml, overwriteTitles }) {
  await db.query(
    `
      insert into seo_keyword_analysis (
        product_draft_id, marketplace, base_keyword, extracted_keywords, generated_keywords, selected_keywords,
        forbidden_keywords, naver_total_results, naver_lowest_price, naver_top_titles,
        datalab_score, datalab_trend_direction, reasons, keyword_scores, removed_supplier_labels, updated_at
      )
      values ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9, $10::jsonb, $11, $12, $13::jsonb, $14::jsonb, $15::jsonb, now())
      on conflict (product_draft_id, marketplace) do update set
        base_keyword = excluded.base_keyword,
        extracted_keywords = excluded.extracted_keywords,
        generated_keywords = excluded.generated_keywords,
        selected_keywords = excluded.selected_keywords,
        forbidden_keywords = excluded.forbidden_keywords,
        naver_total_results = excluded.naver_total_results,
        naver_lowest_price = excluded.naver_lowest_price,
        naver_top_titles = excluded.naver_top_titles,
        datalab_score = excluded.datalab_score,
        datalab_trend_direction = excluded.datalab_trend_direction,
        reasons = excluded.reasons,
        keyword_scores = excluded.keyword_scores,
        removed_supplier_labels = excluded.removed_supplier_labels,
        updated_at = now()
    `,
    [
      id,
      optimization.seo.marketplace,
      optimization.seo.baseKeyword,
      JSON.stringify(optimization.seo.generatedKeywords),
      JSON.stringify(optimization.seo.generatedKeywords),
      JSON.stringify(optimization.seo.selectedKeywords),
      JSON.stringify(optimization.seo.forbiddenKeywords),
      optimization.seo.naverTotalResults,
      optimization.seo.naverLowestPrice,
      JSON.stringify(optimization.seo.naverTopTitles),
      optimization.seo.datalabScore,
      optimization.seo.datalabTrendDirection,
      JSON.stringify(optimization.seo.reasons),
      JSON.stringify(optimization.seo.keywordScores || []),
      JSON.stringify(optimization.seo.removedSupplierLabels || []),
    ],
  );
  await db.query(
    `
      update product_drafts
      set optimized_coupang_title = case when $12 then $2 else optimized_coupang_title end,
          optimized_naver_title = case when $12 then $3 else optimized_naver_title end,
          title_keywords = case when $12 then $4::jsonb else title_keywords end,
          title_warnings = case when $12 then $5::jsonb else title_warnings end,
          title_generated_at = case when $12 then now() else title_generated_at end,
          generated_detail_html = case
            when $11 then $6
            else generated_detail_html
          end,
          hero_image_prompt = $7,
          detail_banner_prompt = $8,
          usage_scene_prompt = $9,
          spec_card_prompt = $10,
          updated_at = now()
      where id = $1
    `,
    [
      id,
      optimization.titles.coupangTitle,
      optimization.titles.naverTitle,
      JSON.stringify(optimization.titles.titleKeywords),
      JSON.stringify(optimization.titles.titleWarnings),
      optimization.detailHtml,
      optimization.imagePrompts.heroImagePrompt,
      optimization.imagePrompts.detailBannerPrompt,
      optimization.imagePrompts.usageScenePrompt,
      optimization.imagePrompts.specCardPrompt,
      createGeneratedDetailHtml,
      overwriteTitles,
    ],
  );
  await db.query(
    `
      insert into category_mapping (
        product_draft_id, domeme_category, naver_category, coupang_display_category_code,
        coupang_category_name, confidence_score, confirmed_by_user, updated_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, now())
      on conflict (product_draft_id) do update set
        domeme_category = excluded.domeme_category,
        naver_category = excluded.naver_category,
        coupang_display_category_code = excluded.coupang_display_category_code,
        coupang_category_name = excluded.coupang_category_name,
        confidence_score = excluded.confidence_score,
        confirmed_by_user = category_mapping.confirmed_by_user,
        updated_at = now()
    `,
    [
      id,
      optimization.category.domemeCategory,
      optimization.category.naverCategory,
      optimization.category.coupangDisplayCategoryCode,
      optimization.category.coupangCategoryName,
      optimization.category.confidenceScore,
      optimization.category.confirmedByUser,
    ],
  );
  await db.query(
    `
      insert into product_notice_info (
        product_draft_id, marketplace, notice_category, notice_items, missing_items, status, updated_at
      )
      values ($1, $2, $3, $4::jsonb, $5::jsonb, $6, now())
      on conflict (product_draft_id, marketplace) do update set
        notice_category = excluded.notice_category,
        notice_items = excluded.notice_items,
        missing_items = excluded.missing_items,
        status = excluded.status,
        updated_at = now()
    `,
    [
      id,
      optimization.notice.marketplace,
      optimization.notice.noticeCategory,
      JSON.stringify({
        ...optimization.notice.noticeItems,
        requiredDocuments: optimization.notice.requiredDocuments,
        certifications: optimization.notice.certifications,
      }),
      JSON.stringify(optimization.notice.missingItems),
      optimization.notice.status,
    ],
  );
  await db.query(
    `
      insert into product_shipping_policies (
        product_draft_id, marketplace, shipping_fee, return_shipping_fee, exchange_shipping_fee,
        island_remote_required_review, status, updated_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, now())
      on conflict (product_draft_id, marketplace) do update set
        shipping_fee = excluded.shipping_fee,
        return_shipping_fee = excluded.return_shipping_fee,
        exchange_shipping_fee = excluded.exchange_shipping_fee,
        island_remote_required_review = excluded.island_remote_required_review,
        status = excluded.status,
        updated_at = now()
    `,
    [
      id,
      optimization.shippingPolicy.marketplace,
      optimization.shippingPolicy.shippingFee,
      optimization.shippingPolicy.returnShippingFee,
      optimization.shippingPolicy.exchangeShippingFee,
      optimization.shippingPolicy.islandRemoteRequiredReview,
      optimization.shippingPolicy.status,
    ],
  );
}

async function assertApprovalAllowed(db, id, overrideReason) {
  const result = await db.query(
    `
      select block_reasons
      from product_drafts
      where id = $1
    `,
    [id],
  );
  const blockReasons = result.rows[0]?.block_reasons || [];
  if (blockReasons.length > 0 && !String(overrideReason || '').trim()) {
    throw new Error('overrideReason is required to approve a draft with block reasons');
  }
  const checklist = await getRegistrationChecklist(db, id);
  const optimization = await getRegistrationOptimization(db, id);
  const noticeMissing = (optimization?.notice || []).some((item) => (item.missingItems || []).length > 0);
  const effectiveOverride = String(overrideReason || checklist.overrideReason || '').trim();
  const missingChecks = approvalMissingChecks(checklist);
  if (noticeMissing && !effectiveOverride) missingChecks.push('notice_missing_requires_override');
  if (missingChecks.length > 0) {
    throw new Error(`approval requirements missing: ${missingChecks.join(',')}`);
  }
}

export async function exportProductDraft(db, id, channel) {
  const draft = await getProductDraft(db, id);
  if (!draft) return null;
  const optimization = await getRegistrationOptimization(db, id);
  const imagePromptRequests = await getImagePromptRequests(db, id);
  const approvedManualMainImage=await getApprovedManualMainImage(db,id);
  const approvedManualDetailSet=await getApprovedManualDetailSet(db,id);
  if (channel === 'coupang') return toCoupangExport(draft, optimization, imagePromptRequests,approvedManualMainImage,approvedManualDetailSet);
  if (channel === 'naver') return toNaverExport(draft, optimization, imagePromptRequests,approvedManualMainImage,approvedManualDetailSet);
  throw new Error(`Invalid export channel: ${channel}`);
}

export async function buildDebugExport(db, id) {
  const draft = await getProductDraft(db, id); if (!draft) return null;
  const requests = await getImagePromptRequests(db, id);
  const templates = await db.query('select * from image_prompt_templates where is_active = true');
  const manualAiMainImages=await listManualMainImages(db,id);
  const manualAiDetailSets=await listManualDetailSets(db,id);
  const byType = (type) => { const request=requests.find(x=>x.requestType===type)||null; const template=templates.rows.find(x=>x.template_type===type)||null; return { request, template }; };
  return { draftId:draft.id, product:{name:draft.sellingTitle||draft.rawName}, htmlDetailPage:{exists:Boolean(draft.generatedDetailHtml),length:draft.generatedDetailHtml.length,generatedDetailHtml:draft.generatedDetailHtml,updatedAt:draft.updatedAt||null}, imagePromptState:{mainImage:byType('main_image'),detailPage:byType('detail_page')}, images:{mainImages:imageUrlsByType(draft,['main']),detailImages:imageUrlsByType(draft,['detail','regenerated_detail_asset']),detailSourceFullImages:imageUrlsByType(draft,['detail_source_full','detail_full']),generatedAiImages:manualAiMainImages}, manualAiMainImages,generatedAiImageCount:manualAiMainImages.length,manualAiDetailSets,approvedAiDetailSet:manualAiDetailSets.find((set)=>set.status==='approved')||null };
}

export async function getImagePromptRequests(db, productDraftId) {
  const result = await db.query(`select r.*, t.template_type, t.template_name, t.version from product_image_generation_requests r join image_prompt_templates t on t.id = r.template_id where r.product_draft_id = $1 order by r.request_type`, [productDraftId]);
  return result.rows.map(toImagePromptRequest);
}

export async function getManualMainImageWorkflowContext(db, productDraftId) {
  const draft=await getProductDraft(db,productDraftId);if(!draft)return{draft:null,request:null,sourceMainImage:null,referenceImages:[]};
  const request=(await getImagePromptRequests(db,productDraftId)).find((item)=>item.requestType==='main_image')||null;
  const active=(await db.query("select * from image_prompt_templates where template_type='main_image' and is_active=true order by version desc limit 1")).rows[0]||null;
  if(request){const raw={template_version:request.templateVersion,template_hash:request.templateHash,prompt_original:request.promptOriginal,prompt_rendered:request.promptRendered};request.state=computeImagePromptState(raw,active).state;}
  const sourceMainImage=draft.images.find((image)=>image.imageType==='main')||null;
  const referenceImages=draft.images.filter((image)=>image.imageType!=='main'&&image.sourceSection==='detail').slice(0,2).map((image)=>({url:image.storedUrl||image.url}));
  return{draft,request,sourceMainImage:sourceMainImage?{...sourceMainImage,url:sourceMainImage.storedUrl||sourceMainImage.url}:null,referenceImages};
}

export async function getManualDetailWorkflowContext(db, productDraftId) {
  const sections = getDetailPageSections();
  const draft = await getProductDraft(db, productDraftId);
  if (!draft) return { draft: null, request: null, sections, mainImage: null, rawMainImage: null, detailImages: [], originalDetailFull: [], sourceSlices: [], extractedReferences: {}, sectionReferenceHints: {}, referenceImages: [] };
  const approvedMainImage = await getApprovedManualMainImage(db, productDraftId);

  const selectedRequest = (await getImagePromptRequests(db, productDraftId))
    .find((item) => item.requestType === 'detail_page') || null;
  const active = (await db.query("select * from image_prompt_templates where template_type='detail_page' and is_active=true order by version desc limit 1")).rows[0] || null;
  const request = selectedRequest ? {
    ...selectedRequest,
    state: computeImagePromptState({
      template_version: selectedRequest.templateVersion,
      template_hash: selectedRequest.templateHash,
      prompt_original: selectedRequest.promptOriginal,
      prompt_rendered: selectedRequest.promptRendered,
    }, active).state,
  } : null;

  const selectedUrls = new Set();
  const preferredUrl = (image) => image?.storedUrl || image?.originalUrl || image?.url || null;
  const imageAliases = (image) => [image?.storedUrl, image?.originalUrl, image?.url].filter(Boolean);
  const hasLocalStoredUrl = (image) => Boolean(image?.storedUrl && image.storedUrl !== image.originalUrl && image.storedUrl !== image.url);
  const addImage = (target, image) => {
    const url = preferredUrl(image);
    const aliases = imageAliases(image);
    const isSourceSlice = ['detail_source_slice', 'detail_slice'].includes(image?.imageType);
    if (!url || (!isSourceSlice && aliases.some((value) => selectedUrls.has(value)))) return;
    if (isSourceSlice && selectedUrls.has(`slice:${image.id}`)) return;
    if (isSourceSlice) selectedUrls.add(`slice:${image.id}`);
    else aliases.forEach((value) => selectedUrls.add(value));
    target.push({ ...image, url });
  };
  const addUrl = (target, value) => {
    const url = typeof value === 'string' ? value : value?.url;
    if (!url || selectedUrls.has(url)) return;
    selectedUrls.add(url);
    target.push({ url });
  };

  const sourceMainImage = draft.images.find((image) => image.imageType === 'main') || null;
  const rawMainImage = sourceMainImage ? { ...sourceMainImage, url: preferredUrl(sourceMainImage) } : null;
  const mainImage = approvedMainImage
    ? { url: approvedMainImage.coupangStoredUrl, storedUrl: approvedMainImage.coupangStoredUrl, imageType: 'main', approved: true }
    : rawMainImage;
  imageAliases(sourceMainImage).forEach((value) => selectedUrls.add(value));

  const detailPriority = new Map([
    ['detail_source_full', 0],
    ['detail_full', 0],
    ['detail', 1],
    ['regenerated_detail_asset', 1],
    ['detail_source_slice', 2],
    ['detail_slice', 2],
  ]);
  const detailImages = draft.images
    .map((image, order) => ({ image, order }))
    .filter(({ image }) => detailPriority.has(image.imageType))
    .sort((left, right) => detailPriority.get(left.image.imageType) - detailPriority.get(right.image.imageType)
      || Number(hasLocalStoredUrl(right.image)) - Number(hasLocalStoredUrl(left.image))
      || left.order - right.order)
    .reduce((assets, { image }) => {
      addImage(assets, image);
      return assets;
    }, []);
  for (const url of request?.sourceImageUrls || []) addUrl(detailImages, url);

  const originalDetailFull = detailImages.filter((image) => ['detail_source_full', 'detail_full'].includes(image.imageType));
  const sourceSlices = detailImages
    .filter((image) => ['detail_source_slice', 'detail_slice'].includes(image.imageType))
    .sort((left, right) => Number(left.sliceIndex || 0) - Number(right.sliceIndex || 0));
  const extractedReferences = buildDetailReferenceCandidates(sourceSlices, detailImages, rawMainImage);
  const sectionReferenceHints = buildSectionReferenceHints(sections, sourceSlices);

  const referenceImages = [];
  for (const url of request?.competitorImageUrls || []) addUrl(referenceImages, url);

  return { draft, request, sections, mainImage, rawMainImage, detailImages, originalDetailFull, sourceSlices, extractedReferences, sectionReferenceHints, referenceImages };
}

function buildDetailReferenceCandidates(sourceSlices, detailImages, mainImage) {
  const candidates = (indices) => indices.map((index) => sourceSlices[index - 1]).filter(Boolean);
  const regularDetail = detailImages.filter((image) => image.imageType === 'detail');
  return {
    heroCandidates: [mainImage, ...candidates([1, 2])].filter(Boolean),
    reviewStyleCandidates: candidates([2, 3, 4]),
    pointCandidates: [...candidates([3, 4, 5, 6]), ...regularDetail.slice(0, 1)],
    comparisonCandidates: candidates([6, 7, 8]),
    sizeOptionCandidates: candidates([8, 9, 10]),
  };
}

function buildSectionReferenceHints(sections, sourceSlices) {
  const names = (indices) => indices
    .filter((index) => sourceSlices[index - 1])
    .map((index) => `source-slices/source-slice-${String(index).padStart(2, '0')}`);
  const fallback = sourceSlices.length ? names([1]) : [];
  const preferred = {
    hero: [1, 2], review: [2, 3, 4], core_values: [3, 4, 5],
    point_01: [3, 4], point_02: [4, 5], point_03: [5, 6],
    comparison: [6, 7, 8], detail: [6, 7], color_size: [8, 9], product_info: [8, 9, 10],
  };
  return Object.fromEntries((sections || []).map((section) => {
    const hints = names(preferred[section.key] || []);
    return [section.key, hints.length ? hints : fallback];
  }));
}

export async function createImagePromptRequest(db, productDraftId, requestType) {
  if (!['main_image', 'detail_page'].includes(requestType)) throw new Error(`Invalid image prompt request type: ${requestType}`);
  const existing = await getImagePromptRequests(db, productDraftId);
  const found = existing.find((request) => request.requestType === requestType);
  if (found) return { created: false, request: found };
  const draft = await getProductDraft(db, productDraftId); if (!draft) return null;
  const templateResult = await db.query('select * from image_prompt_templates where template_type = $1 and is_active = true', [requestType]);
  const template = templateResult.rows[0]; if (!template) throw new Error(`Active ${requestType} template not found. Run prompts:import-docx first.`);
  const naver = await db.query("select raw_json from market_research_results where product_draft_id = $1 and marketplace = 'naver'", [productDraftId]);
  const competitorImageUrls = (naver.rows[0]?.raw_json?.searchRaw?.items || []).map((item) => item.image).filter(Boolean);
  const sourceImageUrls = draft.images.filter((i) => i.sourceSection === 'detail' || i.imageType === 'detail_source_full').map((i) => i.storedUrl || i.url).filter(Boolean);
  const rendered = renderImagePrompt(template.template_body, { optimizedTitle: draft.optimizedCoupangTitle || draft.optimizedNaverTitle || draft.sellingTitle || draft.rawName, storeName: '와우픽', options: draft.options, originalDetailHtml: draft.originalDetailHtml, sourceImageUrls, competitorImageUrls });
  const hash=createHash('sha256').update(template.template_body).digest('hex');
  const result = await db.query(`insert into product_image_generation_requests (product_draft_id,request_type,template_id,template_version,template_hash,source_file_name,prompt_original,prompt_rendered,status,source_image_urls_json,competitor_image_urls_json,warnings_json,revision,updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,'draft',$9::jsonb,$10::jsonb,$11::jsonb,1,now()) returning *`, [productDraftId, requestType, template.id,template.version,hash,template.source_file_name, template.template_body, rendered.prompt, JSON.stringify(sourceImageUrls), JSON.stringify(competitorImageUrls), JSON.stringify(rendered.warnings)]);
  return { created: true, request: toImagePromptRequest({ ...result.rows[0], template_type: template.template_type, template_name: template.template_name, version: template.version }) };
}

export async function setImagePromptRequestStatus(db, productDraftId, requestType, status) {
  if (!['draft', 'approved', 'rejected'].includes(status)) throw new Error(`Invalid image prompt status: ${status}`);
  const result = await db.query('update product_image_generation_requests set status = $3, updated_at = now() where product_draft_id = $1 and request_type = $2 returning *', [productDraftId, requestType, status]);
  return result.rows[0] ? toImagePromptRequest(result.rows[0]) : null;
}

export async function regenerateImagePromptRequest(db, productDraftId, requestType, { confirm = false } = {}) {
  const existing=(await getImagePromptRequests(db,productDraftId)).find(x=>x.requestType===requestType); if(!existing) return createImagePromptRequest(db,productDraftId,requestType);
  if(existing.status==='approved'&&!confirm) { const error=new Error('confirm=true is required to regenerate an approved request'); error.code='CONFIRM_REQUIRED'; throw error; }
  await db.query('insert into product_image_generation_request_revisions (request_id,revision,template_id,template_version,template_hash,source_file_name,prompt_original,prompt_rendered,warnings_json,status) values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)',[existing.id,existing.revision||1,existing.templateId,existing.templateVersion,existing.templateHash||null,existing.sourceFileName||null,existing.promptOriginal,existing.promptRendered,JSON.stringify(existing.warnings),existing.status]);
  await db.query('delete from product_image_generation_requests where id=$1',[existing.id]);
  const result=await createImagePromptRequest(db,productDraftId,requestType);
  await db.query('update product_image_generation_requests set revision=$2, regenerated_at=now(), status=$3 where id=$1',[result.request.id,(existing.revision||1)+1,'draft']);
  const refreshed=(await getImagePromptRequests(db,productDraftId)).find(x=>x.requestType===requestType);
  return { created:false, request:refreshed, regenerated:true };
}

export async function getMarketResearch(db, productDraftId, marketplace) {
  assertMarketplace(marketplace);
  const result = await db.query(
    `
      select *
      from market_research_results
      where product_draft_id = $1 and marketplace = $2
    `,
    [productDraftId, marketplace],
  );
  return result.rows[0] ? toMarketResearch(result.rows[0]) : null;
}

export async function upsertMarketResearch(db, productDraftId, marketplace, input) {
  assertMarketplace(marketplace);
  const draft = await getProductDraft(db, productDraftId);
  if (!draft) return null;

  const mySalePrice = toIntegerOrNull(input.mySalePrice ?? input.my_sale_price ?? draft.coupangSalePrice);
  const lowestPrice = toIntegerOrNull(input.lowestPrice ?? input.lowest_price);
  const topPriceAvg = toIntegerOrNull(input.topPriceAvg ?? input.top_price_avg);
  const competitorCount = toIntegerOrNull(input.competitorCount ?? input.competitor_count);
  const rocketExists = toBoolean(input.rocketExists ?? input.rocket_exists);
  const maxReviewCount = toIntegerOrNull(input.maxReviewCount ?? input.max_review_count);
  const avgRating = toNumberOrNull(input.avgRating ?? input.avg_rating);
  const calculated = calculateWinnerScore({
    mySalePrice,
    lowestPrice,
    competitorCount,
    rocketExists,
    maxReviewCount,
    expectedProfit: draft.coupangExpectedProfit,
  });

  const result = await db.query(
    `
      insert into market_research_results (
        product_draft_id,
        marketplace,
        keyword,
        my_sale_price,
        lowest_price,
        top_price_avg,
        competitor_count,
        rocket_exists,
        max_review_count,
        avg_rating,
        price_gap_rate,
        winner_score,
        winner_status,
        reasons,
        raw_json,
        checked_at,
        updated_at
      )
      values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14::jsonb, $15::jsonb, now(), now()
      )
      on conflict (product_draft_id, marketplace) do update set
        keyword = excluded.keyword,
        my_sale_price = excluded.my_sale_price,
        lowest_price = excluded.lowest_price,
        top_price_avg = excluded.top_price_avg,
        competitor_count = excluded.competitor_count,
        rocket_exists = excluded.rocket_exists,
        max_review_count = excluded.max_review_count,
        avg_rating = excluded.avg_rating,
        price_gap_rate = excluded.price_gap_rate,
        winner_score = excluded.winner_score,
        winner_status = excluded.winner_status,
        reasons = excluded.reasons,
        raw_json = excluded.raw_json,
        checked_at = now(),
        updated_at = now()
      returning *
    `,
    [
      productDraftId,
      marketplace,
      input.keyword ?? null,
      mySalePrice,
      lowestPrice,
      topPriceAvg,
      competitorCount,
      rocketExists,
      maxReviewCount,
      avgRating,
      calculated.priceGapRate,
      calculated.winnerScore,
      calculated.winnerStatus,
      JSON.stringify(calculated.reasons),
      JSON.stringify(input),
    ],
  );
  return toMarketResearch(result.rows[0]);
}

function addPatch(fields, params, patch, key, column, convert = identity) {
  if (!Object.hasOwn(patch, key)) return;
  params.push(convert(patch[key]));
  fields.push(`${column} = $${params.length}`);
}

function toDraftListItem(row) {
  return {
    id: Number(row.id),
    supplierProductNo: row.supplier_product_no,
    originalProductName: row.domeggook_title || row.product_name || row.raw_name || '',
    rawName: row.raw_name,
    sellingTitle: row.selling_title || row.cleaned_name || row.raw_name,
    cost: row.cost,
    shippingFee: row.shipping_fee,
    supplierMarket: row.source_market || 'unknown',
    supplierProductUrl: row.supplier_product_url || buildSupplierProductUrl(row.supplier_product_no, row.source_market),
    minOrderQty: row.min_order_qty == null ? 1 : Number(row.min_order_qty),
    orderUnit: row.order_unit == null ? 1 : Number(row.order_unit),
    sellUnitType: row.sell_unit_type || 'single',
    bundleQuantity: row.bundle_quantity == null ? 1 : Number(row.bundle_quantity),
    unitCostPrice: row.unit_cost_price == null ? row.cost : Number(row.unit_cost_price),
    bundleCostPrice: row.bundle_cost_price == null ? row.cost : Number(row.bundle_cost_price),
    bundleReason: row.bundle_reason || null,
    coupangSalePrice: row.coupang_sale_price,
    coupangExpectedProfit: row.coupang_expected_profit,
    coupangMarginRate: row.coupang_margin_rate == null ? null : Number(row.coupang_margin_rate),
    naverSalePrice: row.naver_sale_price,
    naverExpectedProfit: row.naver_expected_profit,
    naverMarginRate: row.naver_margin_rate == null ? null : Number(row.naver_margin_rate),
    filterStatus: row.filter_status,
    blockReasons: row.block_reasons || [],
    reviewReasons: row.review_reasons || [],
    status: row.status,
    finalDecision: row.final_decision || calculateFinalDecision(row),
    warnings: buildWarnings(row),
    mainImages: row.main_images == null ? null : Number(row.main_images),
    detailImages: row.detail_images == null ? null : Number(row.detail_images),
    totalImages: row.total_images == null ? row.image_count : Number(row.total_images),
    importBatchId: row.import_batch_id,
    collectedAt: row.collected_at,
    updatedAt: row.updated_at,
    coupangResearch: {
      lowestPrice: row.coupang_lowest_price,
      priceGapRate: row.coupang_price_gap_rate == null ? null : Number(row.coupang_price_gap_rate),
      rocketExists: row.coupang_rocket_exists,
      maxReviewCount: row.coupang_max_review_count,
      competitorCount: row.coupang_competitor_count,
      winnerScore: row.coupang_winner_score,
      winnerStatus: row.coupang_winner_status,
    },
    naverResearch: {
      lowestPrice: row.naver_lowest_price,
      priceGapRate: row.naver_price_gap_rate == null ? null : Number(row.naver_price_gap_rate),
      competitorCount: row.naver_competitor_count,
      winnerScore: row.naver_winner_score,
      winnerStatus: row.naver_winner_status,
    },
    optimizedCoupangTitle: row.optimized_coupang_title || null,
    optimizedNaverTitle: row.optimized_naver_title || null,
    titleKeywords: row.title_keywords || [],
    titleWarnings: row.title_warnings || [],
    titleGeneratedAt: row.title_generated_at || null,
    heroImagePrompt: row.hero_image_prompt || null,
    detailBannerPrompt: row.detail_banner_prompt || null,
    usageScenePrompt: row.usage_scene_prompt || null,
    specCardPrompt: row.spec_card_prompt || null,
  };
}

function calculateFinalDecision(row) {
  const blockReasons = row.block_reasons || [];
  if (row.status === 'blocked') return '제외';
  if (blockReasons.length > 0) return '제외';
  if (Number(row.min_order_qty || 1) >= 5) return '제외';
  if (row.naver_winner_status === 'reject') return '제외';
  if (row.source_market === 'domeggook') return '검수필요';
  if ((row.source_market || 'unknown') === 'unknown') return '검수필요';
  if (Number(row.order_unit || 1) > 1) return '검수필요';
  if (row.naver_winner_status === 'candidate' && Number(row.naver_expected_profit || 0) >= 3000) return '등록후보';
  return '검수필요';
}

function buildWarnings(row) {
  const warnings = [];
  if (row.status === 'approved' && (row.block_reasons || []).length > 0) {
    warnings.push('approved_with_block_reasons');
  }
  if (row.detail_images !== undefined && Number(row.detail_images || 0) === 0) {
    warnings.push('detail_images_missing');
  }
  return warnings;
}

function buildSupplierProductUrl(productNo, sourceMarket) {
  const no = encodeURIComponent(String(productNo || ''));
  if (sourceMarket === 'domeme') return `https://domeggook.com/main/item/itemView.php?no=${no}&market=dome`;
  return `https://domeggook.com/main/item/itemView.php?no=${no}`;
}

function supplierNameFromRaw(raw) {
  if (!raw || typeof raw !== 'object') return '';
  const source = raw.domeggook || raw.data || raw.item || raw.product || raw;
  return String(
    source.supplierName ||
      source.sellerName ||
      source.seller ||
      source.companyName ||
      source.company ||
      source.sellerInfo?.name ||
      '',
  ).trim();
}

function toDraftDetail(row, images, options) {
  return {
    ...toDraftListItem(row),
    supplierProductId: Number(row.supplier_product_id),
    supplierName: supplierNameFromRaw(row.raw_json),
    cleanedName: row.cleaned_name,
    rawPriceFieldName: row.raw_price_field_name,
    rawPriceValue: row.raw_price_value,
    priceParseStatus: row.price_parse_status,
    shippingRawFieldName: row.shipping_raw_field_name,
    shippingRawValue: row.shipping_raw_value,
    shippingParseStatus: row.shipping_parse_status,
    priceTiers: row.price_tiers || [],
    shippingTiers: row.shipping_tiers || [],
    coupangExpectedProfit: row.coupang_expected_profit,
    coupangMarginRate: row.coupang_margin_rate == null ? null : Number(row.coupang_margin_rate),
    naverExpectedProfit: row.naver_expected_profit,
    naverMarginRate: row.naver_margin_rate == null ? null : Number(row.naver_margin_rate),
    generatedDetailHtml: row.generated_detail_html || row.draft_html || '',
    reviewMemo: row.review_memo || '',
    originalDetailHtml: row.original_detail_html || '',
    images: images.map((image) => ({
      id: Number(image.id),
      index: image.image_index,
      url: image.url,
      imageType: image.image_type || 'unknown',
      sortOrder: image.sort_order == null ? image.image_index : Number(image.sort_order),
      originalUrl: image.original_url || image.url,
      storedUrl: image.stored_url || image.url,
      width: image.width == null ? null : Number(image.width),
      height: image.height == null ? null : Number(image.height),
      aspectRatio: image.aspect_ratio == null ? null : Number(image.aspect_ratio),
      isLongImage: Boolean(image.is_long_image),
      parentImageId: image.parent_image_id == null ? null : Number(image.parent_image_id),
      sliceIndex: image.slice_index == null ? null : Number(image.slice_index),
      sourceMethod: image.source_method || 'api',
      sourcePageUrl: image.source_page_url || null,
      domSelector: image.dom_selector || null,
      domIndex: image.dom_index == null ? null : Number(image.dom_index),
      renderedX: image.rendered_x == null ? null : Number(image.rendered_x),
      renderedY: image.rendered_y == null ? null : Number(image.rendered_y),
      renderedWidth: image.rendered_width == null ? null : Number(image.rendered_width),
      renderedHeight: image.rendered_height == null ? null : Number(image.rendered_height),
      naturalWidth: image.natural_width == null ? null : Number(image.natural_width),
      naturalHeight: image.natural_height == null ? null : Number(image.natural_height),
      contentHash: image.content_hash || null,
      crawlStatus: image.crawl_status || null,
      crawlError: image.crawl_error || null,
      selectedForDetail: Boolean(image.selected_for_detail),
      qualityStatus: image.quality_status || null,
      sourceSection: image.source_section ?? null,
      rejectReason: image.reject_reason || null,
    })),
    options: options.map((option) => ({
      id: Number(option.id),
      index: option.option_index,
      name: option.name,
      value: option.value,
      additionalPrice: option.additional_price,
      stockQuantity: option.stock_quantity == null ? null : Number(option.stock_quantity),
      optionCode: option.option_code,
      raw: option.raw_json,
    })),
  };
}

function toCoupangExport(draft, optimization = null, imagePromptRequests = [],approvedManualMainImage=null,approvedManualDetailSet=null) {
  return {
    channel: 'coupang',
    exportBlocked: draft.status === 'blocked' || draft.filterStatus === 'blocked',
    blockedReasons: draft.status === 'blocked' || draft.filterStatus === 'blocked' ? draft.blockReasons : [],
    reviewReasons: draft.reviewReasons,
    supplierProductNo: draft.supplierProductNo,
    supplierMarket: draft.supplierMarket,
    supplierProductUrl: draft.supplierProductUrl,
    minOrderQty: draft.minOrderQty,
    orderUnit: draft.orderUnit,
    sellUnitType: draft.sellUnitType,
    bundleQuantity: draft.bundleQuantity,
    unitCostPrice: draft.unitCostPrice,
    bundleCostPrice: draft.bundleCostPrice,
    bundleReason: draft.bundleReason,
    displayProductName: draft.optimizedCoupangTitle || draft.sellingTitle,
    displayCategoryCode: null,
    sellerProductName: draft.optimizedCoupangTitle || draft.sellingTitle,
    optimizedTitle: draft.optimizedCoupangTitle,
    salePrice: draft.coupangSalePrice,
    cost: draft.cost,
    shippingFee: draft.shippingFee,
    expectedProfit: draft.coupangExpectedProfit,
    detailHtml: draft.generatedDetailHtml,
    ...approvedDetailExport(approvedManualDetailSet),
    readyToRegister: false,
    aiImageStatus: toAiImageStatus(imagePromptRequests),
    registrationOptimization: {
      titleKeywords: draft.titleKeywords,
      titleWarnings: draft.titleWarnings,
      seo: optimization?.seo || [],
      category: optimization?.category || null,
      notice: optimization?.notice || [],
      shippingPolicies: optimization?.shippingPolicies || [],
    },
    mainImages: preferredMainImages(draft,approvedManualMainImage),
    detailImages: imageUrlsByType(draft, ['detail', 'regenerated_detail_asset']),
    detailSourceFullImages: imageUrlsByType(draft, ['detail_source_full', 'detail_full']),
    regeneratedDetailAssets: imageUrlsByType(draft, ['regenerated_detail_asset']),
    detailFullImages: imageUrlsByType(draft, ['detail_full']),
    detailSliceImages: imageUrlsByType(draft, ['detail_slice']),
    images: draft.images.map(toExportImage),
    options: draft.options.map((option) => ({
      optionName: option.name,
      optionValue: option.value,
      additionalPrice: option.additionalPrice,
      stockQuantity: option.stockQuantity,
    })),
  };
}

function toNaverExport(draft, optimization = null, imagePromptRequests = [],approvedManualMainImage=null,approvedManualDetailSet=null) {
  return {
    channel: 'naver',
    exportBlocked: draft.status === 'blocked' || draft.filterStatus === 'blocked',
    blockedReasons: draft.status === 'blocked' || draft.filterStatus === 'blocked' ? draft.blockReasons : [],
    reviewReasons: draft.reviewReasons,
    supplierProductNo: draft.supplierProductNo,
    supplierMarket: draft.supplierMarket,
    supplierProductUrl: draft.supplierProductUrl,
    minOrderQty: draft.minOrderQty,
    orderUnit: draft.orderUnit,
    sellUnitType: draft.sellUnitType,
    bundleQuantity: draft.bundleQuantity,
    unitCostPrice: draft.unitCostPrice,
    bundleCostPrice: draft.bundleCostPrice,
    bundleReason: draft.bundleReason,
    displayProductName: draft.optimizedNaverTitle || draft.sellingTitle,
    name: draft.optimizedNaverTitle || draft.sellingTitle,
    optimizedTitle: draft.optimizedNaverTitle,
    salePrice: draft.naverSalePrice,
    cost: draft.cost,
    deliveryFee: draft.shippingFee,
    expectedProfit: draft.naverExpectedProfit,
    detailContent: draft.generatedDetailHtml,
    ...approvedDetailExport(approvedManualDetailSet),
    readyToRegister: false,
    aiImageStatus: toAiImageStatus(imagePromptRequests),
    registrationOptimization: {
      titleKeywords: draft.titleKeywords,
      titleWarnings: draft.titleWarnings,
      seo: optimization?.seo || [],
      category: optimization?.category || null,
      notice: optimization?.notice || [],
      shippingPolicies: optimization?.shippingPolicies || [],
    },
    mainImages: preferredMainImages(draft,approvedManualMainImage),
    detailImages: imageUrlsByType(draft, ['detail', 'regenerated_detail_asset']),
    detailSourceFullImages: imageUrlsByType(draft, ['detail_source_full', 'detail_full']),
    regeneratedDetailAssets: imageUrlsByType(draft, ['regenerated_detail_asset']),
    detailFullImages: imageUrlsByType(draft, ['detail_full']),
    detailSliceImages: imageUrlsByType(draft, ['detail_slice']),
    images: draft.images.map(toExportImage),
    options: draft.options.map((option) => ({
      groupName: option.name,
      optionName: option.value,
      price: option.additionalPrice,
    })),
  };
}

function toImagePrompts(draft) {
  return {
    heroImagePrompt: draft.heroImagePrompt,
    detailBannerPrompt: draft.detailBannerPrompt,
    usageScenePrompt: draft.usageScenePrompt,
    specCardPrompt: draft.specCardPrompt,
  };
}

function toImagePromptRequest(row) {
  return { id: Number(row.id), productDraftId: Number(row.product_draft_id), requestType: row.request_type, templateId: Number(row.template_id), templateType: row.template_type || row.request_type, templateName: row.template_name || null, templateVersion: row.template_version || row.version || null, templateHash: row.template_hash || null, sourceFileName: row.source_file_name || null, revision: row.revision || 1, promptOriginal: row.prompt_original, promptRendered: row.prompt_rendered, status: row.status, sourceImageUrls: row.source_image_urls_json || [], competitorImageUrls: row.competitor_image_urls_json || [], warnings: row.warnings_json || [], createdAt: row.created_at, updatedAt: row.updated_at, regeneratedAt:row.regenerated_at||null };
}

function toImagePromptExport(requests) {
  const main = requests.find((x) => x.requestType === 'main_image'); const detail = requests.find((x) => x.requestType === 'detail_page');
  return { imagePromptTemplates: requests.map((x) => ({ id: x.templateId, type: x.templateType, name: x.templateName, version: x.templateVersion })), mainImagePromptOriginal: main?.promptOriginal || null, mainImagePromptRendered: main?.promptRendered || null, detailPagePromptOriginal: detail?.promptOriginal || null, detailPagePromptRendered: detail?.promptRendered || null, imagePromptWarnings: [...new Set(requests.flatMap((x) => x.warnings))], imagePromptStatus: { main_image: main?.status || null, detail_page: detail?.status || null } };
}
function toAiImageStatus(requests) { const status=(type)=>requests.find(x=>x.requestType===type)?'prompt_only':'no_request'; return {mainImage:status('main_image'),detailPage:status('detail_page'),generatedImageCount:0}; }

function imageUrlsByType(draft, types) {
  const wanted = new Set(types);
  return (draft.images || [])
    .filter((image) => wanted.has(image.imageType))
    .filter((image) => image.imageType === 'main' || ['detail', 'unknown', null].includes(image.sourceSection))
    .sort((a, b) => (a.sortOrder ?? a.index ?? 0) - (b.sortOrder ?? b.index ?? 0))
    .map((image) => image.storedUrl || image.url);
}

function preferredMainImages(draft,approvedManualMainImage){return[approvedManualMainImage?.coupangStoredUrl,...imageUrlsByType(draft,['main'])].filter((value,index,all)=>value&&all.indexOf(value)===index);}
function approvedDetailExport(set){return{approvedAiDetailImages:set?.images?.map((image)=>image.normalizedStoredUrl)||[],approvedAiDetailImageCount:set?.images?.length||0,approvedAiDetailSetVersion:set?.setVersion||null,approvedAiDetailProvider:set?.providerCode||null,approvedAiDetailPromptRevision:set?.promptRevision||null};}

function toExportImage(image) {
  return {
    url: image.url,
    imageType: image.imageType,
    originalUrl: image.originalUrl,
    storedUrl: image.storedUrl,
    width: image.width,
    height: image.height,
    aspectRatio: image.aspectRatio,
    isLongImage: image.isLongImage,
    parentImageId: image.parentImageId,
    sliceIndex: image.sliceIndex,
    sourceMethod: image.sourceMethod,
    sourcePageUrl: image.sourcePageUrl,
    domSelector: image.domSelector,
    domIndex: image.domIndex,
    renderedX: image.renderedX,
    renderedY: image.renderedY,
    renderedWidth: image.renderedWidth,
    renderedHeight: image.renderedHeight,
    naturalWidth: image.naturalWidth,
    naturalHeight: image.naturalHeight,
    contentHash: image.contentHash,
    selectedForDetail: image.selectedForDetail,
    qualityStatus: image.qualityStatus,
    sourceSection: image.sourceSection,
    rejectReason: image.rejectReason,
  };
}

function toSeoAnalysis(row) {
  return {
    id: Number(row.id),
    productDraftId: Number(row.product_draft_id),
    marketplace: row.marketplace,
    baseKeyword: row.base_keyword,
    extractedKeywords: row.extracted_keywords || row.generated_keywords || [],
    generatedKeywords: row.generated_keywords || [],
    selectedKeywords: row.selected_keywords || [],
    forbiddenKeywords: row.forbidden_keywords || [],
    naverTotalResults: row.naver_total_results,
    naverLowestPrice: row.naver_lowest_price,
    naverTopTitles: row.naver_top_titles || [],
    datalabScore: row.datalab_score == null ? null : Number(row.datalab_score),
    datalabTrendDirection: row.datalab_trend_direction,
    reasons: row.reasons || [],
    keywordScores: row.keyword_scores || [],
    removedSupplierLabels: row.removed_supplier_labels || [],
  };
}

function toCategoryMapping(row) {
  return {
    id: Number(row.id),
    productDraftId: Number(row.product_draft_id),
    domemeCategory: row.domeme_category,
    naverCategory: row.naver_category,
    coupangDisplayCategoryCode: row.coupang_display_category_code,
    coupangCategoryName: row.coupang_category_name,
    confidenceScore: row.confidence_score == null ? null : Number(row.confidence_score),
    confirmedByUser: row.confirmed_by_user,
  };
}

function toNoticeInfo(row) {
  return {
    id: Number(row.id),
    productDraftId: Number(row.product_draft_id),
    marketplace: row.marketplace,
    noticeCategory: row.notice_category,
    noticeItems: row.notice_items || {},
    missingItems: row.missing_items || [],
    status: row.status,
  };
}

function toShippingPolicy(row) {
  return {
    id: Number(row.id),
    productDraftId: Number(row.product_draft_id),
    marketplace: row.marketplace,
    shippingFee: row.shipping_fee,
    returnShippingFee: row.return_shipping_fee,
    exchangeShippingFee: row.exchange_shipping_fee,
    islandRemoteRequiredReview: row.island_remote_required_review,
    status: row.status,
  };
}

function defaultRegistrationChecklist(id) {
  return {
    productDraftId: Number(id),
    supplierLinkChecked: false,
    naverLowestSameItemChecked: false,
    titleChecked: false,
    detailChecked: false,
    categoryChecked: false,
    noticeChecked: false,
    shippingPolicyChecked: false,
    exportJsonChecked: false,
    overrideReason: null,
  };
}

function toRegistrationChecklist(row) {
  return {
    id: Number(row.id),
    productDraftId: Number(row.product_draft_id),
    supplierLinkChecked: row.supplier_link_checked,
    naverLowestSameItemChecked: row.naver_lowest_same_item_checked,
    titleChecked: row.title_checked,
    detailChecked: row.detail_checked,
    categoryChecked: row.category_checked,
    noticeChecked: row.notice_checked,
    shippingPolicyChecked: row.shipping_policy_checked,
    exportJsonChecked: row.export_json_checked,
    overrideReason: row.override_reason,
  };
}

function approvalMissingChecks(checklist) {
  const required = [
    ['supplierLinkChecked', 'supplier_link_checked'],
    ['naverLowestSameItemChecked', 'naver_lowest_same_item_checked'],
    ['titleChecked', 'title_checked'],
    ['detailChecked', 'detail_checked'],
    ['categoryChecked', 'category_checked'],
    ['noticeChecked', 'notice_checked'],
    ['shippingPolicyChecked', 'shipping_policy_checked'],
    ['exportJsonChecked', 'export_json_checked'],
  ];
  return required.filter(([key]) => !checklist[key]).map(([, label]) => label);
}

function toMarketResearch(row) {
  return {
    id: Number(row.id),
    productDraftId: Number(row.product_draft_id),
    marketplace: row.marketplace,
    keyword: row.keyword,
    mySalePrice: row.my_sale_price,
    lowestPrice: row.lowest_price,
    topPriceAvg: row.top_price_avg,
    competitorCount: row.competitor_count,
    rocketExists: row.rocket_exists,
    maxReviewCount: row.max_review_count,
    avgRating: row.avg_rating == null ? null : Number(row.avg_rating),
    priceGapRate: row.price_gap_rate == null ? null : Number(row.price_gap_rate),
    winnerScore: row.winner_score,
    winnerStatus: row.winner_status,
    reasons: row.reasons || [],
    raw: row.raw_json,
    bestItem: row.raw_json?.bestItem || null,
    checkedAt: row.checked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toIntegerOrNull(value) {
  if (value === '' || value == null) return null;
  const number = Number(value);
  if (!Number.isInteger(number)) throw new Error(`Expected integer value: ${value}`);
  return number;
}

function toNumberOrNull(value) {
  if (value === '' || value == null) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`Expected numeric value: ${value}`);
  return number;
}

function toBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1' || value === 1) return true;
  return false;
}

function assertMarketplace(marketplace) {
  if (!VALID_MARKETPLACES.has(marketplace)) throw new Error(`Invalid marketplace: ${marketplace}`);
}

function identity(value) {
  return value;
}
