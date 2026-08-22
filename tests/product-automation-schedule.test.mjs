import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PRODUCT_STAGE_SLOTS,
  koreaServiceDate,
  nextDailySlot,
  selectOldestDueStage,
  slotForServiceDate,
} from '../src/product-automation-schedule.mjs';

test('Korea service dates cross the UTC boundary at 15:00', () => {
  assert.equal(koreaServiceDate(new Date('2026-08-10T14:59:59Z')), '2026-08-10');
  assert.equal(koreaServiceDate(new Date('2026-08-10T15:00:00Z')), '2026-08-11');
});

test('fixed stage slots map to exact Korea hours', () => {
  assert.deepEqual(PRODUCT_STAGE_SLOTS, { draft: 7, analysis: 8, images: 9, imageQa: 11, discovery: 10 });
  assert.equal(slotForServiceDate('2026-08-11', 7).toISOString(), '2026-08-10T22:00:00.000Z');
  assert.equal(slotForServiceDate('2026-08-11', 10).toISOString(), '2026-08-11T01:00:00.000Z');
  assert.equal(nextDailySlot(new Date('2026-08-10T21:00:00Z'), 7).toISOString(), '2026-08-10T22:00:00.000Z');
  assert.equal(nextDailySlot(new Date('2026-08-10T22:00:01Z'), 7).toISOString(), '2026-08-11T22:00:00.000Z');
});

test('late startup selects only the oldest due stage', () => {
  const state = {
    draftNextRunAt: '2026-08-10T22:00:00Z',
    analysisNextRunAt: '2026-08-10T23:00:00Z',
    imagesNextRunAt: '2026-08-11T00:00:00Z',
    discoveryNextRunAt: '2026-08-11T01:00:00Z',
  };
  assert.deepEqual(
    selectOldestDueStage(state, new Date('2026-08-11T01:30:00Z')),
    { stage: 'draft', serviceDate: '2026-08-11', dueAt: new Date('2026-08-10T22:00:00Z') },
  );
});

test('imageQa is selected like any other daily stage when its own qaNextRunAt is due', () => {
  const state = {
    qaNextRunAt: '2026-08-11T02:00:00Z',
    draftNextRunAt: '2026-08-11T22:00:00Z',
  };
  assert.deepEqual(
    selectOldestDueStage(state, new Date('2026-08-11T03:00:00Z')),
    { stage: 'imageQa', serviceDate: '2026-08-11', dueAt: new Date('2026-08-11T02:00:00Z') },
  );
});

test('a stage completed on the Korea service date is not selected twice', () => {
  const state = {
    draftNextRunAt: '2026-08-10T22:00:00Z',
    draftLastServiceDate: '2026-08-11',
    analysisNextRunAt: '2026-08-11T23:00:00Z',
    imagesNextRunAt: '2026-08-12T00:00:00Z',
    discoveryNextRunAt: '2026-08-13T01:00:00Z',
  };
  assert.equal(selectOldestDueStage(state, new Date('2026-08-10T23:00:00Z')), null);
});
