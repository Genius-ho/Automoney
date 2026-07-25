import assert from 'node:assert/strict';
import test from 'node:test';

import { isChannelOrderCancelled } from '../src/channel-order-status.mjs';

test('isChannelOrderCancelled is true when cancelledAt is set', () => {
  assert.equal(isChannelOrderCancelled({ cancelledAt: '2026-07-26T00:00:00Z', orderStatus: 'ACCEPT' }), true);
});

test('isChannelOrderCancelled is true when orderStatus text mentions CANCEL or 취소', () => {
  assert.equal(isChannelOrderCancelled({ orderStatus: 'CANCELLED' }), true);
  assert.equal(isChannelOrderCancelled({ orderStatus: '구매취소' }), true);
});

test('isChannelOrderCancelled is false for a normal active order', () => {
  assert.equal(isChannelOrderCancelled({ orderStatus: 'ACCEPT', cancelledAt: null }), false);
});

test('isChannelOrderCancelled tolerates a missing/undefined channel order', () => {
  assert.equal(isChannelOrderCancelled({}), false);
  assert.equal(isChannelOrderCancelled(undefined), false);
});
