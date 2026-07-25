// Phase 8 (automoney_complete_automation_implementation_plan.md section 13):
// 도매매 Private API -- order creation, e-money balance, order list/detail,
// purchase cancellation, sold-out check. Distinct from domeme-client.mjs
// (the public product-lookup API, no login required) -- every endpoint here
// requires a session (sId) obtained by logging in with a real 도매꾹 member
// id/password, separate from the aid API key. Spec confirmed 2026-07-25
// against https://openapi.domeggook.com/ko/categories/Private-API-f7fe604c
// (setLogin, setLoginChk, getMyAsset, getOrderList, getOrderView, setOrdDeny,
// getAllSupplyChk pages) and the order-creation endpoint's own attached
// integration manual (도매꾹_도매매_주문서_생성_API_연동_가이드_20260707.docx,
// docs/ -- the public page for setOrder defers item[]/deliinfo's exact field
// breakdown to this attachment, it's not on the page itself).
//
// setXxx modes are POST (form-encoded body); getXxx modes are GET (query
// string) -- confirmed by the docs quoting full example GET URLs for
// getOrderList/getOrderView/getAllSupplyChk, and the docx's PHP sample
// posting form fields for setLogin/setOrder. getMyAsset is the one
// exception: "get"-prefixed but documented as POST.

export class DomemePrivateApiError extends Error {
  constructor({ status, operation, dcode, dmessage, bodyPreview }) {
    super(`Domeme Private API failed: operation=${operation}${dcode ? ` dcode=${dcode}` : ''}${dmessage ? ` (${dmessage})` : ''}`);
    this.name = 'DomemePrivateApiError';
    this.status = status ?? null;
    this.operation = operation;
    this.dcode = dcode || null;
    this.dmessage = dmessage || null;
    this.bodyPreview = bodyPreview || null;
  }
}

const DEFAULT_ENDPOINT = 'https://domeggook.com/ssl/api/';

export class DomemePrivateClient {
  constructor({
    apiKey,
    loginId,
    loginPassword,
    endpoint = DEFAULT_ENDPOINT,
    fetchImpl = globalThis.fetch,
  }) {
    if (!apiKey) throw new Error('Domeme Private API key is required');
    if (!loginId) throw new Error('Domeme login id is required');
    if (!loginPassword) throw new Error('Domeme login password is required');
    if (!fetchImpl) throw new Error('fetch implementation is required');
    this.apiKey = apiKey;
    this.loginId = loginId;
    this.loginPassword = loginPassword;
    this.endpoint = endpoint;
    this.fetchImpl = fetchImpl;
  }

  // 3.3.1: id/pw are only ever sent here, once per login -- every other call
  // authenticates with the returned sId instead.
  async login({ loginKeep = 'off', ip = '127.0.0.1', userAgent = 'automoney' } = {}) {
    const raw = await this.callSet('login', {
      ver: '4.1',
      mode: 'setLogin',
      id: this.loginId,
      pw: this.loginPassword,
      loginKeep,
      userAgent,
      ip,
      device: 'Third Party',
    });
    const data = raw.domeggook || raw;
    return {
      sId: data.sId,
      cId: data.cId,
      grade: data.grade,
      loginKeepTime: data.loginKeepTime ?? null,
      sIdRenewDate: data.sIdRenewDate ?? null,
    };
  }

  async checkLogin({ sId, sIdRenewDate, loginKeep = 'off' }) {
    if (!sId) throw new Error('sId is required');
    const raw = await this.callSet('login_check', {
      ver: '4.0',
      mode: 'setLoginChk',
      sId,
      sIdRenewDate: sIdRenewDate ?? '',
      loginKeep,
    });
    const data = raw.domeggook || raw;
    return {
      valid: Boolean(data.result),
      updateExpire: data.updateExpire === 'TRUE',
      expireDate: data.expireDate ?? null,
      sIdRenewDate: data.sIdRenewDate ?? null,
    };
  }

  // 13.1 사전 확인 "e-money 잔액 조회 가능 여부" -- also the cheapest live
  // reachability check for the whole Private API grant (no order side
  // effects), so the admin pre-check panel calls this to confirm access.
  async getMyAsset({ sId }) {
    if (!sId) throw new Error('sId is required');
    const raw = await this.callSet('get_my_asset', {
      ver: '1.0',
      mode: 'getMyAsset',
      sId,
    });
    const data = raw.domeggook?.data || raw.data || {};
    return {
      currPoint: toNumber(data.currPoint),
      emoneyTotal: toNumber(data.currEmoney?.total),
      emoneyCash: toNumber(data.currEmoney?.cash),
      emoneyCard: toNumber(data.currEmoney?.card),
    };
  }

  // 2.3.6/2.3.7 (연동 가이드): places a real order against the supplier --
  // deducts real cash e-money on success. Never call this without an
  // explicit human approval one layer up (see the Phase 8 draft/approval
  // pipeline) -- there is no dry-run mode on 도매매's side.
  async createOrder({ sId, items, deliInfo, receipt = 0, market, notify, alliance } = {}) {
    if (!sId) throw new Error('sId is required');
    if (!Array.isArray(items) || items.length === 0) throw new Error('at least one item is required');
    const body = {
      ver: '4.3',
      mode: 'setOrder',
      sId,
      receipt: receipt ? '1' : '0',
      ie: 'utf-8',
      oe: 'utf-8',
      deliinfo: buildDeliInfoParam(deliInfo),
    };
    if (market) body.market = market;
    if (notify !== undefined) body.notify = notify ? 'true' : 'false';
    if (alliance) body.alliance = alliance;
    for (const item of items) {
      body[`item[${item.itemNo}]`] = buildItemParam(item);
    }
    const raw = await this.callSet('create_order', body);
    const data = raw.domeggook || raw;
    const orders = Array.isArray(data.order) ? data.order : data.order ? [data.order] : [];
    return {
      result: data.result,
      orders: orders.map((order) => ({
        orderNo: order.orderNo,
        itemNo: order.itemNo,
        recipientName: order.getName,
      })),
    };
  }

  async listOrders({ sId, day, itemNo, status, page, itemsPerPage } = {}) {
    if (!sId) throw new Error('sId is required');
    const raw = await this.callGet('list_orders', {
      ver: '4.0',
      mode: 'getOrderList',
      sId,
      for: 'buy',
      day,
      itemNo,
      st: status,
      pg: page,
      ic: itemsPerPage,
    });
    const data = raw.domeggook || raw;
    return {
      numberOfItems: toNumber(data.numberOfItems),
      numberOfPages: toNumber(data.numberOfPages),
      orders: normalizeList(data.list ?? data.item ?? data.order),
    };
  }

  async getOrder({ sId, orderNo, orderUid } = {}) {
    if (!sId) throw new Error('sId is required');
    if (!orderNo && !orderUid) throw new Error('orderNo or orderUid is required');
    const raw = await this.callGet('get_order', {
      ver: '4.1',
      mode: 'getOrderView',
      sId,
      for: 'buy',
      no: orderNo,
      uid: orderUid,
    });
    return raw.domeggook || raw;
  }

  // 13.3 발주 차단 조건("주문 취소") 이후 처리, 아니면 Phase 10 취소 대응 -- 배송준비중
  // 이전 단계에서만 가능(도매매 쪽 제약, 이 클라이언트가 강제하는 것은 아님).
  async cancelOrder({ sId, orderNo, memo }) {
    if (!sId) throw new Error('sId is required');
    if (!orderNo) throw new Error('orderNo is required');
    if (!memo) throw new Error('memo (cancellation reason) is required');
    const raw = await this.callSet('cancel_order', {
      ver: '1.0',
      mode: 'setOrdDeny',
      sId,
      type: 'buy',
      no: orderNo,
      memo,
    });
    const data = raw.domeggook || raw;
    return { result: data.result };
  }

  // 13.2 발주 직전 재검증("공급처 판매상태", "공급처 재고") -- no sId/login required
  // per the docs (aid-only), so this can run as a cheap standalone check.
  async checkSoldOut({ status, cate, date, itemNo, page, itemsPerPage } = {}) {
    const raw = await this.callGet('check_sold_out', {
      ver: '1.0',
      mode: 'getAllSupplyChk',
      type: 'all',
      status,
      cate,
      date,
      sc: itemNo ? 'no' : undefined,
      sw: itemNo,
      pg: page,
      ic: itemsPerPage,
    });
    const data = raw.domeggook || raw;
    return {
      numberOfItems: toNumber(data.numberOfItems),
      items: normalizeList(data.list ?? data.item),
    };
  }

  async callSet(operation, params) {
    const url = new URL(this.endpoint);
    const body = new URLSearchParams(withCommonParams(this, params));
    const response = await this.fetchImpl(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    return this.parseResponse(response, operation, body.toString());
  }

  async callGet(operation, params) {
    const url = new URL(this.endpoint);
    url.search = new URLSearchParams(withCommonParams(this, params)).toString();
    const response = await this.fetchImpl(url.toString(), { method: 'GET' });
    return this.parseResponse(response, operation, maskSensitive(url.toString(), this));
  }

  async parseResponse(response, operation, sentPreview) {
    const text = await response.text();
    if (!response.ok) {
      throw new DomemePrivateApiError({
        status: response.status,
        operation,
        bodyPreview: previewBody(maskSensitive(text, this)),
      });
    }
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      throw new Error(`Domeme Private API returned invalid JSON for ${operation}: ${error.message}`);
    }
    const apiError = raw?.errors;
    if (apiError) {
      throw new DomemePrivateApiError({
        status: response.status,
        operation,
        dcode: apiError.dcode,
        dmessage: apiError.dmessage || apiError.message,
        bodyPreview: previewBody(JSON.stringify(raw)),
      });
    }
    return raw;
  }
}

function withCommonParams(client, params) {
  const entries = { aid: client.apiKey, id: client.loginId, om: 'json', ...params };
  return Object.fromEntries(
    Object.entries(entries).filter(([, value]) => value !== undefined && value !== null && value !== ''),
  );
}

// 2.3.6 (연동 가이드): 5 fields joined by "||" -- 구매채널 / 배송비부담주체 /
// 주문옵션코드&개수(들끼리는 단일 "|") / 판매자전달사항 / 배송요청사항(도매매 전용).
// Trailing empty fields are dropped, not joined as empty segments -- the
// guide's own two confirmed examples do this ('supply||P||00|2||전달사항 하나'
// has no trailing "||" for the omitted deliveryRequest), so a naive
// five-field join would produce a string that doesn't match their own
// documented format. Interior empty fields (e.g. an empty sellerMemo before
// a non-empty deliveryRequest) are still preserved positionally.
export function buildItemParam({ market, deliveryWho = 'P', options, sellerMemo = '', deliveryRequest = '' }) {
  if (!market) throw new Error('item market ("dome" or "supply") is required');
  const optionList = Array.isArray(options) && options.length > 0 ? options : [{ code: '00', qty: 1 }];
  const optionSegment = optionList.map((opt) => `${opt.code}|${opt.qty}`).join('|');
  const fields = [market, deliveryWho, optionSegment, sellerMemo, deliveryRequest];
  while (fields.length > 3 && fields[fields.length - 1] === '') fields.pop();
  return fields.join('||');
}

// 2.3.7: 9 fields joined by "|" -- 성명/이메일/우편번호/주소1/주소2/휴대전화/추가연락처/
// 쇼핑몰명/통관고유부호. Required fields per the guide's "○" column: name,
// zipcode, address1, address2, mobile, shopName.
export function buildDeliInfoParam({
  name, email = '', zipcode, address1, address2, mobile, phone = '', shopName, clearanceCode = '',
} = {}) {
  const required = { name, zipcode, address1, address2, mobile, shopName };
  for (const [field, value] of Object.entries(required)) {
    if (!value) throw new Error(`deliInfo.${field} is required`);
  }
  return [name, email, zipcode, address1, address2, mobile, phone, shopName, clearanceCode].join('|');
}

function normalizeList(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function previewBody(body, limit = 500) {
  return String(body || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

// Never let a raw password, api key, or session id reach a log line or
// thrown-error preview -- mirrors domeme-client.mjs's maskApiKey/maskUrl,
// extended to the two extra secrets this API introduces (pw, sId).
function maskSensitive(text, client) {
  let masked = String(text || '');
  if (client.loginPassword) masked = masked.replaceAll(client.loginPassword, '****');
  if (client.apiKey) masked = masked.replaceAll(client.apiKey, maskSecret(client.apiKey));
  masked = masked.replace(/([?&]sId=)[^&]+/gi, '$1****');
  masked = masked.replace(/(sId["\s:=]+)[A-Za-z0-9+/=_-]{6,}/g, '$1****');
  return masked;
}

export function maskSecret(value) {
  const text = String(value || '');
  if (text.length <= 4) return '*'.repeat(text.length);
  return `${text.slice(0, 4)}${'*'.repeat(text.length - 4)}`;
}
