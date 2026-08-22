import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  DETAIL_PAGE_EXPECTED_COUNT,
  DETAIL_PAGE_SECTIONS,
  getDetailPageSections,
} from '../src/manual-ai/detail-sections.mjs';
import { getManualDetailWorkflowContext } from '../src/admin-store.mjs';

const TEMPLATE_BODY = 'detail page prompt template';
const TEMPLATE_HASH = createHash('sha256').update(TEMPLATE_BODY).digest('hex');

function detailContextDb({ activeTemplateVersion = 1, approvedMainImageRow = null } = {}) {
  return {
    async query(sql, params = []) {
      const text = String(sql).replace(/\s+/g, ' ').trim();

      if (text.includes('from generated_ai_images')) {
        assert.deepEqual(params, [64]);
        return { rows: approvedMainImageRow ? [approvedMainImageRow] : [] };
      }

      if (text.includes('from product_drafts d')) {
        assert.deepEqual(params, [64]);
        return {
          rows: [{
            id: 64,
            supplier_product_id: 4,
            supplier_product_no: 'DRAFT-64',
            raw_name: 'Draft 64 product',
            selling_title: 'Draft 64 product',
            generated_detail_html: '<section>preserved</section>',
            source_market: 'domeme',
            raw_json: {},
            original_detail_html: '<p>supplier detail</p>',
            main_images: 1,
            detail_images: 4,
            total_images: 5,
          }],
        };
      }

      if (text.includes('from product_images')) {
        return {
          rows: [
            {
              id: 1,
              image_index: 1,
              url: 'https://supplier.test/main.jpg',
              original_url: 'https://supplier.test/main.jpg',
              stored_url: '/original-images/main.jpg',
              image_type: 'main',
              sort_order: 1,
              source_section: 'main',
            },
            {
              id: 2,
              image_index: 2,
              url: 'https://supplier.test/detail.jpg',
              original_url: 'https://supplier.test/detail.jpg',
              stored_url: '/original-images/detail.jpg',
              image_type: 'detail',
              sort_order: 2,
              source_section: 'detail',
            },
            {
              id: 3,
              image_index: 3,
              url: 'https://supplier.test/detail-full.jpg',
              original_url: 'https://supplier.test/detail-full.jpg',
              stored_url: null,
              image_type: 'detail_source_full',
              sort_order: 3,
              source_section: 'detail',
            },
            {
              id: 5,
              image_index: 4,
              url: 'https://supplier.test/detail-full.jpg',
              original_url: 'https://supplier.test/detail-full.jpg',
              stored_url: '/original-images/detail-source-full.jpg',
              image_type: 'detail_source_full',
              sort_order: 4,
              source_section: 'detail',
            },
            {
              id: 4,
              image_index: 5,
              url: 'https://supplier.test/detail-slice.jpg',
              original_url: 'https://supplier.test/detail-slice.jpg',
              stored_url: null,
              image_type: 'detail_source_slice',
              sort_order: 5,
              source_section: 'detail',
            },
          ],
        };
      }

      if (text.includes('from product_options')) return { rows: [] };

      if (text.includes('from product_image_generation_requests r')) {
        assert.deepEqual(params, [64]);
        return {
          rows: [{
            id: 8,
            product_draft_id: 64,
            request_type: 'detail_page',
            template_id: 2,
            template_type: 'detail_page',
            template_name: 'Detail page prompt',
            template_version: 1,
            template_hash: TEMPLATE_HASH,
            source_file_name: 'detail-page.docx',
            prompt_original: TEMPLATE_BODY,
            prompt_rendered: 'rendered detail page prompt',
            source_image_urls_json: [
              'https://supplier.test/detail-full.jpg',
              'https://supplier.test/request-only.jpg',
              'https://supplier.test/request-only.jpg',
            ],
            competitor_image_urls_json: [
              'https://reference.test/competitor.jpg',
              'https://reference.test/competitor.jpg',
              'https://supplier.test/detail.jpg',
            ],
            warnings_json: [],
            revision: 1,
            status: 'draft',
          }],
        };
      }

      if (text.includes("template_type='detail_page'")) {
        return {
          rows: [{
            id: 2,
            template_type: 'detail_page',
            version: activeTemplateVersion,
            template_body: TEMPLATE_BODY,
            is_active: true,
          }],
        };
      }

      throw new Error(`Unexpected query: ${text}`);
    },
  };
}

test('detail sections expose an immutable canonical snapshot through fresh objects', () => {
  assert.equal(DETAIL_PAGE_EXPECTED_COUNT, 10);
  assert.ok(Object.isFrozen(DETAIL_PAGE_SECTIONS));
  assert.ok(DETAIL_PAGE_SECTIONS.every((section) => Object.isFrozen(section)));

  const first = getDetailPageSections();
  const second = getDetailPageSections();
  assert.notStrictEqual(first, second);
  assert.notStrictEqual(first[0], second[0]);
  assert.deepEqual(first.map(({ index, key, label }) => ({ index, key, label })), [
    { index: 1, key: 'hero', label: 'Hero' },
    { index: 2, key: 'review', label: '리뷰/평점' },
    { index: 3, key: 'core_values', label: '3가지 핵심가치' },
    { index: 4, key: 'point_01', label: 'Point 01' },
    { index: 5, key: 'point_02', label: 'Point 02' },
    { index: 6, key: 'point_03', label: 'Point 03' },
    { index: 7, key: 'comparison', label: 'Comparison' },
    { index: 8, key: 'detail', label: 'Detail' },
    { index: 9, key: 'color_size', label: 'Color & Size' },
    { index: 10, key: 'product_info', label: 'Product Info' },
  ]);

  first[0].label = 'changed by caller';
  assert.equal(second[0].label, 'Hero');
  assert.equal(DETAIL_PAGE_SECTIONS[0].label, 'Hero');
});

test('draft 64 detail context uses the current revision-one ten-section snapshot', async () => {
  const context = await getManualDetailWorkflowContext(detailContextDb(), 64);
  assert.equal(context.request.id, 8);
  assert.equal(context.request.revision, 1);
  assert.equal(context.request.state, 'current');
  assert.deepEqual(context.sections.map((section) => section.key), [
    'hero', 'review', 'core_values', 'point_01', 'point_02',
    'point_03', 'comparison', 'detail', 'color_size', 'product_info',
  ]);
  assert.equal(context.sections.length, 10);
});

test('detail context reports a stale prompt when the active template version advances', async () => {
  const context = await getManualDetailWorkflowContext(
    detailContextDb({ activeTemplateVersion: 2 }),
    64,
  );

  assert.equal(context.request.revision, 1);
  assert.equal(context.request.state, 'stale_template_version');
});

test('detail context falls back to the raw source main image when no manual result is approved', async () => {
  const context = await getManualDetailWorkflowContext(detailContextDb(), 64);
  assert.equal(context.mainImage.url, '/original-images/main.jpg');
  assert.equal(context.mainImage.approved, undefined);
  assert.equal(context.rawMainImage.url, '/original-images/main.jpg');
});

test('detail context prefers the approved manual main image while keeping the raw original for provenance', async () => {
  const context = await getManualDetailWorkflowContext(detailContextDb({
    approvedMainImageRow: {
      id: 9,
      product_draft_id: 64,
      task_type: 'main_image',
      status: 'approved',
      coupang_stored_url: '/generated-ai-images/drafts/64/main/manual/r1-v2/manual-r2-v2-coupang-1000x1000.jpg',
      coupang_mime_type: 'image/jpeg',
      coupang_file_size: 500_000,
      width: 1000,
      height: 1000,
    },
  }), 64);

  assert.equal(context.mainImage.url, '/generated-ai-images/drafts/64/main/manual/r1-v2/manual-r2-v2-coupang-1000x1000.jpg');
  assert.equal(context.mainImage.approved, true);
  assert.equal(context.rawMainImage.url, '/original-images/main.jpg');
});

test('detail context prefers local source-full assets and de-duplicates all selected URLs', async () => {
  const context = await getManualDetailWorkflowContext(detailContextDb(), 64);

  assert.equal(context.mainImage.url, '/original-images/main.jpg');
  assert.equal(context.detailImages[0].url, '/original-images/detail-source-full.jpg');
  assert.ok(context.detailImages.length > 0);
  assert.ok(context.referenceImages.length > 0);
  assert.ok(context.detailImages.some((asset) => asset.url === 'https://supplier.test/request-only.jpg'));
  assert.deepEqual(context.referenceImages.map((asset) => asset.url), [
    'https://reference.test/competitor.jpg',
  ]);

  const urls = [
    context.mainImage,
    ...context.detailImages,
    ...context.referenceImages,
  ].map((asset) => asset.url);
  assert.equal(new Set(urls).size, urls.length);
});
