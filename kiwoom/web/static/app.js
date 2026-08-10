const $ = (id) => document.getElementById(id);

let csrf = "";
let currentProfile = "";
let lastPlan = null;

const money = (value) => {
  if (value === null || value === undefined || value === "") return "-";
  const num = Number(value);
  return (num < 0 ? "-$" : "$") + Math.abs(num).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const number = (value, digits = 0) =>
  value === null || value === undefined || value === "" ? "-" : Number(value).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });

function setMessage(text, error = false) {
  $("message").textContent = text;
  $("message").style.color = error ? "#f04452" : "#4e5968";
}

function showLogin(message = "") {
  $("app").hidden = true;
  $("loginError").textContent = message;
  const password = $("password");
  password.value = "";
  password.type = "password";
  $("togglePassword").textContent = "표시";
  $("togglePassword").setAttribute("aria-pressed", "false");
  const dialog = $("loginDialog");
  if (!dialog.open) dialog.showModal();
  password.focus();
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(csrf ? { "X-Kiwoom-CSRF": csrf } : {}),
      ...(options.headers || {}),
    },
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("서버가 올바른 JSON을 반환하지 않았습니다.");
  }
  if (response.status === 401 || response.status === 403) {
    csrf = "";
    showLogin(payload.error || "다시 로그인하세요.");
  }
  if (!response.ok || payload.ok === false) throw new Error(payload.error || "요청에 실패했습니다.");
  return payload;
}

function cell(row, text) {
  const td = document.createElement("td");
  td.textContent = text;
  row.append(td);
}

function renderStatus(status) {
  $("profileTitle").textContent = `${status.profile} (${status.symbol}) · 자녀 VR 계좌`;
  $("statusTitle").textContent = `${status.profile} (${status.symbol})`;
  $("metricV").textContent = money(status.v);
  $("metricBand").textContent = `${money(status.band_low)} ~ ${money(status.band_high)}`;
  $("metricShares").textContent = number(status.shares) + "주";
  $("metricPool").textContent = money(status.pool);
  $("statG").textContent = status.g;
  $("statContribution").textContent = money(status.contribution);
  $("statCycleLen").textContent = status.cycle_length_days + "일";
  $("statCycleStart").textContent = status.cycle_start_date;
  $("statCyclesDone").textContent = status.cycles_completed;
  $("statPoolCap").textContent = money(status.pool * status.pool_usage_cap_pct) + ` (${Math.round(status.pool_usage_cap_pct * 100)}%)`;
  $("statPoolSpent").textContent = money(status.cycle_buy_spent) + ` / ${money(status.cycle_pool_budget)}`;

  const body = $("tradeBody");
  body.replaceChildren();
  const trades = status.trades || [];
  trades.slice().reverse().forEach((trade) => {
    const row = document.createElement("tr");
    cell(row, trade.day);
    cell(row, trade.side === "BUY" ? "매수" : "매도");
    cell(row, number(trade.shares) + "주");
    cell(row, money(trade.price));
    body.append(row);
  });
  $("emptyTrades").hidden = trades.length > 0;
}

async function loadStatus(profile) {
  if (!profile) return;
  currentProfile = profile;
  const status = await api(`/api/status?profile=${encodeURIComponent(profile)}`);
  renderStatus(status);
  $("lastUpdatedAt").textContent = "마지막 갱신 · " + new Date().toLocaleTimeString("ko-KR");
}

function renderProfilePicker(profiles) {
  const picker = $("profilePicker");
  picker.querySelectorAll("label").forEach((el) => el.remove());
  profiles.forEach((profile, index) => {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "profile";
    input.value = profile;
    if (profile === currentProfile || (!currentProfile && index === 0)) input.checked = true;
    const span = document.createElement("span");
    span.textContent = profile;
    label.append(input, span);
    picker.append(label);
    input.addEventListener("change", () => loadStatus(profile));
  });
}

async function refreshAll() {
  const { profiles } = await api("/api/profiles");
  renderProfilePicker(profiles);
  const selected = document.querySelector('input[name="profile"]:checked')?.value;
  if (selected) {
    await loadStatus(selected);
    setMessage("최신 상태를 불러왔습니다.");
  } else {
    setMessage("프로필이 없습니다. '새 프로필 만들기'로 시작하세요.");
  }
}

$("refresh").addEventListener("click", () => refreshAll().catch((error) => setMessage(error.message, true)));

$("logout").addEventListener("click", async () => {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } finally {
    showLogin();
  }
});

$("togglePassword").addEventListener("click", () => {
  const password = $("password");
  const show = password.type === "password";
  password.type = show ? "text" : "password";
  $("togglePassword").textContent = show ? "숨기기" : "표시";
  $("togglePassword").setAttribute("aria-pressed", String(show));
});

$("loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const result = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ password: $("password").value }) });
    csrf = result.csrf;
    $("loginDialog").close();
    $("app").hidden = false;
    await refreshAll();
  } catch (error) {
    $("loginError").textContent = error.message;
  }
});

$("newProfileBtn").addEventListener("click", () => {
  $("newProfileError").textContent = "";
  $("newProfileDialog").showModal();
});
$("newProfileCancel").addEventListener("click", () => $("newProfileDialog").close());

$("newProfileForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/profiles", {
      method: "POST",
      body: JSON.stringify({
        profile: $("npProfile").value.trim(),
        symbol: $("npSymbol").value.trim().toUpperCase(),
        cash: Number($("npCash").value),
        price: Number($("npPrice").value),
        g: Number($("npG").value),
        band_pct: Number($("npBand").value) / 100,
        contribution: Number($("npContribution").value),
        cycle_length_days: Number($("npCycleDays").value),
      }),
    });
    $("newProfileDialog").close();
    currentProfile = $("npProfile").value.trim();
    await refreshAll();
  } catch (error) {
    $("newProfileError").textContent = error.message;
  }
});

$("planForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!currentProfile) return setMessage("먼저 프로필을 선택하세요.", true);
  try {
    const result = await api("/api/plan", {
      method: "POST",
      body: JSON.stringify({ profile: currentProfile, price: Number($("planPrice").value), apply: false }),
    });
    lastPlan = result.plan;
    if (result.rolled) setMessage("사이클이 갱신되어 상태가 저장되었습니다.");
    if (result.plan) {
      $("planResult").hidden = false;
      $("planEmpty").hidden = true;
      $("planSummary").textContent =
        `${result.plan.side === "BUY" ? "매수" : "매도"} ${result.plan.shares}주 @ ${money(result.plan.price)} ` +
        `-> 거래 후 보유 ${result.plan.resulting_shares}주, Pool ${money(result.plan.resulting_pool)}`;
    } else {
      $("planResult").hidden = true;
      $("planEmpty").hidden = false;
      $("planEmpty").textContent = "현재 밴드 안입니다. 거래 없음.";
    }
    renderStatus(result.status);
  } catch (error) {
    setMessage(error.message, true);
  }
});

$("planApply").addEventListener("click", async () => {
  if (!currentProfile || !lastPlan) return;
  try {
    const result = await api("/api/plan", {
      method: "POST",
      body: JSON.stringify({ profile: currentProfile, price: lastPlan.price, apply: true }),
    });
    renderStatus(result.status);
    setMessage("계획을 상태에 적용했습니다 (실주문 아님).");
    $("planResult").hidden = true;
    lastPlan = null;
  } catch (error) {
    setMessage(error.message, true);
  }
});

(async function bootstrap() {
  try {
    const status = await api("/api/auth/status");
    if (status.authenticated) {
      csrf = status.csrf;
      $("app").hidden = false;
      await refreshAll();
    } else {
      showLogin();
    }
  } catch (error) {
    showLogin(error.message);
  }
})();
