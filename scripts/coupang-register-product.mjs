import { readFile } from 'node:fs/promises';

import { CoupangClient, CoupangApiError } from '../src/coupang-client.mjs';
import { loadCoupangConfig, loadDatabaseUrl } from '../src/config.mjs';
import { createPgPool } from '../src/postgres-store.mjs';

const root = process.cwd();
const draftId = Number((process.argv.find((arg) => arg.startsWith('--draft=')) || '--draft=64').split('=')[1]);

async function main() {
  const config = await loadCoupangConfig(root);
  const client = new CoupangClient(config);

  const dbUrl = await loadDatabaseUrl(root);
  const db = await createPgPool(dbUrl);
  try {
    const existing = (await db.query('select * from coupang_product_registrations where product_draft_id = $1', [draftId])).rows[0];
    if (existing?.seller_product_id) {
      console.log(`이미 등록됨: sellerProductId=${existing.seller_product_id} (status=${existing.status}) — 다시 생성하지 않습니다.`);
      const verify = await client.getProduct(existing.seller_product_id);
      console.log(JSON.stringify({ alreadyRegistered: true, sellerProductId: existing.seller_product_id, queryResult: verify }, null, 2));
      return;
    }

    const payload = JSON.parse(await readFile(`${root}/artifacts/coupang-product-payload-draft-${draftId}.json`, 'utf8'));
    if (!payload.imagesPubliclyHosted) throw new Error('payload images are not publicly hosted yet -- run coupang:upload-images and coupang:build-payload first');
    if (payload.requested !== false) throw new Error('refusing to submit a payload where requested is not exactly false');

    console.log(`=== draft ${draftId} 상품 생성 API 호출 (requested=false) ===`);
    let createResult;
    try {
      createResult = await client.createProduct(payload);
    } catch (error) {
      if (error instanceof CoupangApiError) {
        console.log(`실패: HTTP ${error.status} (${error.operation})`);
        console.log(`쿠팡 오류 메시지: ${error.bodyPreview}`);
        await db.query(
          `update coupang_product_registrations set status = 'create_failed', updated_at = now() where product_draft_id = $1`,
          [draftId],
        );
        process.exitCode = 1;
        return;
      }
      throw error;
    }

    const sellerProductId = createResult?.data ?? createResult?.sellerProductId ?? null;
    console.log(`생성 응답: ${JSON.stringify(createResult)}`);
    if (!sellerProductId) throw new Error('createProduct succeeded but no sellerProductId was returned');

    await db.query(
      `update coupang_product_registrations
          set seller_product_id = $2, status = 'created', requested = false, updated_at = now()
        where product_draft_id = $1`,
      [draftId, String(sellerProductId)],
    );
    console.log(`sellerProductId=${sellerProductId} 저장 완료`);

    console.log('\n=== 조회 API로 재확인 ===');
    const verify = await client.getProduct(sellerProductId);
    console.log(JSON.stringify({ createSucceeded: true, sellerProductId, requested: false, queryResult: verify }, null, 2));
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error('coupang:register-product failed:', error.message);
  process.exitCode = 1;
});
