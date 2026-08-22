import { readFile } from 'node:fs/promises';

import { CoupangClient, CoupangApiError } from '../src/coupang-client.mjs';
import { loadCoupangConfig, loadDatabaseUrl } from '../src/config.mjs';
import { createPgPool } from '../src/postgres-store.mjs';

const root = process.cwd();
const draftId = 46;
const sellerProductId = 16301910938;

async function main() {
  const config = await loadCoupangConfig(root);
  const client = new CoupangClient(config);
  const dbUrl = await loadDatabaseUrl(root);
  const db = await createPgPool(dbUrl);
  try {
    const payload = JSON.parse(await readFile(`${root}/artifacts/coupang-product-payload-draft-${draftId}.json`, 'utf8'));
    if (payload.sellerProductId !== sellerProductId) throw new Error('payload sellerProductId mismatch -- refusing to submit');
    if (payload.remoteAreaDeliverable !== 'N') throw new Error('expected remoteAreaDeliverable=N in the fixed payload');

    console.log('=== PUT (modify) 호출: remoteAreaDeliverable N으로 수정 ===');
    let result;
    try {
      result = await client.updateProduct(payload);
    } catch (error) {
      if (error instanceof CoupangApiError) {
        console.log(`실패: HTTP ${error.status} (${error.operation})`);
        console.log(`쿠팡 오류 메시지: ${error.bodyPreview}`);
        process.exitCode = 1;
        return;
      }
      throw error;
    }
    console.log(`응답: ${JSON.stringify(result)}`);

    await db.query(
      `update coupang_product_registrations set status = 'modified', updated_at = now() where product_draft_id = $1`,
      [draftId],
    );

    console.log('\n=== 이력 재조회 ===');
    const histories = await client.request('GET', `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${sellerProductId}/histories`, {
      operation: 'get_product_histories',
    });
    console.log(JSON.stringify(histories, null, 2));
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error('coupang-fix-remote-area-draft-46 failed:', error.message);
  process.exitCode = 1;
});
