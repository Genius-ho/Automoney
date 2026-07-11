export function normalizeInstructionText(text) {
  return String(text || '').normalize('NFKC').replace(/\r\n?/g, '\n').replace(/[\s\n]+/g, ' ').replace(/[.,!?;:]+/g, '').toLocaleLowerCase().trim();
}

export function checkMainInstructions(text) {
  const value = normalizeInstructionText(text);
  const checks = {
    imageCreation: /이미지 만들기/.test(value),
    preserveProductDesign: /제품/.test(value) && /(디자인|색상)/.test(value) && /(변형하지마|변경하지마|변형하지 마)/.test(value),
    size1000Square: /1000\s*[x×]\s*1000/.test(value),
    noText: /(글씨는 넣지마|글씨를 넣지마|텍스트는 넣지마|글씨는 넣지 마)/.test(value),
  };
  return { ...checks, mainInstructions: Object.values(checks).every(Boolean), failures: Object.entries(checks).filter(([, ok]) => !ok).map(([failedRule]) => ({ failedRule, matchedKeywords: [], missingKeywords: requiredKeywords(failedRule), normalizedSnippet: value.slice(0, 200) })) };
}
function requiredKeywords(rule) { return { imageCreation: ['이미지 만들기'], preserveProductDesign: ['제품', '디자인 또는 색상', '변형/변경하지마'], size1000Square: ['1000 x 1000'], noText: ['글씨/텍스트는 넣지마'] }[rule] || []; }
