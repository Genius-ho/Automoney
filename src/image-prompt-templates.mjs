const STORE_NAME = '와우픽';
const MISSING = '정보 없음';

export function renderImagePrompt(templateBody, input = {}) {
  const title = clean(input.optimizedTitle || input.sellingTitle || input.productName);
  const option = optionText(input.options);
  const sourceText = stripHtml(input.originalDetailHtml);
  const size = findSize(sourceText);
  const points = findSellingPoints(sourceText);
  const warnings = [];
  if (!title) warnings.push('product_name_missing');
  if (!option) warnings.push('option_information_missing');
  if (!size) warnings.push('size_information_missing');
  if (points.length < 3) warnings.push('selling_points_insufficient');
  if (!input.competitorImageUrls?.length) warnings.push('competitor_images_missing');
  if (!input.sourceImageUrls?.some((url) => url)) warnings.push('source_detail_images_missing');
  const values = {
    '[제품명]': title || MISSING,
    '[제품명을 입력하세요]': title || MISSING,
    '[브랜드명]': clean(input.brandName) || clean(input.storeName) || STORE_NAME,
    '[브랜드명을 입력하세요]': clean(input.brandName) || clean(input.storeName) || STORE_NAME,
    '[옵션을 입력하세요]': option || MISSING,
    '[사이즈 정보를 입력하세요]': size || MISSING,
    '[첫 번째 핵심 장점을 입력하세요]': points[0] || MISSING,
    '[두 번째 핵심 장점을 입력하세요]': points[1] || MISSING,
    '[세 번째 핵심 장점을 입력하세요]': points[2] || MISSING,
    '[소구점 1]': points[0] || MISSING,
    '[소구점 2]': points[1] || MISSING,
    '[소구점 3]': points[2] || MISSING,
  };
  let prompt = String(templateBody || '');
  for (const [placeholder, value] of Object.entries(values)) prompt = prompt.split(placeholder).join(value);
  const competitorCount = input.competitorImageUrls?.length || 0;
  prompt = prompt.replaceAll('[숫자]번째 사진~[숫자]번째 사진', competitorCount ? `1번째 사진~${competitorCount}번째 사진` : MISSING);
  return { prompt, warnings: [...new Set(warnings)] };
}

export async function importPromptTemplate(db, template) {
  const existing = await db.query('select id, template_body, version from image_prompt_templates where template_type = $1', [template.templateType]);
  const row = existing.rows[0];
  if (row && row.template_body === template.templateBody) return row;
  const result = await db.query(
    `insert into image_prompt_templates (template_type, template_name, source_file_name, template_body, version, is_active, imported_at, updated_at)
     values ($1, $2, $3, $4, $5, true, now(), now())
     on conflict (template_type) do update set template_name = excluded.template_name, source_file_name = excluded.source_file_name,
       template_body = excluded.template_body, version = image_prompt_templates.version + 1, is_active = true, imported_at = now(), updated_at = now()
     returning *`,
    [template.templateType, template.templateName, template.sourceFileName, template.templateBody, row ? row.version + 1 : 1],
  );
  return result.rows[0];
}

function clean(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
function optionText(options) { return (options || []).map((o) => [clean(o.name), clean(o.value)].filter(Boolean).join(': ')).filter(Boolean).join(', '); }
function stripHtml(html) { return String(html || '').replace(/<[^>]*>/g, '\n').replace(/&nbsp;/g, ' ').replace(/\r/g, '').split('\n').map(clean).filter(Boolean).join('\n'); }
function findSize(text) { return (text.match(/(?:\d+(?:\.\d+)?\s?(?:cm|mm|m|inch|인치)|\d+\s?[x×]\s?\d+(?:\s?[x×]\s?\d+)?\s?(?:cm|mm)?)/i) || [])[0] || ''; }
function findSellingPoints(text) { return [...new Set(text.split('\n').map(clean).filter((line) => line.length >= 8 && line.length <= 180 && !/^(제품명|브랜드명|옵션|사이즈)\s*[:：]/.test(line)))].slice(0, 3); }
