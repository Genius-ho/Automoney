import assert from 'node:assert/strict';
import test from 'node:test';

import {
  exportProductDraft,
  shouldOverwriteOptimizedTitles,
  shouldCreateGeneratedDetailHtml,
  listProductDrafts,
  setProductDraftStatus,
  upsertMarketResearch,
  updateProductDraft,
} from '../src/admin-store.mjs';

test('registration optimization preserves an existing generated detail page', () => {
  assert.equal(shouldCreateGeneratedDetailHtml('<section>existing reviewed detail</section>'), false);
});

test('registration optimization creates a detail page only when it is empty', () => {
  assert.equal(shouldCreateGeneratedDetailHtml(null), true);
  assert.equal(shouldCreateGeneratedDetailHtml('   '), true);
});

test('SEO analysis preserves manually saved optimized titles until explicit regeneration', () => {
  assert.equal(shouldOverwriteOptimizedTitles('manual coupang title', 'manual naver title', false), false);
  assert.equal(shouldOverwriteOptimizedTitles('', null, false), true);
  assert.equal(shouldOverwriteOptimizedTitles('manual coupang title', 'manual naver title', true), true);
});

test('listProductDrafts returns joined draft rows and supports status filtering', async () => {
  const calls = [];
  const db = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      return {
        rows: [
          {
            id: 1,
            supplier_product_no: '49168396',
            raw_name: 'raw name',
            cleaned_name: 'clean name',
            selling_title: 'selling title',
            cost: 10000,
            shipping_fee: 3000,
            min_order_qty: 1,
            order_unit: 1,
            supplier_product_url: 'https://domeggook.com/main/item/itemView.php?no=49168396&market=dome',
            coupang_sale_price: 18000,
            naver_sale_price: 17000,
            naver_expected_profit: 3500,
            filter_status: 'needs_review',
            block_reasons: [],
            review_reasons: ['risk_keyword'],
            status: 'needs_review',
            final_decision: '등록후보',
            import_batch_id: 'batch-1',
            collected_at: '2026-07-10T00:00:00.000Z',
            updated_at: '2026-07-10T00:00:00.000Z',
            naver_winner_score: 75,
            naver_winner_status: 'candidate',
            source_market: 'domeme',
            domeggook_title: 'original title',
            product_name: null,
          },
        ],
      };
    },
  };

  const drafts = await listProductDrafts(db, {
    status: 'needs_review',
    importBatchId: 'batch-1',
    collectedOnly: true,
    naverWinnerStatus: 'candidate',
    finalDecision: '등록후보',
  });

  assert.equal(calls[0].params[0], 'needs_review');
  assert.equal(calls[0].params[1], 'batch-1');
  assert.equal(calls[0].params[2], 'candidate');
  assert.equal(calls[0].params[3], '등록후보');
  assert.ok(calls[0].sql.includes('d.collected_at is not null'));
  assert.ok(calls[0].sql.includes('nmr.winner_status'));
  assert.ok(calls[0].sql.includes('final_decision'));
  assert.ok(calls[0].sql.includes('nmr.winner_score desc nulls last'));
  assert.equal(drafts[0].id, 1);
  assert.equal(drafts[0].originalProductName, 'original title');
  assert.equal(drafts[0].supplierProductNo, '49168396');
  assert.equal(drafts[0].supplierMarket, 'domeme');
  assert.equal(drafts[0].minOrderQty, 1);
  assert.equal(drafts[0].orderUnit, 1);
  assert.equal(drafts[0].importBatchId, 'batch-1');
  assert.equal(drafts[0].finalDecision, '등록후보');
});

test('updateProductDraft patches editable admin fields', async () => {
  const calls = [];
  const db = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('select block_reasons')) return { rows: [{ block_reasons: [] }] };
      if (sql.includes('update product_drafts')) return { rows: [{ id: 1 }] };
      if (sql.includes('from product_drafts d') && sql.includes('where d.id = $1')) {
        return {
          rows: [
            {
              id: 1,
              supplier_product_id: 10,
              supplier_product_no: '49168396',
              raw_name: 'raw',
              cleaned_name: 'clean',
              selling_title: params[0] || 'edited',
              cost: 10000,
              shipping_fee: 3000,
              min_order_qty: 1,
              order_unit: 1,
              supplier_product_url: 'https://domeggook.com/main/item/itemView.php?no=49168396&market=dome',
              raw_price_field_name: 'price.supply',
              raw_price_value: '10000',
              price_parse_status: 'ok',
              shipping_raw_field_name: 'deli.supply.fee',
              shipping_raw_value: '3000',
              shipping_parse_status: 'ok',
              price_tiers: [],
              shipping_tiers: [],
              min_order_qty: null,
              coupang_sale_price: 19000,
              coupang_expected_profit: 3000,
              coupang_margin_rate: 0.16,
              naver_sale_price: 18000,
              naver_expected_profit: 3000,
              naver_margin_rate: 0.17,
              filter_status: 'pass',
              block_reasons: [],
              review_reasons: [],
              status: 'needs_review',
              source_market: 'domeme',
              generated_detail_html: '<p>edited</p>',
              draft_html: '<p>draft</p>',
              review_memo: 'memo',
              original_detail_html: '<p>source</p>',
              domeggook_title: 'original',
              product_name: null,
            },
          ],
        };
      }
      return { rows: [] };
    },
  };

  const draft = await updateProductDraft(db, 1, {
    sellingTitle: 'edited',
    coupangSalePrice: 19000,
    naverSalePrice: 18000,
    generatedDetailHtml: '<p>edited</p>',
    reviewMemo: 'memo',
    status: 'needs_review',
  });

  const updateCall = calls.find((call) => call.sql.includes('update product_drafts'));
  assert.ok(updateCall.sql.includes('selling_title = $1'));
  assert.ok(updateCall.sql.includes('generated_detail_html = $4'));
  assert.equal(updateCall.params.at(-1), 1);
  assert.equal(draft.status, 'needs_review');
});

test('updateProductDraft requires overrideReason to approve drafts with block reasons', async () => {
  const db = {
    async query(sql) {
      if (sql.includes('select block_reasons')) return { rows: [{ block_reasons: ['risk_keyword'] }] };
      return { rows: [] };
    },
  };

  await assert.rejects(
    () => updateProductDraft(db, 1, { status: 'approved' }),
    /overrideReason is required/,
  );
});

test('updateProductDraft allows forced approval when overrideReason is present', async () => {
  const calls = [];
  const db = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('select block_reasons')) return { rows: [{ block_reasons: ['risk_keyword'] }] };
      if (sql.includes('from product_registration_checks')) {
        return {
          rows: [
            {
              product_draft_id: 1,
              supplier_link_checked: true,
              naver_lowest_same_item_checked: true,
              title_checked: true,
              detail_checked: true,
              category_checked: true,
              notice_checked: true,
              shipping_policy_checked: true,
              export_json_checked: true,
              override_reason: 'manual review complete',
            },
          ],
        };
      }
      if (sql.includes('update product_drafts')) return { rows: [{ id: 1 }] };
      if (sql.includes('from product_drafts d')) {
        return {
          rows: [
            {
              id: 1,
              supplier_product_id: 10,
              supplier_product_no: '49168396',
              status: 'approved',
              filter_status: 'blocked',
              block_reasons: ['risk_keyword'],
              review_reasons: [],
              min_order_qty: 1,
              order_unit: 1,
              source_market: 'domeme',
              price_tiers: [],
              shipping_tiers: [],
            },
          ],
        };
      }
      return { rows: [] };
    },
  };

  const draft = await updateProductDraft(db, 1, { status: 'approved', overrideReason: 'manual review complete' });

  assert.equal(draft.status, 'approved');
  assert.deepEqual(draft.warnings, ['approved_with_block_reasons']);
  assert.ok(calls.some((call) => call.sql.includes('status = $1')));
});

test('setProductDraftStatus validates and updates status', async () => {
  const calls = [];
  const db = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('update product_drafts')) return { rows: [{ id: 1 }] };
      if (sql.includes('from product_drafts d')) {
        return {
          rows: [
            {
              id: 1,
              supplier_product_id: 10,
              supplier_product_no: '49168396',
              status: 'blocked',
              filter_status: 'blocked',
              block_reasons: [],
              review_reasons: [],
              price_tiers: [],
              shipping_tiers: [],
            },
          ],
        };
      }
      return { rows: [] };
    },
  };

  await setProductDraftStatus(db, 1, 'blocked');

  assert.ok(calls[0].sql.includes('status = $1'));
  assert.equal(calls[0].params[0], 'blocked');
});

test('exportProductDraft returns channel specific preview JSON', async () => {
  const db = {
    async query(sql) {
      if (sql.includes('from product_drafts d')) {
        return {
          rows: [
            {
              id: 1,
              supplier_product_id: 10,
              supplier_product_no: '49168396',
              raw_name: 'raw',
              cleaned_name: 'clean',
              selling_title: 'selling',
              cost: 10000,
              shipping_fee: 3000,
              min_order_qty: 2,
              order_unit: 1,
              supplier_product_url: 'https://domeggook.com/main/item/itemView.php?no=49168396&market=dome',
              coupang_sale_price: 19000,
              coupang_expected_profit: 3000,
              naver_sale_price: 18000,
              naver_expected_profit: 3000,
              filter_status: 'blocked',
              block_reasons: ['blocked_low_margin'],
              review_reasons: [],
              status: 'blocked',
              source_market: 'domeme',
              generated_detail_html: '<p>detail</p>',
              price_tiers: [],
              shipping_tiers: [],
            },
          ],
        };
      }
      if (sql.includes('from product_images')) return { rows: [{ id: 1, image_index: 0, url: 'https://example.test/a.jpg' }] };
      if (sql.includes('from product_options')) {
        return { rows: [{ id: 1, option_index: 0, name: 'color', value: 'black', additional_price: 0, raw_json: {} }] };
      }
      return { rows: [] };
    },
  };

  const coupang = await exportProductDraft(db, 1, 'coupang');
  const naver = await exportProductDraft(db, 1, 'naver');

  assert.equal(coupang.channel, 'coupang');
  assert.equal(coupang.sellerProductName, 'selling');
  assert.equal(coupang.supplierMarket, 'domeme');
  assert.equal(coupang.minOrderQty, 2);
  assert.equal(coupang.orderUnit, 1);
  assert.equal(coupang.supplierProductUrl, 'https://domeggook.com/main/item/itemView.php?no=49168396&market=dome');
  assert.equal(coupang.exportBlocked, true);
  assert.deepEqual(coupang.blockedReasons, ['blocked_low_margin']);
  assert.equal(naver.channel, 'naver');
  assert.equal(naver.name, 'selling');
  assert.equal(naver.supplierMarket, 'domeme');
  assert.equal(naver.minOrderQty, 2);
  assert.equal(naver.exportBlocked, true);
  assert.deepEqual(naver.blockedReasons, ['blocked_low_margin']);
});

test('exports prefer only the approved Coupang-safe manual main image', async () => {
  const db={async query(sql){
    if(sql.includes('from product_drafts d'))return{rows:[{id:64,supplier_product_id:10,supplier_product_no:'64',raw_name:'raw',selling_title:'selling',cost:1,shipping_fee:0,min_order_qty:1,order_unit:1,coupang_sale_price:2,naver_sale_price:2,filter_status:'pass',block_reasons:[],review_reasons:[],status:'draft',generated_detail_html:'<p>same</p>',price_tiers:[],shipping_tiers:[]}]};
    if(sql.includes('from product_images'))return{rows:[{id:1,image_index:0,image_type:'main',url:'https://source.test/original.jpg',stored_url:'https://source.test/original.jpg'}]};
    if(sql.includes('from product_options'))return{rows:[]};
    if(sql.includes("from generated_ai_images")&&sql.includes("status='approved'"))return{rows:[{id:7,product_draft_id:64,prompt_request_id:91,prompt_revision:2,task_type:'main_image',workflow_mode:'manual_external_ai',provider_code:'chatgpt',version:2,original_stored_url:'/generated-ai-images/original.webp',coupang_stored_url:'/generated-ai-images/drafts/64/main/manual/approved.jpg',original_file_size:100,coupang_file_size:2000000,original_mime_type:'image/webp',coupang_mime_type:'image/jpeg',original_width:1200,original_height:1200,width:1000,height:1000,sha256:'abc',status:'approved'}]};
    return{rows:[]};
  }};
  const coupang=await exportProductDraft(db,64,'coupang');const naver=await exportProductDraft(db,64,'naver');
  assert.equal(coupang.mainImages[0],'/generated-ai-images/drafts/64/main/manual/approved.jpg');
  assert.equal(naver.mainImages[0],'/generated-ai-images/drafts/64/main/manual/approved.jpg');
  assert.ok(!coupang.mainImages.includes('/generated-ai-images/original.webp'));
});

test('Naver export keeps explicitly typed legacy detail images in stored order', async () => {
  const db = {
    async query(sql) {
      if (sql.includes('from product_drafts d')) {
        return {
          rows: [{
            id: 8,
            supplier_product_id: 10,
            supplier_product_no: '8',
            raw_name: 'raw',
            selling_title: 'selling',
            status: 'draft',
            filter_status: 'pass',
            block_reasons: [],
            review_reasons: [],
            generated_detail_html: '<p>detail</p>',
            price_tiers: [],
            shipping_tiers: [],
          }],
        };
      }
      if (sql.includes('from product_images')) {
        return {
          rows: [
            { id: 1, image_index: 0, image_type: 'main', sort_order: 0, url: 'https://source.test/main.jpg', stored_url: 'https://stored.test/main.jpg', source_section: 'unknown' },
            { id: 2, image_index: 1, image_type: 'detail', sort_order: 2, url: 'https://source.test/detail-2.jpg', stored_url: 'https://stored.test/detail-2.jpg', source_section: 'unknown' },
            { id: 3, image_index: 2, image_type: 'detail_slice', sort_order: 4, url: 'https://source.test/slice-2.jpg', stored_url: 'https://stored.test/slice-2.jpg', source_section: 'unknown' },
            { id: 4, image_index: 3, image_type: 'thumbnail', sort_order: 5, url: 'https://source.test/other.jpg', stored_url: 'https://stored.test/other.jpg', source_section: 'unknown' },
            { id: 5, image_index: 4, image_type: 'detail', sort_order: 1, url: 'https://source.test/detail-1.jpg', stored_url: 'https://stored.test/detail-1.jpg', source_section: 'detail' },
            { id: 6, image_index: 5, image_type: 'detail_slice', sort_order: 3, url: 'https://source.test/slice-1.jpg', stored_url: 'https://stored.test/slice-1.jpg', source_section: null },
          ],
        };
      }
      if (sql.includes('from product_options')) return { rows: [] };
      return { rows: [] };
    },
  };

  const naver = await exportProductDraft(db, 8, 'naver');

  assert.deepEqual(naver.mainImages, ['https://stored.test/main.jpg']);
  assert.deepEqual(naver.detailImages, [
    'https://stored.test/detail-1.jpg',
    'https://stored.test/detail-2.jpg',
  ]);
  assert.deepEqual(naver.detailSliceImages, [
    'https://stored.test/slice-1.jpg',
    'https://stored.test/slice-2.jpg',
  ]);
  assert.ok(!naver.detailImages.includes('https://stored.test/other.jpg'));
  assert.ok(!naver.detailSliceImages.includes('https://stored.test/other.jpg'));
});

test('upsertMarketResearch calculates and stores winner result', async () => {
  const calls = [];
  const db = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('from product_drafts d')) {
        return {
          rows: [
            {
              id: 1,
              supplier_product_id: 10,
              supplier_product_no: '49168396',
              selling_title: 'selling',
              coupang_sale_price: 10000,
              coupang_expected_profit: 3500,
              min_order_qty: 1,
              order_unit: 1,
              source_market: 'domeme',
              filter_status: 'pass',
              block_reasons: [],
              review_reasons: [],
              status: 'draft',
              price_tiers: [],
              shipping_tiers: [],
            },
          ],
        };
      }
      if (sql.includes('insert into market_research_results')) {
        return {
          rows: [
            {
              id: 7,
              product_draft_id: 1,
              marketplace: 'coupang',
              keyword: params[2],
              my_sale_price: params[3],
              lowest_price: params[4],
              top_price_avg: params[5],
              competitor_count: params[6],
              rocket_exists: params[7],
              max_review_count: params[8],
              avg_rating: params[9],
              price_gap_rate: params[10],
              winner_score: params[11],
              winner_status: params[12],
              reasons: JSON.parse(params[13]),
              raw_json: JSON.parse(params[14]),
              checked_at: '2026-07-10T00:00:00.000Z',
              created_at: '2026-07-10T00:00:00.000Z',
              updated_at: '2026-07-10T00:00:00.000Z',
            },
          ],
        };
      }
      return { rows: [] };
    },
  };

  const research = await upsertMarketResearch(db, 1, 'coupang', {
    keyword: 'storage',
    lowestPrice: 10000,
    topPriceAvg: 12000,
    competitorCount: 10,
    rocketExists: false,
    maxReviewCount: 50,
    avgRating: 4.5,
  });

  assert.equal(research.winnerStatus, 'strong_candidate');
  assert.equal(research.winnerScore, 140);
  assert.equal(research.priceGapRate, 0);
});
