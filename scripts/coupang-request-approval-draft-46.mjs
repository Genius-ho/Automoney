import { loadCoupangConfig, loadDatabaseUrl } from '../src/config.mjs';
import { CoupangClient, CoupangApiError } from '../src/coupang-client.mjs';
import { createPgPool } from '../src/postgres-store.mjs';

const root = process.cwd();
const SELLER_PRODUCT_ID = 16301910938;
const draftId = 46;

const EXPECTED = {
  remoteAreaDeliverable: 'N',
  outboundShippingPlaceCode: 24466172,
  returnCenterCode: '1002401151',
  itemCount: 1,
  representationImages: 1,
  detailImages: 9,
  detailContentsImages: 10,
  brand: '와우픽',
  manufacture: '와우픽',
  salePrice: 33570,
  stockQuantity: 10,
};

// Coupang statusName values observed so far that mean "not yet requested,
// safe to request": 임시저장 / 임시저장중. Anything already in an approval
// pipeline (승인대기중, 승인요청중, etc.) must not be re-requested.
const ALREADY_IN_APPROVAL_FLOW = ['승인대기중', '승인요청중', '심사중'];

async function main() {
  const config = await loadCoupangConfig(root);
  const client = new CoupangClient(config);

  const dbUrl = await loadDatabaseUrl(root);
  const db = await createPgPool(dbUrl);
  try {
    console.log('=== 1. 승인 요청 직전 상품 재조회 ===');
    const before = await client.getProduct(SELLER_PRODUCT_ID);
    const data = before.data;
    console.log(`  statusName=${data.statusName} / status=${data.status} / requested=${data.requested}`);

    if (ALREADY_IN_APPROVAL_FLOW.includes(data.statusName)) {
      console.log(`\n이미 승인 요청 처리 중(statusName=${data.statusName})이라 다시 승인 요청하지 않습니다.`);
      console.log(JSON.stringify({ approvalRequestSucceeded: false, alreadyInApprovalFlow: true, statusName: data.statusName, sellerProductId: SELLER_PRODUCT_ID }, null, 2));
      return;
    }

    console.log('\n=== 2. 상태가 임시저장(중)인지 확인 ===');
    const isTempSaved = data.statusName?.includes('임시저장');
    console.log(`  isTempSaved=${isTempSaved}`);
    if (!isTempSaved) throw new Error(`Unexpected statusName before approval request: ${data.statusName}`);

    console.log('\n=== 3. 수정사항 반영 여부 확인 ===');
    const item = data.items?.[0];
    const checks = {
      remoteAreaDeliverable: data.remoteAreaDeliverable === EXPECTED.remoteAreaDeliverable,
      outboundShippingPlaceCode: data.outboundShippingPlaceCode === EXPECTED.outboundShippingPlaceCode,
      returnCenterCode: String(data.returnCenterCode) === EXPECTED.returnCenterCode,
      itemCount: data.items?.length === EXPECTED.itemCount,
      representationImages: item?.images?.filter((i) => i.imageType === 'REPRESENTATION').length === EXPECTED.representationImages,
      detailImages: item?.images?.filter((i) => i.imageType === 'DETAIL').length === EXPECTED.detailImages,
      detailContentsImages: (item?.contents?.[0]?.contentDetails?.length ?? 0) === EXPECTED.detailContentsImages,
      searchTags: Array.isArray(item?.searchTags) && item.searchTags.length > 0,
      brand: data.brand === EXPECTED.brand,
      manufacture: data.manufacture === EXPECTED.manufacture,
      salePrice: item?.salePrice === EXPECTED.salePrice,
      stockQuantity: (item?.maximumBuyCount ?? item?.stockQuantity) === EXPECTED.stockQuantity,
    };
    for (const [key, ok] of Object.entries(checks)) console.log(`  ${key}: ${ok ? 'OK' : 'MISMATCH'}`);
    const allOk = Object.values(checks).every(Boolean);
    if (!allOk) {
      console.log('\n검증 실패 항목이 있어 승인 요청을 진행하지 않습니다.');
      console.log(JSON.stringify({ approvalRequestSucceeded: false, verificationFailed: true, checks }, null, 2));
      process.exitCode = 1;
      return;
    }

    console.log('\n=== 4. 승인 요청 API 호출 (PUT, body 없음, 1회만) ===');
    let approvalResult;
    try {
      approvalResult = await client.requestApproval(SELLER_PRODUCT_ID);
    } catch (error) {
      if (error instanceof CoupangApiError) {
        console.log(`실패: HTTP ${error.status} (${error.operation})`);
        console.log(`쿠팡 오류 메시지: ${error.bodyPreview}`);
        console.log('\n=== 8. 재호출 전 상태 재조회 (자동 재시도는 하지 않음) ===');
        const recheck = await client.getProduct(SELLER_PRODUCT_ID);
        console.log(`  statusName=${recheck.data.statusName}`);
        console.log(JSON.stringify({ approvalRequestSucceeded: false, errorStatus: error.status, errorMessage: error.bodyPreview, currentStatusName: recheck.data.statusName, sellerProductId: SELLER_PRODUCT_ID }, null, 2));
        process.exitCode = 1;
        return;
      }
      throw error;
    }
    console.log(`  응답: ${JSON.stringify(approvalResult)}`);

    console.log('\n=== 5. DB에 sellerProductId와 응답 메시지 저장 ===');
    await db.query(
      `update coupang_product_registrations
          set status = 'approval_requested', requested = true,
              approval_response_message = $2, approval_requested_at = now(), updated_at = now()
        where product_draft_id = $1`,
      [draftId, JSON.stringify(approvalResult)],
    );
    console.log('  저장 완료');

    console.log('\n=== 6. 승인 요청 후 상품 조회 / 등록 현황 재확인 ===');
    const after = await client.getProduct(SELLER_PRODUCT_ID);
    console.log(`  statusName=${after.data.statusName} / status=${after.data.status} / requested=${after.data.requested}`);

    console.log(`\n${JSON.stringify({
      approvalRequestSucceeded: approvalResult.code === 'SUCCESS',
      apiResponseMessage: approvalResult,
      currentStatusName: after.data.statusName,
      currentStatus: after.data.status,
      sellerProductId: SELLER_PRODUCT_ID,
    }, null, 2)}`);
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error('coupang-request-approval-draft-46 failed:', error.message);
  process.exitCode = 1;
});
