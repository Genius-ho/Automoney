import assert from 'node:assert/strict';
import test from 'node:test';

import { renderImagePrompt } from '../src/image-prompt-templates.mjs';

test('renderImagePrompt replaces only approved product placeholders and preserves instruction brackets', () => {
  const result = renderImagePrompt(
    '브랜드 [브랜드명], 상품 [제품명], 옵션 [옵션을 입력하세요], 버튼 [이미지 만들기]',
    {
      optimizedTitle: '테스트 상품',
      storeName: '와우픽',
      options: [{ name: '색상', value: '검정' }],
      originalDetailHtml: '',
    },
  );

  assert.equal(result.prompt, '브랜드 와우픽, 상품 테스트 상품, 옵션 색상: 검정, 버튼 [이미지 만들기]');
  assert.deepEqual(result.warnings, [
    'size_information_missing',
    'selling_points_insufficient',
    'competitor_images_missing',
    'source_detail_images_missing',
  ]);
});

test('renderImagePrompt uses information unavailable without inventing source facts', () => {
  const result = renderImagePrompt('사이즈 [사이즈 정보를 입력하세요] / 소구점 [소구점 1]', {
    optimizedTitle: '',
    storeName: '와우픽',
    options: [],
    originalDetailHtml: '',
  });

  assert.equal(result.prompt, '사이즈 정보 없음 / 소구점 정보 없음');
  assert.ok(result.warnings.includes('product_name_missing'));
  assert.ok(result.warnings.includes('option_information_missing'));
});
