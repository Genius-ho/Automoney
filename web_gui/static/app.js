const symbols=["TQQQ","SOXL","KORU","UPRO","SPXL","TECL","FNGU","LABU","TNA","FAS","UDOW"];
const $=id=>document.getElementById(id);
const fields={symbol:null,current_price:$("currentPrice"),previous_close:$("previousClose"),cash_usd:$("cashUsd"),position_qty:$("positionQty"),avg_cost:$("avgCost"),t_value:$("tValue"),base_buy_qty:$("baseBuyQty"),mode:$("mode")};
let selectedSymbol="TQQQ",lastData=null,selectedOrderIds=new Set(),csrfToken="";

const number=(value,digits=2)=>{
  if(value===null||value===undefined||value==="")return"-";
  const parsed=Number(value);
  return Number.isFinite(parsed)?parsed.toLocaleString("en-US",{minimumFractionDigits:digits,maximumFractionDigits:digits}):"-";
};
function toast(message,error=false){const node=$("toast");node.textContent=message;node.className="toast show"+(error?" error":"");clearTimeout(toast.timer);toast.timer=setTimeout(()=>node.className="toast",3000)}
async function request(path,options={}){
  const response=await fetch(path,{...options,credentials:"include",headers:{"Content-Type":"application/json",...(options.headers||{})}});
  const payload=await response.json();
  if(response.status===403&&path!=="/api/auth/login"){
    csrfToken="";
    setAdminControls(false);
    setLiveButtons(false);
    $("webLogin").textContent="웹 로그인";
    showLoginDialog(payload.error||"웹 로그인이 필요합니다.");
  }
  if(!response.ok||payload.ok===false)throw new Error(payload.error||"요청에 실패했습니다.");
  return payload;
}
async function adminRequest(path,payload){if(!csrfToken)throw new Error("웹 로그인 후 비상 변경 기능을 사용할 수 있습니다.");return request(path,{method:"POST",headers:{"X-Mumae-CSRF":csrfToken},body:JSON.stringify(payload)})}
async function liveRequest(path,payload){return adminRequest(path,payload)}
function loading(button,on){button.disabled=on;button.dataset.label??=button.textContent;button.textContent=on?"처리 중…":button.dataset.label}
function setLiveButtons(enabled){["submitOrders","cancelOrders","startAuto","stopAuto"].forEach(id=>$(id).disabled=!enabled)}
function setAdminControls(enabled){["refreshAccount","calculatePlan","orderRefresh","editPrice","reconnect","historyRefresh","pnlRefresh","pairAnalyze","longTermAnalyze","apiSettings","currentPrice","previousClose","cashUsd","positionQty","avgCost","tValue","baseBuyQty","mode","bigPct","bigEnabled"].forEach(id=>$(id).disabled=!enabled)}

function buildTickers(){
  const box=$("tickerButtons");
  symbols.forEach(symbol=>{const button=document.createElement("button");button.textContent=symbol;button.dataset.symbol=symbol;button.addEventListener("click",()=>selectSymbol(symbol));box.append(button)});
}
function markTicker(){document.querySelectorAll("#tickerButtons button").forEach(button=>button.classList.toggle("active",button.dataset.symbol===selectedSymbol));$("guideTitle").textContent=selectedSymbol+" 무한매수법 가이드";$("realizedTitle").textContent=selectedSymbol+" 누적 실현손익";$("yahooChart").href="https://finance.yahoo.com/chart/"+selectedSymbol}

function setupTabs(){
  $("mainTabs").addEventListener("click",event=>{const button=event.target.closest("[data-tab]");if(!button)return;document.querySelectorAll("#mainTabs button").forEach(item=>item.classList.toggle("active",item===button));document.querySelectorAll(".tab-page").forEach(page=>page.classList.toggle("active",page.id==="tab-"+button.dataset.tab))});
  $("linkageTabs").addEventListener("click",event=>{const button=event.target.closest("[data-subtab]");if(!button)return;document.querySelectorAll("#linkageTabs button").forEach(item=>item.classList.toggle("active",item===button));document.querySelectorAll(".subtab-page").forEach(page=>page.classList.toggle("active",page.id==="subtab-"+button.dataset.subtab))});
}
function planPayload(){return{symbol:selectedSymbol,current_price:fields.current_price.value,previous_close:fields.previous_close.value,cash_usd:fields.cash_usd.value,position_qty:fields.position_qty.value,avg_cost:fields.avg_cost.value,t_value:fields.t_value.value,base_buy_qty:fields.base_buy_qty.value,mode:fields.mode.value,big_number_pct:$("bigPct").value,big_number_enabled:$("bigEnabled").checked}}
function fillState(state){selectedSymbol=state.symbol;fields.cash_usd.value=state.cash_usd;fields.position_qty.value=state.position_qty;fields.avg_cost.value=state.avg_cost;fields.t_value.value=state.t_value;fields.base_buy_qty.value=state.base_buy_qty;fields.mode.value=state.mode;$("bigPct").value=state.big_number_pct;$("bigEnabled").checked=state.big_number_enabled;$("tMetric").textContent=state.t_value;markTicker()}
function cell(row,text,className=""){const node=document.createElement("td");node.textContent=text;if(className)node.className=className;row.append(node)}

function renderOrders(orders=[]){
  const body=$("ordersBody");body.replaceChildren();
  const buys=[],sells=[];
  orders.forEach(order=>{const row=document.createElement("tr");row.dataset.orderId=order.id;row.classList.toggle("selected",selectedOrderIds.has(order.id));row.addEventListener("click",()=>{selectedOrderIds.has(order.id)?selectedOrderIds.delete(order.id):selectedOrderIds.add(order.id);row.classList.toggle("selected",selectedOrderIds.has(order.id))});cell(row,order.side==="buy"?"매수":"매도",order.side);cell(row,order.quantity);cell(row,number(order.price));cell(row,order.kind==="CLOSE_AUCTION"?"종가 LOC (LIMIT+CLS)":(order.reason.startsWith("Final")?"최종 지정가 (DAY)":"종가 LOC (LIMIT+CLS)"));cell(row,order.reason,"reason");cell(row,"조회 필요");cell(row,statusLabel(order.status));body.append(row);const guide=order.quantity+"주 @ $"+number(order.price);(order.side==="buy"?buys:sells).push(guide)});
  if(!orders.length){const row=document.createElement("tr");const node=document.createElement("td");node.colSpan=7;node.className="empty";node.textContent="현재 주문계획이 없습니다.";row.append(node);body.append(row)}
  $("buyGuide").textContent=buys.join("\n")||"현재 매수 주문 없음";$("sellGuide").textContent=sells.join("\n")||"현재 매도 주문 없음";
}
function statusLabel(status){return{UNSENT:"미전송 · 확인 필요",SKIPPED:"주문 거부 · 재시도 필요",UNCONFIRMED:"토스 확인 필요",PENDING:"접수됨",PARTIAL_FILLED:"부분 체결",PENDING_CANCEL:"취소 처리 중",PENDING_REPLACE:"정정 처리 중",FILLED:"체결 완료",CANCELED:"취소됨 · 재주문 가능",REJECTED:"주문 거부 · 재시도 필요",REPLACED:"정정 완료"}[status]||status||"미전송 · 확인 필요"}
function renderHoldings(holdings=[]){
  const body=$("holdingsBody");body.replaceChildren();
  holdings.forEach(holding=>{const row=document.createElement("tr"),sign=Number(holding.pnl)>=0?"positive":"negative";cell(row,holding.symbol);cell(row,number(holding.quantity,0));cell(row,number(holding.current_price));cell(row,number(holding.total_value));cell(row,holding.t_value);cell(row,number(holding.pnl),sign);cell(row,number(holding.pnl_pct),sign);body.append(row)});
  $("emptyHoldings").hidden=holdings.length>0;
}
function render(data){
  lastData=data;fillState(data.state);
  const metrics=data.metrics,quote=data.quote||{};
  if(quote.current_price!==null&&quote.current_price!==undefined){fields.current_price.value=quote.current_price;fields.previous_close.value=quote.previous_close??quote.current_price;$("quoteLine").textContent=selectedSymbol+" 현재가 $"+number(quote.current_price)+" | 전일 종가 $"+number(quote.previous_close)}
  $("totalAsset").textContent=number(metrics.total_asset);$("cashSummary").textContent=number(metrics.cash);$("positionValue").textContent=number(metrics.position_value);$("totalPnl").textContent=number(metrics.unrealized_pnl);
  $("starPct").textContent=(Number(metrics.star_pct)>=0?"+":"")+number(metrics.star_pct)+"%";$("starPrice").textContent=number(metrics.star_price);$("progress").textContent=number(metrics.progress_pct,1)+"%";$("progressBar").value=Number(metrics.progress_pct)||0;$("totalSeed").textContent="$"+number(metrics.total_seed);$("invested").textContent="$"+number(metrics.invested);
  const phase=data.state.mode==="GENERAL"?(Number(data.state.t_value)<20?"전반전":"후반전"):(data.state.mode==="REVERSE_FIRST_DAY"?"리버스 첫날":"리버스");$("strategyPhase").textContent=phase;
  renderOrders(data.orders||[]);renderHoldings(data.holdings||[]);
  const warnings=data.warnings||[];$("warnings").hidden=!warnings.length;$("warnings").textContent=warnings.join(" ");
  $("locSummary").textContent=data.loc_summary||"현재 전략 공식으로 주문계획을 계산합니다.";
  if(data.api_connected){$("apiHealth").textContent="토스 API 연결됨";$("apiHealth").style.color="#3182f6";$("brokerMode").textContent=data.broker_mode;$("statusText").textContent="토스 계좌·시세를 새로고침했습니다."}
}
async function loadInfo(){
  try{const data=await request("/api/etf-info?symbol="+encodeURIComponent(selectedSymbol));$("etfName").textContent=data.name;$("etfType").textContent=data.type;$("etfDescription").textContent=data.description;const body=$("etfHoldingsBody");body.replaceChildren();data.holdings.forEach(item=>{const row=document.createElement("tr");cell(row,item.ticker);cell(row,item.name);body.append(row)})}catch(error){toast(error.message,true)}
}
async function loadState(){try{const data=await request("/api/state?symbol="+encodeURIComponent(selectedSymbol));render(data);await loadInfo()}catch(error){toast(error.message,true)}}
async function selectSymbol(symbol){selectedSymbol=symbol;markTicker();await loadState()}

$("calculatePlan").addEventListener("click",async()=>{const button=$("calculatePlan");loading(button,true);try{const data=await adminRequest("/api/plan",planPayload());render(data);$("statusText").textContent="주문계획과 전략 상태를 저장했습니다.";toast("주문계획을 갱신했습니다.")}catch(error){toast(error.message,true)}finally{loading(button,false)}});
async function syncOrders(){const data=await adminRequest("/api/orders/sync",{symbol:selectedSymbol});selectedOrderIds.clear();renderOrders(data.orders);$("statusText").textContent=selectedSymbol+" 주문현황 동기화 완료 · 계획 외 OPEN "+data.unmatched_count+"건";return data}
async function refreshAccount(){const button=$("refreshAccount");loading(button,true);try{const data=await adminRequest("/api/account/refresh",{symbol:selectedSymbol});render(data);await syncOrders();toast("계좌·시세·주문현황을 새로고침했습니다.")}catch(error){$("apiHealth").textContent="API 연결 실패";$("statusText").textContent=error.message;toast(error.message,true)}finally{loading(button,false)}}
$("refreshAccount").addEventListener("click",refreshAccount);$("orderRefresh").addEventListener("click",async()=>{try{await syncOrders();toast("주문 상태를 새로고침했습니다.")}catch(error){toast(error.message,true)}});
$("reconnect").addEventListener("click",async()=>{try{const data=await adminRequest("/api/reconnect",{});$("apiHealth").textContent=data.api_connected?"토스 API 인증 준비됨":"API 설정 필요";$("brokerMode").textContent=data.broker_mode;toast("API 인증 객체를 새로 만들었습니다.")}catch(error){toast(error.message,true)}});
function showLoginDialog(message=""){
  $("loginError").textContent=message;
  const loginDialog=$("loginDialog");
  if(!loginDialog.open)loginDialog.showModal();
  $("webPassword").focus();
}
async function completeLogin(data){
  csrfToken=data.csrf||"";
  setAdminControls(true);
  setLiveButtons(data.live_enabled);
  $("webLogin").textContent="웹 로그인됨";
  const loginDialog=$("loginDialog");
  if(loginDialog.open)loginDialog.close();
  try{
    try{await loadApiSettings()}catch(error){console.warn("저장 설정 조회는 서버 재시작 후 적용됩니다.",error)}
    await refreshAccount();
    toast("Windows 현황과 토스 계좌 정보를 불러왔습니다.");
  }catch(error){
    $("apiHealth").textContent="API 설정 필요";
    $("apiHealth").style.color="#f04452";
    toast(error.message,true);
  }
}
$("webLogin").addEventListener("click",()=>{if(csrfToken)toast("이미 웹 로그인되어 있습니다.");else showLoginDialog()});
$("loginForm").addEventListener("submit",async event=>{
  event.preventDefault();
  const submit=event.submitter;
  loading(submit,true);
  try{
    const data=await request("/api/auth/login",{method:"POST",body:JSON.stringify({password:$("webPassword").value})});
    $("webPassword").value="";
    $("loginError").textContent="";
    await completeLogin(data);
  }catch(error){
    setAdminControls(false);
    setLiveButtons(false);
    showLoginDialog(error.message);
  }finally{loading(submit,false)}
});
$("toggleHoldings").addEventListener("click",()=>{const panel=$("holdingsPanel"),hidden=panel.hidden;panel.hidden=!hidden;document.querySelector(".content-grid").classList.toggle("holdings-hidden",!hidden);$("toggleHoldings").textContent=hidden?"보유종목 숨기기":"보유종목 보이기"});
$("algorithmGuide").addEventListener("click",()=>toast("무한매수 원리 안내 화면은 다음 이관 단계에서 연결합니다."));
const alias=$("accountAlias");alias.value=localStorage.getItem("mumae-account-alias")||"계좌 별명 입력";alias.addEventListener("change",()=>localStorage.setItem("mumae-account-alias",alias.value));

async function refreshHistory(){
  const start=$("historyStart").value;
  if(!start)throw new Error("집계 시작일을 입력하세요.");
  const data=await adminRequest("/api/history",{symbol:selectedSymbol,start_date:start});
  const summary=$("realizedBody");summary.replaceChildren();let row=document.createElement("tr");cell(row,data.symbol);cell(row,data.start_date);cell(row,number(data.realized_pnl));cell(row,data.unknown_sales?"원가 확인 필요 · 매도 "+data.unknown_sales+"건":"계산 완료");summary.append(row);
  const body=$("historyBody");body.replaceChildren();data.trades.forEach(trade=>{row=document.createElement("tr");cell(row,trade.trade_date);cell(row,trade.symbol);cell(row,trade.side==="BUY"?"매수":"매도",trade.side==="BUY"?"buy":"sell");cell(row,number(trade.quantity,0));cell(row,number(trade.average_price));cell(row,number(trade.commission));cell(row,trade.realized_pnl===null?"-":number(trade.realized_pnl));cell(row,trade.side==="BUY"||trade.realized_pnl!==null?"체결 완료":"원가 확인 필요");body.append(row)});
  $("statusText").textContent=selectedSymbol+" 거래내역·실현손익 갱신 완료";
}
$("historyStart").value=new Date().toISOString().slice(0,10);
$("historyRefresh").addEventListener("click",async()=>{try{await refreshHistory();toast("거래 내역을 갱신했습니다.")}catch(error){toast(error.message,true)}});
$("pnlRefresh").addEventListener("click",async()=>{try{await refreshHistory();toast("실현손익을 갱신했습니다.")}catch(error){toast(error.message,true)}});
$("editPrice").addEventListener("click",async()=>{if(selectedOrderIds.size!==1){toast("가격을 바꿀 실패 주문 한 건을 선택하세요.",true);return}const id=[...selectedOrderIds][0],price=prompt("새 지정가(USD)를 입력하세요.");if(price===null)return;try{const data=await adminRequest("/api/orders/edit-price",{symbol:selectedSymbol,id,price});render(data);toast(data.message)}catch(error){toast(error.message,true)}});

$("submitOrders").addEventListener("click",async()=>{const ids=[...selectedOrderIds];if(!ids.length){toast("전송할 주문을 선택하세요.",true);return}const expected="SUBMIT "+selectedSymbol+" "+ids.length,confirmation=prompt("실제 주문을 전송합니다. 아래 문구를 정확히 입력하세요.\n\n"+expected,"");if(confirmation===null)return;try{const data=await liveRequest("/api/orders/submit",{symbol:selectedSymbol,ids,confirmation});selectedOrderIds.clear();renderOrders(data.orders||[]);toast("실제 주문 확인 "+data.confirmed+"건 · 오류 "+data.errors.length+"건",data.errors.length>0)}catch(error){toast(error.message,true)}});
$("cancelOrders").addEventListener("click",async()=>{const ids=[...selectedOrderIds];if(!ids.length){toast("취소할 실제 주문을 선택하세요.",true);return}const expected="CANCEL "+selectedSymbol+" "+ids.length,confirmation=prompt("선택한 실제 주문을 취소합니다. 아래 문구를 정확히 입력하세요.\n\n"+expected,"");if(confirmation===null)return;try{const data=await liveRequest("/api/orders/cancel",{symbol:selectedSymbol,ids,confirmation});selectedOrderIds.clear();renderOrders(data.orders||[]);toast("취소 요청 "+data.canceled.length+"건 · 오류 "+data.errors.length+"건",data.errors.length>0)}catch(error){toast(error.message,true)}});
$("startAuto").addEventListener("click",async()=>{const count=lastData?.orders?.length||0;if(!count){toast("먼저 계좌·시세와 주문계획을 갱신하세요.",true);return}const expected="SUBMIT "+selectedSymbol+" "+count,confirmation=prompt("전체 계획을 실제 전송하고 자동매수를 시작합니다.\n아래 문구를 정확히 입력하세요.\n\n"+expected,"");if(confirmation===null)return;try{const data=await liveRequest("/api/auto/start",{symbol:selectedSymbol,confirmation});$("autoStatus").textContent="자동 매수: ACTIVE · "+data.active_symbols.join(", ");toast(selectedSymbol+" 자동매수를 시작했습니다.")}catch(error){toast(error.message,true)}});
$("stopAuto").addEventListener("click",async()=>{try{const data=await liveRequest("/api/auto/stop",{symbol:selectedSymbol});$("autoStatus").textContent=data.auto_enabled?"자동 매수: ACTIVE · "+data.active_symbols.join(", "):"자동 매수: STOPPED";toast(selectedSymbol+" 자동매수를 중지했습니다.")}catch(error){toast(error.message,true)}});

$("pairAnalyze").addEventListener("click",async()=>{const button=$("pairAnalyze");loading(button,true);try{const data=await adminRequest("/api/analysis/pairs",{}),body=$("pairBody");body.replaceChildren();data.pairs.forEach((item,index)=>{const row=document.createElement("tr");cell(row,index+1);cell(row,item.first+" + "+item.second);cell(row,number(Number(item.correlation)*100,1));cell(row,number(item.spread_volatility,1));cell(row,number(item.portfolio_volatility,1));cell(row,number(item.opportunity_risk_ratio,2));cell(row,number(item.score,1));cell(row,item.recommendation);body.append(row)});toast("ETF 연동률 분석을 완료했습니다.")}catch(error){toast(error.message,true)}finally{loading(button,false)}});
$("longTermAnalyze").addEventListener("click",async()=>{const button=$("longTermAnalyze");loading(button,true);try{const data=await adminRequest("/api/analysis/long-term",{}),body=$("longTermBody");body.replaceChildren();data.results.forEach((item,index)=>{const row=document.createElement("tr");cell(row,index+1);cell(row,item.symbol);cell(row,item.start_date);cell(row,item.end_date);cell(row,number(item.end_value,0));cell(row,number(item.total_return_pct,1));cell(row,number(item.cagr_pct,1));cell(row,number(item.max_drawdown_pct,1));cell(row,number(item.score,1));cell(row,item.recommendation);body.append(row)});toast("장기성과 분석을 완료했습니다.")}catch(error){toast(error.message,true)}finally{loading(button,false)}});

document.querySelectorAll("table").forEach(table=>table.querySelectorAll("th").forEach((header,index)=>header.addEventListener("dblclick",()=>{const body=table.tBodies[0],rows=[...body.rows],descending=header.dataset.sort!=="desc";rows.sort((a,b)=>{const av=a.cells[index]?.textContent.replace(/[$,%]/g,"").trim()||"",bv=b.cells[index]?.textContent.replace(/[$,%]/g,"").trim()||"",an=Number(av.replaceAll(",","")),bn=Number(bv.replaceAll(",",""));const result=Number.isNaN(an)||Number.isNaN(bn)?av.localeCompare(bv,"ko"):an-bn;return descending?-result:result});rows.forEach(row=>body.append(row));header.dataset.sort=descending?"desc":"asc"})));

async function reconnectApi(){
  const data=await adminRequest('/api/reconnect',{});
  $('apiHealth').textContent=data.api_connected?'토스 API 연결됨':'API 설정 필요';
  $('apiHealth').style.color=data.api_connected?'#3182f6':'#f04452';
  $('brokerMode').textContent=data.broker_mode;
  return data;
}

function fillApiSettings(settings){
  $('apiClientId').value=settings.client_id||'';
  $('apiAccountSeq').value=settings.account_seq||'';
  $('apiLiveTrading').checked=Boolean(settings.live_trading);
  $('apiClientSecret').value='';
  $('apiClientSecret').required=!settings.secret_configured;
  $('apiClientSecret').placeholder=settings.secret_configured?'저장된 Secret Key 사용':'Secret Key 입력';
  $('apiSecretHelp').textContent=settings.secret_configured
    ?'Secret Key가 안전하게 저장되어 있습니다. 변경할 때만 새 값을 입력하세요.'
    :'저장 전에 계좌 조회로 API 정보를 검증합니다. Secret Key를 입력하세요.';
}

async function loadApiSettings(){
  const settings=await adminRequest('/api/command',{command:'api.settings',payload:{}});
  fillApiSettings(settings);
  return settings;
}

const oldApiSettings=$('apiSettings');
const apiSettingsButton=oldApiSettings.cloneNode(true);
oldApiSettings.replaceWith(apiSettingsButton);
apiSettingsButton.disabled=true;
apiSettingsButton.addEventListener('click',async()=>{
  try{
    await loadApiSettings();
    $('apiDialog').showModal();
  }catch(error){toast(error.message,true)}
});
$('apiCancel').addEventListener('click',()=>$('apiDialog').close());
$('apiForm').addEventListener('submit',async event=>{
  event.preventDefault();
  const submit=event.submitter;
  loading(submit,true);
  try{
    const data=await adminRequest('/api/command',{command:'api.update',payload:{
      client_id:$('apiClientId').value,
      client_secret:$('apiClientSecret').value,
      account_seq:$('apiAccountSeq').value,
      live_trading:$('apiLiveTrading').checked
    }});
    $('apiClientSecret').value='';
    $('apiDialog').close();
    $('apiHealth').textContent='토스 API 연결됨';
    $('apiHealth').style.color='#3182f6';
    $('brokerMode').textContent=data.broker_mode;
    fillApiSettings(data.settings);
    toast('토스 API 정보를 검증하고 저장했습니다.');
  }catch(error){toast(error.message,true)}
  finally{loading(submit,false)}
});

async function loadAuthStatus(){
  try{
    const data=await request("/api/auth/status");
    if(data.authenticated){
      await completeLogin(data);
      return;
    }
    csrfToken="";
    setAdminControls(false);
    setLiveButtons(false);
    $("webLogin").textContent=data.configured?"웹 로그인":"웹 비밀번호 미설정";
    showLoginDialog();
  }catch(error){
    csrfToken="";
    setAdminControls(false);
    setLiveButtons(false);
    showLoginDialog(error.message);
  }
}
setAdminControls(false);setLiveButtons(false);buildTickers();setupTabs();markTicker();loadState();loadAuthStatus();
