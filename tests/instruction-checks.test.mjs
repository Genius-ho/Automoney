import assert from 'node:assert/strict';
import test from 'node:test';
import { checkMainInstructions } from '../src/instruction-checks.mjs';
test('recognizes normalized main-image instructions', () => { const r = checkMainInstructions('[이미지 만들기] 클릭\n내 제품의 디자인이나 색상을 변형하지마.\n사이즈는 1000 x 1000\n글씨는 넣지마.'); assert.equal(r.mainInstructions, true); });
test('accepts compact size and line breaks', () => { const r = checkMainInstructions('이미지 만들기\n제품 디자인 변경하지마\n사이즈는 1000x1000\n글씨는\n넣지마'); assert.equal(r.size1000Square, true); assert.equal(r.noText, true); });
test('reports missing instruction rules', () => { const r = checkMainInstructions('이미지 만들기'); assert.equal(r.mainInstructions, false); assert.ok(r.failures.some((x) => x.failedRule === 'noText')); });
