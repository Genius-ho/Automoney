import assert from 'node:assert/strict';
import test from 'node:test';

import { CoupangCategoryAdapter, createCoupangCategoryAdapter } from '../src/coupang-category-adapter.mjs';

function fakeClient({ prediction, meta }) {
  return {
    async predictCategory(productName) {
      this.lastProductName = productName;
      return prediction;
    },
    async getCategoryMeta(displayCategoryCode) {
      this.lastDisplayCategoryCode = displayCategoryCode;
      return meta;
    },
  };
}

test('predictCategory normalizes the documented Coupang response shape and keeps the raw payload', async () => {
  const client = fakeClient({
    prediction: { data: { predictedCategoryId: 71691, predictedCategoryName: '쥬얼리박스/보석함', autoCategorizationPredictionResultType: 'SUCCESS' } },
    meta: null,
  });
  const adapter = new CoupangCategoryAdapter(client);

  const result = await adapter.predictCategory('악세사리 주얼리함 보석함 수납함');

  assert.equal(client.lastProductName, '악세사리 주얼리함 보석함 수납함');
  assert.equal(result.displayCategoryCode, 71691);
  assert.equal(result.categoryName, '쥬얼리박스/보석함');
  assert.equal(result.predictionResultType, 'SUCCESS');
  assert.deepEqual(result.raw, { data: { predictedCategoryId: 71691, predictedCategoryName: '쥬얼리박스/보석함', autoCategorizationPredictionResultType: 'SUCCESS' } });
});

test('predictCategory falls back to null fields (not a throw) when the response shape is unrecognized', async () => {
  const client = fakeClient({ prediction: { unexpected: true }, meta: null });
  const adapter = createCoupangCategoryAdapter(client);

  const result = await adapter.predictCategory('x');

  assert.equal(result.displayCategoryCode, null);
  assert.equal(result.categoryName, null);
  assert.deepEqual(result.raw, { unexpected: true });
});

// Fixture mirrors the real "category-related-metas" response shape observed
// from the live API for displayCategoryCode=71691 (쥬얼리박스/보석함).
function realCategoryMetaFixture() {
  return {
    code: 'SUCCESS',
    message: '',
    data: {
      isAllowSingleItem: true,
      attributes: [
        { attributeTypeName: '색상', dataType: 'STRING', inputType: 'INPUT', inputValues: [], required: 'MANDATORY', groupNumber: 'NONE', exposed: 'EXPOSED' },
        { attributeTypeName: '주얼리 사이즈', dataType: 'STRING', inputType: 'INPUT', inputValues: [], required: 'MANDATORY', groupNumber: 'NONE', exposed: 'NONE' },
        { attributeTypeName: '출시 계절', dataType: 'STRING', inputType: 'SELECT', inputValues: ['가을', '겨울', '봄', '여름'], required: 'OPTIONAL', groupNumber: 'NONE', exposed: 'NONE' },
      ],
      noticeCategories: [
        {
          noticeCategoryName: '패션잡화(모자/벨트/액세서리 등)',
          noticeCategoryDetailNames: [
            { noticeCategoryDetailName: '종류', required: 'MANDATORY' },
            { noticeCategoryDetailName: '제조자(수입자)', required: 'MANDATORY' },
            { noticeCategoryDetailName: '제조국', required: 'MANDATORY' },
            { noticeCategoryDetailName: 'A/S 책임자와 전화번호', required: 'MANDATORY' },
          ],
        },
        {
          noticeCategoryName: '기타 재화',
          noticeCategoryDetailNames: [
            { noticeCategoryDetailName: '품명 및 모델명', required: 'MANDATORY' },
          ],
        },
      ],
      requiredDocumentNames: [
        { templateName: '기타인증서류', required: 'OPTIONAL' },
        { templateName: '수입신고필증(병행수입 선택시)', required: 'MANDATORY_PARALLEL_IMPORTED' },
      ],
      certifications: [
        { certificationType: 'NOT_REQUIRED', name: '인증대상아님', dataType: 'NONE', required: 'OPTIONAL' },
        { certificationType: 'KC_KID_CERTIFICATION', name: 'KC인증 어린이제품 안전인증', dataType: 'CODE', required: 'OPTIONAL' },
      ],
      allowedOfferConditions: ['NEW'],
    },
  };
}

test('getCategoryMeta separates mandatory purchase options from optional ones', async () => {
  const client = fakeClient({ prediction: null, meta: realCategoryMetaFixture() });
  const adapter = new CoupangCategoryAdapter(client);

  const result = await adapter.getCategoryMeta(71691);

  assert.equal(client.lastDisplayCategoryCode, 71691);
  assert.equal(result.attributes.length, 3);
  assert.deepEqual(result.mandatoryOptionNames, ['색상', '주얼리 사이즈']);
});

test('getCategoryMeta keeps notice categories as selectable templates, not a flat requirement list', async () => {
  const client = fakeClient({ prediction: null, meta: realCategoryMetaFixture() });
  const adapter = new CoupangCategoryAdapter(client);

  const result = await adapter.getCategoryMeta(71691);

  assert.equal(result.noticeCategoryTemplates.length, 2);
  const fashionTemplate = result.noticeCategoryTemplates.find((template) => template.noticeCategoryName === '패션잡화(모자/벨트/액세서리 등)');
  assert.equal(fashionTemplate.noticeCategoryDetailNames.length, 4);
  assert.ok(fashionTemplate.noticeCategoryDetailNames.some((detail) => detail.noticeCategoryDetailName === '제조국'));
});

test('getCategoryMeta reports zero mandatory certifications when every certification entry is OPTIONAL', async () => {
  const client = fakeClient({ prediction: null, meta: realCategoryMetaFixture() });
  const adapter = new CoupangCategoryAdapter(client);

  const result = await adapter.getCategoryMeta(71691);

  assert.equal(result.certifications.length, 2);
  assert.deepEqual(result.mandatoryCertificationNames, []);
  assert.deepEqual(result.allowedOfferConditions, ['NEW']);
});

test('getCategoryMeta never throws on an entirely unexpected shape, it just returns empty lists', async () => {
  const client = fakeClient({ prediction: null, meta: { data: {} } });
  const adapter = new CoupangCategoryAdapter(client);

  const result = await adapter.getCategoryMeta(1);

  assert.deepEqual(result.categoryPath, []);
  assert.deepEqual(result.attributes, []);
  assert.deepEqual(result.mandatoryOptionNames, []);
  assert.deepEqual(result.noticeCategoryTemplates, []);
  assert.deepEqual(result.certifications, []);
});
