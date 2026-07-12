export const DETAIL_PAGE_EXPECTED_COUNT = 10;

export const DETAIL_PAGE_SECTIONS = Object.freeze([
  { index: 1, key: 'hero', label: 'Hero' },
  { index: 2, key: 'review', label: '리뷰/평점' },
  { index: 3, key: 'core_values', label: '3가지 핵심가치' },
  { index: 4, key: 'point_01', label: 'Point 01' },
  { index: 5, key: 'point_02', label: 'Point 02' },
  { index: 6, key: 'point_03', label: 'Point 03' },
  { index: 7, key: 'comparison', label: 'Comparison' },
  { index: 8, key: 'detail', label: 'Detail' },
  { index: 9, key: 'color_size', label: 'Color & Size' },
  { index: 10, key: 'product_info', label: 'Product Info' },
].map((section) => Object.freeze(section)));

export function getDetailPageSections() {
  return DETAIL_PAGE_SECTIONS.map((section) => ({ ...section }));
}
