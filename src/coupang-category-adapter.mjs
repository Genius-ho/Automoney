export class CoupangCategoryAdapter {
  async getNoticeMetadata() {
    return {
      status: 'not_implemented',
      requiredDocuments: [],
      certifications: [],
      missingItems: ['coupang_category_metadata'],
    };
  }
}

export function createCoupangCategoryAdapter() {
  return new CoupangCategoryAdapter();
}
