// Minimal Node-based runtime test for the dashboard's per-strategy UI
// switching (web_gui/dashboard/static/app.js). This repo has no existing
// JS test framework/npm dependency, so this uses only Node's built-in
// `assert` and `vm` modules with a small, generic, auto-vivifying DOM
// stub -- not a full jsdom -- just enough for app.js to load and run
// without touching a real browser.
//
// Run: node tests_js/test_vr_ui.mjs

import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_JS_PATH = path.join(__dirname, "..", "web_gui", "dashboard", "static", "app.js");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log("ok - " + name);
  } catch (error) {
    failed += 1;
    console.log("FAIL - " + name);
    console.log("  " + (error && error.stack ? error.stack.split("\n").join("\n  ") : error));
  }
}

function classListOf(el) {
  return new Set((el.className || "").split(/\s+/).filter(Boolean));
}

function makeElement(id) {
  const el = {
    id,
    hidden: false,
    textContent: "",
    className: "",
    value: "",
    checked: false,
    disabled: false,
    max: "",
    _children: [],
    _listeners: {},
    style: {},
    dataset: {},
    addEventListener(type, handler) { (this._listeners[type] = this._listeners[type] || []).push(handler); },
    removeEventListener() {},
    dispatch(type, eventObj) { (this._listeners[type] || []).forEach(h => h(eventObj || {})); },
    replaceChildren(...children) { this._children = children; },
    append(...children) { this._children.push(...children); },
    appendChild(child) { this._children.push(child); return child; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    _attrs: {},
    setAttribute(name, value) { this._attrs[name] = String(value); },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name] : null; },
    showModal() {},
    close() {},
    focus() {},
    get open() { return false; },
  };
  el.classList = {
    toggle(name, force) {
      const classes = classListOf(el);
      const has = classes.has(name);
      const want = force === undefined ? !has : force;
      if (want) classes.add(name); else classes.delete(name);
      el.className = Array.from(classes).join(" ");
    },
    add(name) { const c = classListOf(el); c.add(name); el.className = Array.from(c).join(" "); },
    remove(name) { const c = classListOf(el); c.delete(name); el.className = Array.from(c).join(" "); },
  };
  el.parentElement = { classList: { toggle() {}, add() {}, remove() {} } };
  return el;
}

function makeDocumentAndWindow() {
  const registry = new Map();
  // Fixed radio inputs so selectedSymbol()/currentStrategyType() work.
  const symbolRadios = ["TQQQ", "SOXL", "KORU"].map(value => ({
    name: "symbol", value, checked: value === "TQQQ",
    addEventListener() {},
  }));
  const strategyRadios = ["MUMAE", "VR_SKILL"].map(value => ({
    name: "strategyType", value, checked: value === "MUMAE",
    addEventListener() {},
  }));

  const document = {
    getElementById(id) {
      if (!registry.has(id)) registry.set(id, makeElement(id));
      return registry.get(id);
    },
    querySelectorAll(selector) {
      if (selector === 'input[name="symbol"]') return symbolRadios;
      if (selector === 'input[name="strategyType"]') return strategyRadios;
      if (selector.startsWith(".")) {
        const cls = selector.slice(1);
        return Array.from(registry.values()).filter(el => classListOf(el).has(cls));
      }
      return [];
    },
    querySelector(selector) {
      if (selector === 'input[name="symbol"]:checked') return symbolRadios.find(r => r.checked) || null;
      return null;
    },
    createElement() { return makeElement(null); },
    createElementNS(ns, tag) { const el = makeElement(null); el.tagName = tag; return el; },
    addEventListener() {},
  };
  const window = { addEventListener() {}, location: { origin: "http://127.0.0.1" } };
  const localStorageBacking = new Map();
  const localStorage = {
    getItem(key) { return localStorageBacking.has(key) ? localStorageBacking.get(key) : null; },
    setItem(key, value) { localStorageBacking.set(key, String(value)); },
  };
  return { document, window, localStorage, registry, symbolRadios, strategyRadios };
}

function loadApp({ fetchImpl } = {}) {
  const { document, window, localStorage, registry, symbolRadios, strategyRadios } = makeDocumentAndWindow();
  const sandbox = {
    document, window, localStorage, console,
    fetch: fetchImpl || (async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })),
    confirm: () => true,
    setInterval: () => 0,
    setTimeout: () => 0,
    Date, Number, String, Boolean, Array, Object, JSON, Math,
  };
  vm.createContext(sandbox);
  const code = fs.readFileSync(APP_JS_PATH, "utf8");
  vm.runInContext(code, sandbox, { filename: "app.js" });
  return { sandbox, registry, symbolRadios, strategyRadios };
}

// --- 1/2: MUMAE selected shows EMERGENCY EDIT / SELECTED STRATEGY -------
test("MUMAE selected: setMumaeOnlyVisible(true) shows mumae-only elements", () => {
  const { sandbox, registry } = loadApp();
  const emergency = registry.get("emergencyTitle"); // stand-in inside .mumae-only card
  // Mark two elements mumae-only, as index.html now does.
  const a = sandbox.document.getElementById("emergencyCardStub");
  const b = sandbox.document.getElementById("selectedStrategyCardStub");
  a.classList.add("mumae-only"); a.hidden = true;
  b.classList.add("mumae-only"); b.hidden = true;
  sandbox.setMumaeOnlyVisible(true);
  assert.equal(a.hidden, false);
  assert.equal(b.hidden, false);
});

test("VR selected: setMumaeOnlyVisible(false) hides mumae-only elements", () => {
  const { sandbox } = loadApp();
  const a = sandbox.document.getElementById("emergencyCardStub2");
  const b = sandbox.document.getElementById("selectedStrategyCardStub2");
  a.classList.add("mumae-only");
  b.classList.add("mumae-only");
  sandbox.setMumaeOnlyVisible(false);
  assert.equal(a.hidden, true);
  assert.equal(b.hidden, true);
});

// --- 3/4: order-plan area repurposing ------------------------------------
test("MUMAE order plan area stays populated by renderOrderPlan (existing behavior)", () => {
  const { sandbox } = loadApp();
  sandbox.renderOrderPlan({ orders: [{ side: "buy", quantity: 2, price: "10.00", kind: "LIMIT", reason: "x", status: "PLANNED" }], plan_status: {} }, "TQQQ");
  assert.equal(sandbox.document.getElementById("orderPlanTitle").textContent, "TQQQ 오늘 자동 주문계획");
  assert.equal(sandbox.document.getElementById("orderPlanBody")._children.length, 1);
});

test("VR order plan: renderVrOrderPlan does not touch MUMAE orderPlanBody rows", () => {
  const { sandbox } = loadApp();
  const mumaeBody = sandbox.document.getElementById("orderPlanBody");
  mumaeBody.replaceChildren({ fake: "stale-mumae-row" });
  sandbox.renderVrOrderPlan("TQQQ", { status: "UNINITIALIZED", current_cycle: null, conditional_orders: [], pending_config: {} });
  assert.equal(mumaeBody._children.length, 1, "MUMAE table body must be untouched by the VR renderer");
  assert.equal(sandbox.document.getElementById("orderPlanTitle").textContent, "TQQQ VR 실행계획");
});

// --- 5/6: VR plan content when a cycle exists ----------------------------
test("VR selected with an active cycle: cycle/V/G/Band/Pool and conditional orders render", () => {
  const { sandbox } = loadApp();
  const data = {
    status: "ACTIVE",
    blocked_reason: null,
    current_cycle: {
      cycle_id: "TQQQ-c2", start_session: "2026-08-10", end_session: "2026-08-21",
      V: "18287.95", G: "10", band_pct: "15", pool_current: "1500.00",
      lower_band: "15544.76", upper_band: "21031.14",
    },
    conditional_orders: [
      { side: "buy", trigger_price: "85.00", order_price: "85.00", quantity: 5, expire_date: "2026-08-21", conditional_order_id: "co-1", status: "OPEN", triggered_order_id: null },
      { side: "sell", trigger_price: "115.00", order_price: "115.00", quantity: 3, expire_date: "2026-08-21", conditional_order_id: "co-2", status: "FILLED", triggered_order_id: "reg-9" },
    ],
    pending_config: { G: null, band_pct: null, pool_adjustment: null },
  };
  sandbox.renderVrOrderPlan("TQQQ", data);
  assert.equal(sandbox.document.getElementById("vrPlanStatusMessage").hidden, true);
  assert.equal(sandbox.document.getElementById("vrPlanSummary").hidden, false);
  assert.equal(sandbox.document.getElementById("vrPlanCycleId").textContent, "TQQQ-c2");
  assert.equal(sandbox.document.getElementById("vrPlanG").textContent, "10");
  assert.equal(sandbox.document.getElementById("vrPlanBand").textContent, "±15%");
  // Only the OPEN leg is shown in the active-orders table.
  assert.equal(sandbox.document.getElementById("vrPlanOrdersBody")._children.length, 1);
  assert.equal(sandbox.document.getElementById("vrPlanOrdersTable").hidden, false);
});

test("VR pending config renders G/Band/Pool text, or 없음 when unset", () => {
  const { sandbox } = loadApp();
  const cycle = { cycle_id: "c1", start_session: "s", end_session: "e", V: "1", G: "10", band_pct: "15", pool_current: "1", lower_band: "1", upper_band: "1" };
  sandbox.renderVrOrderPlan("TQQQ", { status: "ACTIVE", current_cycle: cycle, conditional_orders: [], pending_config: { G: "20", band_pct: "10", pool_adjustment: "300" } });
  assert.equal(sandbox.document.getElementById("vrPlanPendingText").textContent, "G 20 · Band ±10% · Pool +300");

  sandbox.renderVrOrderPlan("TQQQ", { status: "ACTIVE", current_cycle: cycle, conditional_orders: [], pending_config: {} });
  assert.equal(sandbox.document.getElementById("vrPlanPendingText").textContent, "없음");
});

// --- 7: not-yet-generated states show clear messages, not an empty table -
test("VR not-yet-initialized shows a clear message, not an empty table", () => {
  const { sandbox } = loadApp();
  sandbox.renderVrOrderPlan("TQQQ", { status: "UNINITIALIZED", current_cycle: null, conditional_orders: [], pending_config: {} });
  assert.equal(sandbox.document.getElementById("vrPlanStatusMessage").hidden, false);
  assert.equal(sandbox.document.getElementById("vrPlanStatusMessage").textContent, "VR이 아직 초기화되지 않았습니다.");
  assert.equal(sandbox.document.getElementById("vrPlanSummary").hidden, true);
});

test("VR STOPPED shows the stopped message", () => {
  const { sandbox } = loadApp();
  sandbox.renderVrOrderPlan("TQQQ", { status: "STOPPED", current_cycle: { cycle_id: "c1", start_session: "s", end_session: "e", V: "1", G: "10", band_pct: "15", pool_current: "1", lower_band: "1", upper_band: "1" }, conditional_orders: [], pending_config: {} });
  assert.equal(sandbox.document.getElementById("vrPlanStatusMessage").textContent, "VR 신규 주문이 중지되어 있습니다.");
});

test("VR CYCLE_TRANSITION_BLOCKED shows the blocked reason", () => {
  const { sandbox } = loadApp();
  sandbox.renderVrOrderPlan("TQQQ", { status: "CYCLE_TRANSITION_BLOCKED", blocked_reason: "close price missing", current_cycle: { cycle_id: "c1", start_session: "s", end_session: "e", V: "1", G: "10", band_pct: "15", pool_current: "1", lower_band: "1", upper_band: "1" }, conditional_orders: [], pending_config: {} });
  assert.equal(sandbox.document.getElementById("vrPlanStatusMessage").textContent, "사이클 전환이 보류되었습니다: close price missing");
});

test("showVrPlanMessage (account sync failure path) sets the documented text", () => {
  const { sandbox } = loadApp();
  sandbox.showVrPlanMessage("계좌 상태를 확인할 수 없어 주문계획을 생성하지 않았습니다.");
  assert.equal(sandbox.document.getElementById("vrPlanStatusMessage").hidden, false);
  assert.equal(sandbox.document.getElementById("vrPlanStatusMessage").textContent, "계좌 상태를 확인할 수 없어 주문계획을 생성하지 않았습니다.");
  assert.equal(sandbox.document.getElementById("vrPlanSummary").hidden, true);
});

// --- 8: strategy switch flips the visible UI without reload --------------
test("loadVrPanel() switches mumae-only visibility and order-plan area based on strategy_type", async () => {
  const fetchResponses = [];
  const { sandbox, registry } = loadApp({
    fetchImpl: async (url, options) => {
      if (url.includes("/api/etf-status")) {
        return { ok: true, status: 200, json: async () => ({ ok: true, etf_overview: [{ symbol: "TQQQ", strategy_type: "VR_SKILL" }] }) };
      }
      const body = JSON.parse(options.body);
      if (body.command === "vr.snapshot") {
        return { ok: true, status: 200, json: async () => ({ ok: true, status: "UNINITIALIZED", current_cycle: null, conditional_orders: [], pending_config: {} }) };
      }
      if (body.command === "market.indices") {
        return { ok: true, status: 200, json: async () => ({ ok: true, indices: [] }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  });
  const mumaeEl = sandbox.document.getElementById("mumaeOnlyProbe");
  mumaeEl.classList.add("mumae-only");
  await sandbox.loadEtfOverview(); // fetches strategy_type=VR_SKILL for TQQQ, then calls loadVrPanel()
  assert.equal(mumaeEl.hidden, true, "switching to VR_SKILL must hide mumae-only UI without a page reload");
  assert.equal(sandbox.document.getElementById("mumaeOrderPlanContent").hidden, true);
  assert.equal(sandbox.document.getElementById("vrOrderPlanContent").hidden, false);
});

test("loadVrPanel() restores MUMAE UI when strategy_type is MUMAE", async () => {
  const { sandbox } = loadApp({
    fetchImpl: async (url, options) => {
      if (url.includes("/api/etf-status")) {
        return { ok: true, status: 200, json: async () => ({ ok: true, etf_overview: [{ symbol: "TQQQ", strategy_type: "MUMAE" }] }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, indices: [] }) };
    },
  });
  const mumaeEl = sandbox.document.getElementById("mumaeOnlyProbe2");
  mumaeEl.classList.add("mumae-only");
  mumaeEl.hidden = true;
  await sandbox.loadEtfOverview();
  assert.equal(mumaeEl.hidden, false, "MUMAE strategy must show mumae-only UI again");
  assert.equal(sandbox.document.getElementById("mumaeOrderPlanContent").hidden, false);
  assert.equal(sandbox.document.getElementById("vrOrderPlanContent").hidden, true);
});

// --- MIN/MAX gauge + V1->V2->... line chart --------------------------------
test("renderVrGauge places a marker at the live value's position between MIN and MAX", () => {
  const { sandbox } = loadApp();
  const cycle = { V: "10000", lower_band: "8500", upper_band: "11500" };
  sandbox.renderVrGauge(cycle, 10000); // exactly at V -> dead center
  const svg = sandbox.document.getElementById("vrGaugeSvg");
  const marker = svg._children.find(c => (c._attrs.class || "") === "vr-gauge-marker-current");
  assert.ok(marker, "a current-value marker must be drawn when liveValue is known");
});

test("renderVrGauge omits the current-value marker when liveValue is unavailable", () => {
  const { sandbox } = loadApp();
  const cycle = { V: "10000", lower_band: "8500", upper_band: "11500" };
  sandbox.renderVrGauge(cycle, null);
  const svg = sandbox.document.getElementById("vrGaugeSvg");
  const marker = svg._children.find(c => (c._attrs.class || "") === "vr-gauge-marker-current");
  assert.equal(marker, undefined);
});

test("renderVrLineChart shows the empty message when there is no cycle history yet", () => {
  const { sandbox } = loadApp();
  sandbox.renderVrLineChart([], null);
  assert.equal(sandbox.document.getElementById("vrLineEmpty").hidden, false);
});

test("renderVrLineChart plots one V line point per cycle plus the live-value series", () => {
  const { sandbox } = loadApp();
  const points = [
    { cycle_id: "TQQQ-c1", V: "18500.00", lower_band: "15725", upper_band: "21275", E_at_close: "16380.00" },
    { cycle_id: "TQQQ-c2", V: "18287.95", lower_band: "15544.76", upper_band: "21031.14", E_at_close: null },
  ];
  sandbox.renderVrLineChart(points, 19000);
  assert.equal(sandbox.document.getElementById("vrLineEmpty").hidden, true);
  const svg = sandbox.document.getElementById("vrLineSvg");
  const vDots = svg._children.filter(c => (c._attrs.class || "") === "vr-line-dot-v");
  const eDots = svg._children.filter(c => (c._attrs.class || "") === "vr-line-dot-e");
  assert.equal(vDots.length, 2, "one V dot per history point");
  // E_at_close for cycle 1, liveValue substituted for the still-open cycle 2.
  assert.equal(eDots.length, 2);
  const axisLabels = svg._children.filter(c => (c._attrs.class || "") === "vr-line-axis" && c.textContent.startsWith("TQQQ-"));
  assert.deepEqual(axisLabels.map(l => l.textContent), ["TQQQ-c1", "TQQQ-c2"]);
});

test("chart tab buttons toggle which view is visible (simulated click)", () => {
  const { sandbox } = loadApp();
  const gaugeView = sandbox.document.getElementById("vrGaugeView");
  const lineView = sandbox.document.getElementById("vrLineView");
  const gaugeBtn = sandbox.document.getElementById("vrChartGaugeBtn");
  const lineBtn = sandbox.document.getElementById("vrChartLineBtn");
  lineView.hidden = true; // initial HTML state: gauge shown by default

  lineBtn.dispatch("click");
  assert.equal(lineView.hidden, false, "clicking the line-chart tab must reveal it");
  assert.equal(gaugeView.hidden, true, "clicking the line-chart tab must hide the gauge");
  assert.equal(lineBtn.getAttribute("aria-pressed"), "true");
  assert.equal(gaugeBtn.getAttribute("aria-pressed"), "false");

  gaugeBtn.dispatch("click");
  assert.equal(gaugeView.hidden, false, "clicking the gauge tab must reveal it again");
  assert.equal(lineView.hidden, true);
  assert.equal(gaugeBtn.getAttribute("aria-pressed"), "true");
  assert.equal(lineBtn.getAttribute("aria-pressed"), "false");
});

test("fetchVrLiveValue multiplies position_qty by current_price from vr.refresh", async () => {
  const { sandbox } = loadApp({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, position_qty: "10", current_price: "110.5" }) }),
  });
  const value = await sandbox.fetchVrLiveValue("TQQQ");
  assert.equal(value, 1105);
});

test("fetchVrLiveValue returns null when the account cannot be reached (fail-closed, no crash)", async () => {
  const { sandbox } = loadApp({
    fetchImpl: async () => { throw new Error("network down"); },
  });
  const value = await sandbox.fetchVrLiveValue("TQQQ");
  assert.equal(value, null);
});

// --- summary --------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
