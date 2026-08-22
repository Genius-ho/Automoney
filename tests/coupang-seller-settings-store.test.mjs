import assert from 'node:assert/strict';
import test from 'node:test';

import { getSellerShippingSettings, saveSellerShippingSettings } from '../src/coupang-seller-settings-store.mjs';

test('getSellerShippingSettings returns all-null settings (not a throw) when the single row is somehow missing', async () => {
  const db = { async query() { return { rows: [] }; } };
  const settings = await getSellerShippingSettings(db);
  assert.equal(settings.outboundShippingPlaceCode, undefined);
  assert.equal(settings.returnCenterCode, undefined);
});

test('getSellerShippingSettings maps the stored row to camelCase', async () => {
  const db = {
    async query() {
      return {
        rows: [{
          outbound_shipping_place_code: '24466172',
          outbound_shipping_place_name: '행당',
          return_center_code: '1002401151',
          return_center_name: '반품지1 ',
          confirmed_at: '2026-07-20T00:00:00.000Z',
          updated_at: '2026-07-20T00:00:00.000Z',
        }],
      };
    },
  };
  const settings = await getSellerShippingSettings(db);
  assert.equal(settings.outboundShippingPlaceCode, '24466172');
  assert.equal(settings.returnCenterCode, '1002401151');
});

test('saveSellerShippingSettings requires both codes', async () => {
  const db = { async query() { throw new Error('should not query'); } };
  await assert.rejects(() => saveSellerShippingSettings(db, { outboundShippingPlaceCode: null, returnCenterCode: '1' }));
  await assert.rejects(() => saveSellerShippingSettings(db, { outboundShippingPlaceCode: '1', returnCenterCode: null }));
});

test('saveSellerShippingSettings upserts the single row and stamps confirmed_at, storing codes as text (not matched by name)', async () => {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [{ outbound_shipping_place_code: params[0], outbound_shipping_place_name: params[1], return_center_code: params[2], return_center_name: params[3], confirmed_at: 'now', updated_at: 'now' }] };
    },
  };
  const result = await saveSellerShippingSettings(db, {
    outboundShippingPlaceCode: 24466172, outboundShippingPlaceName: '행당',
    returnCenterCode: 1002401151, returnCenterName: '반품지1 ',
  });
  assert.match(calls[0].sql, /insert into coupang_seller_settings/);
  assert.match(calls[0].sql, /on conflict \(id\) do update/);
  assert.equal(calls[0].params[0], '24466172');
  assert.equal(calls[0].params[2], '1002401151');
  assert.equal(result.outboundShippingPlaceCode, '24466172');
  assert.equal(result.returnCenterCode, '1002401151');
});
