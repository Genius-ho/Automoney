// Throwaway one-off: fixes up the accidentally-created placeholder listing
// (sellerProductId 16322995173) with the real final values, dropping the
// '수량' mandatory attribute -- confirmed live (2026-07-28) that Coupang
// rejects it outright ("유효하지 않은 구매 옵션 값 혹은 단위가 존재합니다") no
// matter the value or unit, despite category-metadata advertising it as
// MANDATORY. Then records the registration locally so it's tracked.
import { createPgPool } from '../src/postgres-store.mjs';
import { loadDatabaseUrl, loadCoupangConfig } from '../src/config.mjs';
import { buildRegistrationPreview } from '../src/coupang-registration-flow.mjs';
import { CoupangClient } from '../src/coupang-client.mjs';
import { recordDirectRegistration } from '../src/coupang-registration-store.mjs';
import { createHash } from 'node:crypto';

const rootDir = process.cwd();
const draftId = 31;
const sellerProductId = 16322995173;
const sellerProductItemId = 38281814291;

const databaseUrl = await loadDatabaseUrl(rootDir);
const db = await createPgPool(databaseUrl);
const coupangConfig = await loadCoupangConfig(rootDir);
const client = new CoupangClient(coupangConfig);

const preview = await buildRegistrationPreview(db, rootDir, draftId, {
  mode: 'raw',
  overrides: {
    material: '스테인리스',
    sizeAttributeValue: '27.5x23x6cm',
    stockByOptionValue: { '2열 와인잔걸이': 999 },
    noticeContentOverrides: {
      재질: '스테인리스',
      구성품: '와인랙 본체, 육각렌치, 논슬립 패드',
      출시년월: '상세페이지 참조',
      '수입신고 문구 여부': '해당사항없음',
    },
  },
  coupangConfig,
});

const payload = preview.payload;
payload.sellerProductId = sellerProductId;
payload.items[0].sellerProductItemId = sellerProductItemId;
payload.items[0].attributes = payload.items[0].attributes.filter((a) => a.attributeTypeName !== '수량');

const result = await client.updateProduct(payload);
console.log('update result:', JSON.stringify(result));

const after = await client.getProduct(sellerProductId);
console.log('after items[0].attributes:', JSON.stringify(after.data.items[0].attributes));
console.log('after items[0].itemName:', after.data.items[0].itemName);

const requestHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
const registration = await recordDirectRegistration(db, draftId, {
  sellerProductId,
  sellerProductName: payload.sellerProductName,
  requestHash,
});
console.log('local registration record:', JSON.stringify(registration));

await db.end();
