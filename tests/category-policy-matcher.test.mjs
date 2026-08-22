import assert from 'node:assert/strict';
import test from 'node:test';

import { matchCategoryPolicyForKeyword } from '../src/category-policy-matcher.mjs';

function policy(id, searchKeywords) {
  return { id, categoryName: `category-${id}`, searchKeywords };
}

test('matchCategoryPolicyForKeyword matches an exact keyword', () => {
  const policies = [policy(1, ['수납정리함', '다용도정리함'])];
  assert.equal(matchCategoryPolicyForKeyword(policies, '수납정리함')?.id, 1);
});

test('matchCategoryPolicyForKeyword matches when the human keyword contains a shorter policy keyword', () => {
  const policies = [policy(1, ['책꽂이'])];
  assert.equal(matchCategoryPolicyForKeyword(policies, '미니 책꽂이 수납장')?.id, 1);
});

test('matchCategoryPolicyForKeyword matches when a policy keyword contains the shorter human keyword', () => {
  const policies = [policy(1, ['수납정리함'])];
  assert.equal(matchCategoryPolicyForKeyword(policies, '정리함')?.id, 1);
});

test('matchCategoryPolicyForKeyword ignores whitespace differences and is case-insensitive', () => {
  const policies = [policy(1, ['Desk Organizer'])];
  assert.equal(matchCategoryPolicyForKeyword(policies, 'desk  organizer')?.id, 1);
});

test('matchCategoryPolicyForKeyword returns null when no active policy keyword relates to it', () => {
  const policies = [policy(1, ['수납정리함']), policy(2, ['행거', '옷걸이'])];
  assert.equal(matchCategoryPolicyForKeyword(policies, '홍삼'), null);
});

test('matchCategoryPolicyForKeyword returns null for an empty keyword or policy list', () => {
  assert.equal(matchCategoryPolicyForKeyword([policy(1, ['정리함'])], ''), null);
  assert.equal(matchCategoryPolicyForKeyword([], '정리함'), null);
  assert.equal(matchCategoryPolicyForKeyword(undefined, '정리함'), null);
});

test('matchCategoryPolicyForKeyword returns the first matching policy in list order', () => {
  const policies = [policy(1, ['정리함']), policy(2, ['정리함'])];
  assert.equal(matchCategoryPolicyForKeyword(policies, '정리함')?.id, 1);
});
