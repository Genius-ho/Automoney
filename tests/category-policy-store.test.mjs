import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getRecentlySelectedCategoryIds,
  listActiveCategoryPolicies,
  recordCategorySelections,
} from '../src/category-policy-store.mjs';

test('listActiveCategoryPolicies only queries is_active=true and maps rows to camelCase', async () => {
  let capturedSql = null;
  const db = {
    async query(sql) {
      capturedSql = sql;
      return { rows: [{ id: '1', segment_name: '생활/수납', category_name: '정리함/수납함', search_keywords: ['수납정리함'], domeggook_category_code: null, is_active: true, notes: null, created_at: '2026-01-01' }] };
    },
  };
  const [policy] = await listActiveCategoryPolicies(db);
  assert.match(capturedSql, /where is_active = true/);
  assert.deepEqual(policy, {
    id: 1,
    segmentName: '생활/수납',
    categoryName: '정리함/수납함',
    searchKeywords: ['수납정리함'],
    domeggookCategoryCode: null,
    isActive: true,
    notes: null,
    createdAt: '2026-01-01',
  });
});

test('getRecentlySelectedCategoryIds queries within the given day window and returns numeric ids', async () => {
  let capturedParams = null;
  const db = {
    async query(sql, params) {
      capturedParams = params;
      return { rows: [{ category_policy_id: '3' }, { category_policy_id: '7' }] };
    },
  };
  const ids = await getRecentlySelectedCategoryIds(db, { withinDays: 30 });
  assert.deepEqual(capturedParams, ['30']);
  assert.deepEqual(ids, [3, 7]);
});

test('recordCategorySelections inserts one row per category id', async () => {
  const inserted = [];
  const db = {
    async query(sql, params) {
      inserted.push(params);
      return { rows: [] };
    },
  };
  await recordCategorySelections(db, 5, [1, 2, 3]);
  assert.deepEqual(inserted, [[5, 1], [5, 2], [5, 3]]);
});
