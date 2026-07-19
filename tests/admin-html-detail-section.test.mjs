import assert from 'node:assert/strict';
import test from 'node:test';
import { renderHtmlDetailSection } from '../src/admin-server.mjs';
test('renderHtmlDetailSection keeps the existing HTML detail controls', () => { const html=renderHtmlDetailSection({generatedDetailHtml:'<p>detail</p>'}); assert.match(html,/HTML 상세페이지 v2/); assert.match(html,/id="generatedDetailHtml"/); assert.match(html,/id="preview"/); assert.match(html,/id="saveButton"/); });
