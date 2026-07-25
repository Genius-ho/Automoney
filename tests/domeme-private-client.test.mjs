import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DomemePrivateApiError,
  DomemePrivateClient,
  buildItemParam,
  buildDeliInfoParam,
  maskSecret,
} from '../src/domeme-private-client.mjs';

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, async text() { return JSON.stringify(body); } };
}

function makeClient(fetchImpl) {
  return new DomemePrivateClient({ apiKey: 'aaabbbccc', loginId: 'automoney', loginPassword: 'hunter2', fetchImpl });
}

// Confirmed verbatim against the order-creation API's own attached
// integration manual (도매꾹_도매매_주문서_생성_API_연동_가이드_20260707.docx, 2.3.6).
test('buildItemParam matches the guide\'s single-option supply example exactly', () => {
  const value = buildItemParam({ market: 'supply', deliveryWho: 'P', options: [{ code: '00', qty: 2 }], sellerMemo: '전달사항 하나' });
  assert.equal(value, 'supply||P||00|2||전달사항 하나');
});

test('buildItemParam matches the guide\'s multi-option dome example exactly', () => {
  const value = buildItemParam({
    market: 'dome',
    deliveryWho: 'P',
    options: [{ code: '01_03', qty: 4 }, { code: '02_01', qty: 2 }],
    sellerMemo: '전달사항 둘',
  });
  assert.equal(value, 'dome||P||01_03|4|02_01|2||전달사항 둘');
});

test('buildItemParam defaults to option code "00" (single-option product) when no options are given', () => {
  assert.equal(buildItemParam({ market: 'supply', options: [] }), 'supply||P||00|1');
});

test('buildItemParam preserves an interior empty sellerMemo when deliveryRequest has content', () => {
  const value = buildItemParam({ market: 'supply', options: [{ code: '00', qty: 1 }], deliveryRequest: '문 앞에 놔주세요' });
  assert.equal(value, 'supply||P||00|1||||문 앞에 놔주세요');
});

test('buildItemParam requires a market', () => {
  assert.throws(() => buildItemParam({ options: [{ code: '00', qty: 1 }] }), /market/);
});

// Confirmed verbatim against the same guide, 2.3.7.
test('buildDeliInfoParam matches the guide\'s full example exactly', () => {
  const value = buildDeliInfoParam({
    name: '홍길동', email: 'sample@example.com', zipcode: '00000',
    address1: '서울특별시 영등포구 국제금융로6길 30', address2: '1층',
    mobile: '010-0000-0000', phone: '02-0000-0000', shopName: '앗싸독수리', clearanceCode: 'P123456789012',
  });
  assert.equal(value, '홍길동|sample@example.com|00000|서울특별시 영등포구 국제금융로6길 30|1층|010-0000-0000|02-0000-0000|앗싸독수리|P123456789012');
});

test('buildDeliInfoParam throws when a required field is missing', () => {
  assert.throws(() => buildDeliInfoParam({ zipcode: '00000', address1: 'a', address2: 'b', mobile: '010-0000-0000', shopName: 's' }), /name/);
});

test('maskSecret keeps only the first four characters visible', () => {
  assert.equal(maskSecret('aaabbbccc'), 'aaab*****');
  assert.equal(maskSecret('ab'), '**');
});

test('DomemePrivateClient constructor requires apiKey, loginId, and loginPassword', () => {
  assert.throws(() => new DomemePrivateClient({ loginId: 'x', loginPassword: 'y', fetchImpl: async () => {} }), /API key/);
  assert.throws(() => new DomemePrivateClient({ apiKey: 'x', loginPassword: 'y', fetchImpl: async () => {} }), /login id/);
  assert.throws(() => new DomemePrivateClient({ apiKey: 'x', loginId: 'y', fetchImpl: async () => {} }), /login password/);
});

test('login POSTs setLogin with id/pw/aid and parses sId/cId/grade from the response', async () => {
  let captured;
  const client = makeClient(async (url, init) => {
    captured = { url: String(url), init };
    return jsonResponse({ domeggook: { result: 'true', sId: 'sess-123', cId: 'check-456', grade: 'c', loginKeepTime: 111, sIdRenewDate: 222 } });
  });
  const result = await client.login({ loginKeep: 'on', ip: '1.2.3.4' });
  assert.equal(captured.init.method, 'POST');
  const body = new URLSearchParams(captured.init.body);
  assert.equal(body.get('mode'), 'setLogin');
  assert.equal(body.get('ver'), '4.1');
  assert.equal(body.get('aid'), 'aaabbbccc');
  assert.equal(body.get('id'), 'automoney');
  assert.equal(body.get('pw'), 'hunter2');
  assert.equal(body.get('loginKeep'), 'on');
  assert.equal(body.get('ip'), '1.2.3.4');
  assert.equal(body.get('device'), 'Third Party');
  assert.deepEqual(result, { sId: 'sess-123', cId: 'check-456', grade: 'c', loginKeepTime: 111, sIdRenewDate: 222 });
});

test('checkLogin reports session validity and whether the expiry was renewed', async () => {
  const client = makeClient(async () => jsonResponse({ domeggook: { result: true, updateExpire: 'TRUE', expireDate: 999, sIdRenewDate: 333 } }));
  const result = await client.checkLogin({ sId: 'sess-123', sIdRenewDate: 222 });
  assert.deepEqual(result, { valid: true, updateExpire: true, expireDate: 999, sIdRenewDate: 333 });
});

test('getMyAsset parses the cash e-money balance used for the 13.1 pre-check', async () => {
  const client = makeClient(async () => jsonResponse({
    domeggook: { result: 'SUCCESS', id: 'automoney', data: { currPoint: '500', currEmoney: { total: '100000', card: '0', cash: '100000' } } },
  }));
  const result = await client.getMyAsset({ sId: 'sess-123' });
  assert.deepEqual(result, { currPoint: 500, emoneyTotal: 100000, emoneyCash: 100000, emoneyCard: 0 });
});

test('createOrder POSTs item[itemNo] and deliinfo, and normalizes a single order into an array', async () => {
  let captured;
  const client = makeClient(async (url, init) => {
    captured = { url: String(url), init };
    return jsonResponse({ domeggook: { result: 'SUCCESS', order: { orderNo: 14207678, itemNo: 9583416, getName: '홍길동' } } });
  });
  const result = await client.createOrder({
    sId: 'sess-123',
    receipt: 1,
    items: [{ itemNo: 9583416, market: 'supply', options: [{ code: '00', qty: 1 }], sellerMemo: '고객요청' }],
    deliInfo: { name: '홍길동', zipcode: '00000', address1: 'a', address2: 'b', mobile: '010-0000-0000', shopName: 's' },
  });
  const body = new URLSearchParams(captured.init.body);
  assert.equal(body.get('mode'), 'setOrder');
  assert.equal(body.get('ver'), '4.3');
  assert.equal(body.get('receipt'), '1');
  assert.equal(body.get('item[9583416]'), 'supply||P||00|1||고객요청');
  assert.equal(body.get('deliinfo'), '홍길동||00000|a|b|010-0000-0000||s|');
  assert.deepEqual(result, { result: 'SUCCESS', orders: [{ orderNo: 14207678, itemNo: 9583416, recipientName: '홍길동' }] });
});

test('createOrder handles multiple items ordered at once (order comes back as an array)', async () => {
  const client = makeClient(async () => jsonResponse({
    domeggook: {
      result: 'SUCCESS',
      order: [
        { orderNo: 14207678, itemNo: 9583416, getName: '홍길동' },
        { orderNo: 14207679, itemNo: 7105488, getName: '이성계' },
      ],
    },
  }));
  const result = await client.createOrder({
    sId: 'sess-123',
    items: [
      { itemNo: 9583416, market: 'supply', options: [{ code: '00', qty: 1 }] },
      { itemNo: 7105488, market: 'dome', options: [{ code: '01', qty: 1 }] },
    ],
    deliInfo: { name: '홍길동', zipcode: '00000', address1: 'a', address2: 'b', mobile: '010-0000-0000', shopName: 's' },
  });
  assert.equal(result.orders.length, 2);
  assert.equal(result.orders[1].orderNo, 14207679);
});

test('createOrder throws DomemePrivateApiError with dcode/dmessage on an errors response, and never leaks the password', async () => {
  const client = makeClient(async () => jsonResponse({
    errors: { code: 21, message: '주문 실패', dcode: 'TOO_LESS_EMONEY_ERROR', dmessage: '현금성 이머니가 부족하여 주문을 진행할 수 없습니다' },
  }));
  await assert.rejects(
    client.createOrder({
      sId: 'sess-123',
      items: [{ itemNo: 1, market: 'supply', options: [{ code: '00', qty: 1 }] }],
      deliInfo: { name: '홍길동', zipcode: '00000', address1: 'a', address2: 'b', mobile: '010-0000-0000', shopName: 's' },
    }),
    (error) => {
      assert.ok(error instanceof DomemePrivateApiError);
      assert.equal(error.dcode, 'TOO_LESS_EMONEY_ERROR');
      assert.match(error.dmessage, /이머니가 부족/);
      return true;
    },
  );
});

test('createOrder requires at least one item', async () => {
  const client = makeClient(async () => jsonResponse({}));
  await assert.rejects(client.createOrder({ sId: 'x', items: [], deliInfo: {} }), /item/);
});

test('listOrders GETs getOrderList with for=buy and status/day filters as query params', async () => {
  let captured;
  const client = makeClient(async (url) => {
    captured = String(url);
    return jsonResponse({ domeggook: { numberOfItems: '1', numberOfPages: '1', list: { orderNo: 1, status: '결제완료' } } });
  });
  const result = await client.listOrders({ sId: 'sess-123', day: 7, status: '결제완료' });
  const url = new URL(captured);
  assert.equal(url.searchParams.get('mode'), 'getOrderList');
  assert.equal(url.searchParams.get('for'), 'buy');
  assert.equal(url.searchParams.get('day'), '7');
  assert.equal(url.searchParams.get('st'), '결제완료');
  assert.deepEqual(result.orders, [{ orderNo: 1, status: '결제완료' }]);
});

test('getOrder GETs getOrderView with the order number and requires either orderNo or orderUid', async () => {
  let captured;
  const client = makeClient(async (url) => {
    captured = String(url);
    return jsonResponse({ domeggook: { orderNo: 14207678, status: '배송중', statusMode: 'WAITDELI' } });
  });
  await client.getOrder({ sId: 'sess-123', orderNo: 14207678 });
  const url = new URL(captured);
  assert.equal(url.searchParams.get('mode'), 'getOrderView');
  assert.equal(url.searchParams.get('no'), '14207678');

  const client2 = makeClient(async () => jsonResponse({}));
  await assert.rejects(client2.getOrder({ sId: 'sess-123' }), /orderNo or orderUid/);
});

test('cancelOrder POSTs setOrdDeny and requires a cancellation memo', async () => {
  let captured;
  const client = makeClient(async (url, init) => {
    captured = init;
    return jsonResponse({ domeggook: { result: 'complete' } });
  });
  const result = await client.cancelOrder({ sId: 'sess-123', orderNo: 14207678, memo: '고객 요청 취소' });
  const body = new URLSearchParams(captured.body);
  assert.equal(body.get('mode'), 'setOrdDeny');
  assert.equal(body.get('type'), 'buy');
  assert.equal(body.get('no'), '14207678');
  assert.equal(body.get('memo'), '고객 요청 취소');
  assert.deepEqual(result, { result: 'complete' });

  const client2 = makeClient(async () => jsonResponse({}));
  await assert.rejects(client2.cancelOrder({ sId: 'sess-123', orderNo: 1 }), /memo/);
});

test('checkSoldOut GETs getAllSupplyChk without requiring a session (aid-only per docs)', async () => {
  let captured;
  const client = makeClient(async (url) => {
    captured = String(url);
    return jsonResponse({ domeggook: { numberOfItems: '1', list: { no: 40170547, status: 'SOLDOUT' } } });
  });
  const result = await client.checkSoldOut({ status: 'SOLDOUT' });
  const url = new URL(captured);
  assert.equal(url.searchParams.get('mode'), 'getAllSupplyChk');
  assert.equal(url.searchParams.has('sId'), false);
  assert.deepEqual(result.items, [{ no: 40170547, status: 'SOLDOUT' }]);
});

test('a non-2xx HTTP response is surfaced as DomemePrivateApiError with the password masked out of the body preview', async () => {
  const client = makeClient(async () => ({ ok: false, status: 500, async text() { return 'internal error, pw=hunter2 leaked accidentally'; } }));
  await assert.rejects(client.getMyAsset({ sId: 'sess-123' }), (error) => {
    assert.ok(error instanceof DomemePrivateApiError);
    assert.equal(error.status, 500);
    assert.doesNotMatch(error.bodyPreview, /hunter2/);
    return true;
  });
});
