import assert from 'node:assert/strict';
import test from 'node:test';

import { mapCarrierCodeToCoupang, isKnownCarrierCode } from '../src/carrier-code-map.mjs';

test('mapCarrierCodeToCoupang passes through a known carrier code unchanged (confirmed: HYUNDAI = 롯데택배 on a real order)', () => {
  assert.equal(mapCarrierCodeToCoupang('HYUNDAI'), 'HYUNDAI');
  assert.equal(mapCarrierCodeToCoupang('CJGLS'), 'CJGLS');
});

test('mapCarrierCodeToCoupang is case-insensitive and trims whitespace', () => {
  assert.equal(mapCarrierCodeToCoupang(' hyundai '), 'HYUNDAI');
});

test('mapCarrierCodeToCoupang blocks (returns null) rather than guessing at an unrecognized or missing code', () => {
  assert.equal(mapCarrierCodeToCoupang('SOME_NEW_CARRIER'), null);
  assert.equal(mapCarrierCodeToCoupang(''), null);
  assert.equal(mapCarrierCodeToCoupang(null), null);
  assert.equal(mapCarrierCodeToCoupang(undefined), null);
});

test('isKnownCarrierCode mirrors mapCarrierCodeToCoupang as a boolean', () => {
  assert.equal(isKnownCarrierCode('HANJIN'), true);
  assert.equal(isKnownCarrierCode('UNKNOWN'), false);
});
