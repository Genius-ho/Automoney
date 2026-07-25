import assert from 'node:assert/strict';
import test from 'node:test';

import { mapCarrierCode, isKnownCarrierCode } from '../src/carrier-code-map.mjs';

test('mapCarrierCode passes through a known carrier code unchanged (confirmed: HYUNDAI = 롯데택배 on a real 도매매 order, and matches both Coupang\'s and Naver\'s own published tables)', () => {
  assert.equal(mapCarrierCode('HYUNDAI'), 'HYUNDAI');
  assert.equal(mapCarrierCode('CJGLS'), 'CJGLS');
});

test('mapCarrierCode is case-insensitive and trims whitespace', () => {
  assert.equal(mapCarrierCode(' hyundai '), 'HYUNDAI');
});

test('mapCarrierCode blocks (returns null) rather than guessing at an unrecognized or missing code', () => {
  assert.equal(mapCarrierCode('SOME_NEW_CARRIER'), null);
  assert.equal(mapCarrierCode(''), null);
  assert.equal(mapCarrierCode(null), null);
  assert.equal(mapCarrierCode(undefined), null);
});

test('isKnownCarrierCode mirrors mapCarrierCode as a boolean', () => {
  assert.equal(isKnownCarrierCode('HANJIN'), true);
  assert.equal(isKnownCarrierCode('UNKNOWN'), false);
});
