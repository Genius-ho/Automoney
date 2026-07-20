# ETF별 신규 주문 시작·중지 / Down Ladder 단계 선택 / 자동 주문 지연시간 설정 — 설계 문서

- 작성일: 2026-07-20
- 대상 서비스: `web_gui/dashboard/*` (V2, `mumae_cli.py serve` / `run_web.sh`가 실제로 띄우는 화면). `web_gui/server.py` + `web_gui/static/*`(구버전 WEB.0.2)는 더 이상 서비스되지 않아 범위에서 제외.
- 구현 코드는 아직 작성하지 않았음. 이 문서는 설계 + 구현 계획이며 사용자 승인 후 "테스트 먼저 작성 → 구현" 순서로 진행 예정.

---

## 0. 요약

세 가지 기능을 추가한다.

1. **ETF별 신규 주문 시작·중지** — 중지는 "신규 주문 생성/전송만" 차단. 기존 미체결 주문 취소, 체결 동기화, 계좌/잔고/보유종목 조회는 계속.
2. **ETF별 Down Ladder 활성 단계 선택** — 1·2단계는 항상 켜짐(해제 불가), 3·4·5단계는 ETF별 독립 체크박스. 기본값 `[1, 2]`.
3. **(추가 요청) 자동 주문 시작 지연시간 설정** — 현재 하드코딩된 "시장 개장 후 15분"(현재 사용자 환경에서 체감상 10:45) 지연을 웹 GUI에서 조절 가능하게 함.

세 기능 모두 기존 `state.json` / `runtime.json` 데이터 구조에 **필드를 추가**하는 방식으로만 확장하며, 기존 키를 이름 변경하거나 삭제하지 않는다. 기존 JSON 파일은 `dataclass` 기본값 매커니즘 덕분에 별도 마이그레이션 스크립트 없이 자동으로 상위 호환된다 (§8 참고).

---

## 1. 수정할 파일 목록

| 파일 | 변경 내용 |
|---|---|
| `mumae_core.py` | `StrategyState`에 `down_ladder_enabled_levels` 필드 추가, `validate()`에 검증 규칙 추가, `build_plan()`이 비활성 단계의 ladder 주문을 생성하지 않도록 필터링 |
| `state_store.py` | (대부분 dataclass 기본값으로 자동 처리되지만) 레거시 값 정규화 방어 코드 추가 |
| `runtime_store.py` | `RuntimeStatus`에 `known_symbols`, `last_auto_attempt_at`, `last_auto_error`, `auto_order_delay_minutes` 필드 추가 |
| `web_gui/web_service.py` | `update_state()`가 `down_ladder_enabled_levels` payload를 반영하도록 확장, `dashboard()` 출력에 ladder 설정 노출 |
| `web_gui/trading_service.py` | `start_auto` / `stop_auto` / `auto_tick`을 "동기화 단계"와 "신규주문 단계"로 분리, 미체결 주문 수 계산 헬퍼 추가, `auto_tick`이 설정 가능한 지연시간(`auto_order_delay_minutes`)을 사용하도록 변경 |
| `application_engine.py` | `_dispatch()`의 `order.submit` 분기에 "신규 주문 차단" 가드 추가, `etf_overview()` 신규 메서드, `strategy.set_ladder_levels` / `schedule.update` 명령 추가 |
| `web_gui/dashboard/service.py` | `DashboardService` / `EngineDashboardService`가 `etf_overview`, `down_ladder_enabled_levels`, `auto_order_delay_minutes`를 응답에 포함 |
| `web_gui/dashboard/server.py` | 읽기 전용 폴링용 `GET /api/etf-status` 라우트 추가 (기존 `/api/command`는 그대로 재사용) |
| `web_gui/dashboard/static/index.html` | ETF별 행 테이블(상태/시작/중지/마지막 실행시각/최근 오류/미체결 수/Down Ladder 체크박스) + 자동 주문 지연시간 입력 UI 추가 |
| `web_gui/dashboard/static/app.js` | 위 테이블 렌더링, 버튼 클릭 핸들러(`auto.start`/`auto.stop`/`strategy.set_ladder_levels`/`schedule.update`), 주기적 폴링 |
| `web_gui/dashboard/static/styles.css` | 상태 배지, 체크박스, 새 테이블 스타일 |
| `tests/test_mumae_core.py` | Down Ladder 필터링 회귀/기능 테스트 |
| `tests/test_state_store.py` | 레거시 파일 하위호환(기본값 `[1,2]`) 테스트 |
| `tests/test_runtime_store.py` | 신규 필드 저장/복원 라운드트립 테스트 |
| `tests/test_web_trading.py` | 중지 시 신규주문 차단/동기화 계속/취소 안 함/다른 ETF 영향 없음/재주문·대체주문 차단/Down Ladder 필터/현금 계산 테스트 |
| `tests/test_application_engine.py` | 커맨드 레벨 가드, `etf_overview`, 락(중복 실행 방지), 유효성 검증(잘못된 단계 번호, 중복, 존재하지 않는 ETF) 테스트 |
| `tests/test_web_dashboard.py` | `/api/etf-status`, `/api/command`의 새 커맨드 라운드트립 테스트 (fake broker) |

기존 데이터 파일(`data/state.json`, `data/runtime.json`, `data/toss.env`, `secure_credentials.dat`)은 **직접 건드리지 않는다.** 모든 테스트는 `tempfile.TemporaryDirectory()`로 격리된 별도 경로만 사용한다 (기존 테스트 스위트와 동일한 관례).

---

## 2. 현재 주문 생성 및 상태 저장 흐름 (분석 결과)

```
[상태 저장]
state.json  (StateStore)   → 종목별 StrategyState (position_qty, avg_cost, t_value, cash_usd, base_buy_qty, big_number_*, ...)
runtime.json (RuntimeStore) → 전역 RuntimeStatus (auto_enabled, phase, active_symbols, broker_order_ids, skipped_order_ids, ...)

[주문 계획 생성 - 순수 함수, 부작용 없음]
mumae_core.build_plan(state, current_price, ...)
  → StrategyState.mode 에 따라 진입/스타/평균/사다리(Down Ladder)/분할매도 주문(OrderIntent)을 계산
  → Down Ladder: down_ladder_prices(amount, anchor, steps=5) 로 1~5단계 가격을 계산하고
    build_plan이 각 단계를 base_buy_qty 수량으로 orders 리스트에 추가 (현재는 항상 5단계 전부)

[주문 전송 - 유일한 진입점]
web_gui/trading_service.py: TradingWebService.submit_orders(symbol, ids, confirmation, all_pending=False)
  - 이 함수 하나가 신규 주문 전송의 유일한 통로.
  - 내부의 _submit_one()이 "price-out-of-range" 거부 시 AUTO_REPRICE_SYMBOLS(KORU, SOXL)에 한해
    가격을 보정한 대체 주문을 자동 재전송 (= "거부 주문 재주문/대체 주문"의 실체)
  - 호출부 3곳: (a) 사용자가 UI에서 직접 orders.submit 명령, (b) start_auto()의 최초 배치 전송,
    (c) auto_tick()의 자동 배치 전송

[자동 루프]
web_gui/dashboard/server.py: _auto_loop() — 백그라운드 스레드 1개, 60초 간격으로 engine.auto_tick() 호출
  (MUMAE_WEB_LIVE_ACTIONS=I_UNDERSTAND_WEB_LIVE_TRADING + 웹 비밀번호가 설정된 경우에만 기동)
application_engine.py: ApplicationEngine.auto_tick()
  → self.command_lock (전역 RLock) 으로 감싸서 TradingWebService.auto_tick() 호출
    (이 락이 수동 명령 실행(execute())과 자동 틱이 서로 겹치지 않게 이미 직렬화함)
web_gui/trading_service.py: TradingWebService.auto_tick()  (핵심 로직, 현재 283~415줄)
  1. runtime.auto_enabled / runtime.active_symbols 가 비어있으면 즉시 리턴
  2. 오늘 미국 시장 캘린더 조회 → "정규장 시작 + 15분(하드코딩)" ~ "정규장 종료" 구간에만 진행
     (web_gui/trading_service.py:396  `if start + timedelta(minutes=15) <= now <= end:`)
     → 사용자가 말한 "10:45 고정"은 이 15분 지연값이 원인으로 추정됨 (§10 참고)
  3. active_symbols 에 있는 심볼만 순회 (여기가 핵심 문제 지점):
     refresh_account → sync_orders(체결 동기화 포함) → submit_orders(all_pending=True, 신규주문)
     → active_symbols 에서 빠진(=중지된) 심볼은 이 루프에서 통째로 스킵되어
       체결 동기화·계좌 조회까지 같이 멈춘다 (요구사항과 불일치, 이번에 수정 대상)

[상태 복원]
WebService.__init__() 에서 RuntimeStore.load()/StateStore.load() 로 매 프로세스 시작 시 즉시 복원됨
→ active_symbols, state.json 의 각 종목 필드는 이미 재부팅 복원이 보장되어 있음
```

---

## 3. ETF별 신규 주문 중지 상태의 저장 구조

`runtime.json` (`RuntimeStore` / `RuntimeStatus`, 전역 1개 파일에 전역 1개 객체, 원자적 쓰기 `os.replace`)에 필드 추가:

```jsonc
{
  "active_symbols": ["TQQQ", "SOXL"],     // 기존 필드, 키 이름 유지 (하위호환).
                                            // 의미를 "신규 주문(new_orders) 허용 심볼 목록"으로 명확화해서 문서화·주석만 추가.
  "known_symbols": ["TQQQ", "SOXL", "KORU"], // 신규 필드. 한 번이라도 start_auto 된 심볼은 stop_auto 해도 여기서 빠지지 않음
                                              // → auto_tick의 "동기화 단계" 대상 목록으로 사용
  "last_auto_attempt_at": {"TQQQ": "2026-07-20T09:45:03+00:00"}, // 신규 필드. 심볼별 마지막 "신규 주문 시도" 시각
  "last_auto_error": {"KORU": "가격 범위를 벗어난 주문입니다."},   // 신규 필드. 심볼별 마지막 오류 메시지 (성공 시 해당 키 제거)
  "auto_order_delay_minutes": 15           // §10. 전역 설정값 (기본 15, 기존 하드코딩 값과 동일하게 시작)
}
```

**내부 의미론 (사용자 요청의 `new_orders_enabled` 요구사항 반영):**
JSON 키 이름은 하위 호환을 위해 `active_symbols`를 그대로 쓰지만, 코드 상에서는 이를 직접 노출하지 않고 아래와 같은 명확한 accessor를 통해서만 참조한다.

```python
def new_orders_enabled(self, symbol: str) -> bool:
    return symbol in self.runtime.active_symbols
```

`stop_auto(symbol)`은 `active_symbols`에서만 제거하고 `known_symbols`는 유지한다. `broker.cancel_order()`를 호출하는 코드는 추가하지 않는다 (`order.cancel` 명령은 사용자가 명시적으로 호출할 때만 여전히 존재).

**미체결 주문 수**는 영속화하지 않는다. `sync_orders()`가 채우는 인메모리 `order_statuses` / `unmatched_orders` (기존 `web_gui/trading_service.py` 필드)에서 `OPEN_STATUSES`(`PENDING`, `PARTIAL_FILLED`, `PENDING_CANCEL`, `PENDING_REPLACE`) 개수를 그때그때 계산한다. 재부팅 직후에는 0으로 보이다가 첫 동기화 후 채워진다 — 데이터 손상이 아니라 "최근 동기화 스냅샷" 의미이므로 UI에 "동기화 시각" 문구를 같이 표기해 혼동을 줄인다.

---

## 4. ETF별 Down Ladder 설정의 저장 구조

`state.json`은 이미 종목별(`portfolios[symbol]`)로 완전히 분리된 구조이므로, 여기에 필드만 추가한다. **새 API나 새 파일을 만들지 않는다.**

```python
# mumae_core.py StrategyState
@dataclass
class StrategyState:
    ...
    down_ladder_enabled_levels: list[int] = field(default_factory=lambda: [1, 2])
```

```jsonc
// state.json
{
  "version": 2,
  "portfolios": {
    "KORU": { "...": "...", "down_ladder_enabled_levels": [1, 2] },
    "SOXL": { "...": "...", "down_ladder_enabled_levels": [1, 2, 3] }
  }
}
```

요청하신 예시(`{"KORU": {"down_ladder_enabled_levels": [1,2]}, ...}`)와 동일한 "심볼 → 단계 목록" 의미를 갖되, 기존 종목별 상태 오브젝트 안에 자연스럽게 편입시켜 별도 저장 파일을 만들지 않는다.

**검증 규칙 (`StrategyState.validate()`에 추가):**
```python
levels = self.down_ladder_enabled_levels
if len(set(levels)) != len(levels):
    raise ValueError("Down ladder 단계 번호가 중복되었습니다.")
if not set(levels) <= {1, 2, 3, 4, 5}:
    raise ValueError("Down ladder 단계는 1~5 사이여야 합니다.")
if not {1, 2} <= set(levels):
    raise ValueError("Down ladder 1·2단계는 항상 활성화되어야 합니다.")
```
ETF 존재 여부 검증은 기존 `_dispatch()`의 `symbol not in ETF_UNIVERSE` 체크를 그대로 재사용한다.

**`build_plan()` 변경 (mumae_core.py, 현재 207~209줄 부근):**
```python
amount = money(ladder_anchor * base_qty)
enabled = set(state.down_ladder_enabled_levels)
for index, price in enumerate(down_ladder_prices(amount, ladder_anchor, ladder_steps), start=1):
    if index not in enabled:
        continue
    orders.append(OrderIntent(_order_id(state, today, f"ladder-{index}"), "buy", base_qty, price, OrderKind.LIMIT, f"Down ladder {index}/{ladder_steps}"))
```
`down_ladder_prices()`의 계산식 자체(가격 공식)는 변경하지 않는다 — 각 단계 가격은 `amount / (base_qty + k)`로 단계 인덱스 `k`에만 의존하는 독립 계산이므로, "생성 후 필터링" 방식이 기존 공식을 전혀 건드리지 않고 요구사항(활성 단계만 주문계획/금액계산에 포함)을 만족시킨다. `buy_notional` 경고 계산(219~221줄)은 최종 `orders` 리스트를 합산하므로 자동으로 비활성 단계를 제외하게 된다.
호출부(`web_service.py: dashboard()`, `dashboard/service.py: _daily_plan()`, `scheduler.py`)는 이미 `state` 객체를 넘기고 있어 **시그니처 변경이 필요 없다.**

거부 주문 재시도/대체 주문(`_submit_one`)도 `submit_orders()`가 넘겨받는 `order` 목록(=`build_plan` 결과에서 파생된 `plan_cache`) 안에서만 동작하므로, 애초에 비활성 단계 주문 자체가 계획에 없으면 재시도 대상도 되지 않는다 — 별도 가드가 필요 없다.

---

## 5. 추가할 API 엔드포인트

기존 `/api/command` (POST, `{command, payload}`) 구조를 그대로 재사용하고, 새 HTTP 라우트는 최소화한다.

| 구분 | 엔드포인트 | 설명 |
|---|---|---|
| 재사용 | `POST /api/command` `{"command":"auto.start","payload":{"symbol":"KORU","confirmation":"SUBMIT KORU 7"}}` | 기존 명령 그대로. 이번 작업은 "웹 GUI에 버튼을 새로 노출"하는 것이지 백엔드 명령 자체는 이미 존재 |
| 재사용 | `POST /api/command` `{"command":"auto.stop","payload":{"symbol":"KORU"}}` | 기존 명령 그대로 |
| 신규 | `POST /api/command` `{"command":"strategy.set_ladder_levels","payload":{"symbol":"KORU","levels":[1,2,3]}}` | 내부적으로 `update_state()`를 얇게 감싸 호출. `symbol`/`levels`만 받는 좁은 payload로 검증 책임을 명확히 하고 감사로그(`audit.jsonl`)에 별도 커맨드명으로 남겨 추적성 확보 |
| 신규 | `POST /api/command` `{"command":"schedule.update","payload":{"delay_minutes":20}}` | §10. `auto_order_delay_minutes` 갱신. 0~120 범위 검증 |
| 신규 | `GET /api/etf-status` (인증 필요, 세션 쿠키+CSRF) | 11개 ETF 전체에 대해 `{symbol, running, last_order_at, last_error, pending_orders, down_ladder_enabled_levels}` 배열 반환. 테이블 폴링 전용, 사이드이펙트 없음(브로커 신규 호출 없이 마지막으로 동기화된 인메모리 값만 반환) |

`order.submit`/`order.cancel`/`auto.start`/`auto.stop`/`api.update`와 마찬가지로 신규 커맨드(`strategy.set_ladder_levels`, `schedule.update`)도 `web_gui/dashboard/server.py`의 기존 라이브 액션 게이트(`MUMAE_WEB_LIVE_ACTIONS` 확인 목록)에 포함시킬지는 검토 필요 — Down Ladder 설정/지연시간 설정 자체는 주문을 전송하지 않는 "설정 변경"이므로 게이트에서 제외하는 편이 사용성이 낫다고 판단되나, 최종 결정은 구현 단계에서 코드 리뷰 시 확정.

---

## 6. 웹 GUI 변경 위치

`web_gui/dashboard/static/index.html`에 기존 "선택 ETF 단일 뷰" 위에 새 섹션 추가:

```
┌ ETF 자동매매 현황 ─────────────────────────────────────────────────────────┐
│ 종목   상태          시작   중지   마지막 신규주문시각   최근 오류   미체결   Down Ladder        │
│ TQQQ  실행 중        [·]   [정지]  07-20 09:45:03      -          1건      ☑1 ☑2 ☐3 ☐4 ☐5   │
│ KORU  신규 주문 중지  [시작] [·]    07-20 09:30:11      가격 범위… 2건      ☑1 ☑2 ☐3 ☐4 ☐5   │
│ SOXL  실행 중        [·]   [정지]  07-20 09:45:07      -          0건      ☑1 ☑2 ☑3 ☐4 ☐5   │
│ ...   (총 11행, mumae_core.ETF_UNIVERSE 순서)                                              │
└──────────────────────────────────────────────────────────────────────────────────────────┘
자동 주문 시작 지연: [ 15 ] 분 (시장 개장 후)  [저장]
```

- `app.js`: `renderEtfOverview(list)` 신규 함수 — `/api/etf-status` 폴링 결과로 표를 채움. 상태 배지는 기존 `.status-badge` 클래스(`active`/`stopped`) 재사용.
- 시작 버튼: 클릭 시 해당 심볼의 현재 주문계획 건수를 먼저 조회해 `SUBMIT {symbol} {count}` 확인문구를 구성한 뒤 `auto.start` 전송 (기존 WEB.0.2의 확인문구 패턴을 그대로 계승).
- 중지 버튼: 확인문구 없이 바로 `auto.stop` 전송 (백엔드도 확인문구를 요구하지 않음).
- Down Ladder 체크박스: 1·2단계는 `disabled checked`로 렌더링(해제 불가), 3·4·5단계만 change 이벤트로 `strategy.set_ladder_levels` 전송. KORU 체크박스 조작이 SOXL 상태에 영향을 주지 않도록 각 행이 독립적인 payload(symbol 포함)를 전송 — 서버 측에서도 종목별로 완전히 분리된 `state.json` 항목에 저장되므로 교차 오염 불가능.
- 새 설정 입력창(자동 주문 지연 분): `schedule.update` 전송.
- `styles.css`: 체크박스 비활성 스타일, 상태 배지 색상 정도의 최소 추가만 필요 (기존 카드/테이블 스타일 재사용).

---

## 7. 작성할 테스트 목록 (구현보다 먼저 작성)

요청하신 12개 항목 + Down Ladder/스케줄 관련 보강 테스트를 파일별로 매핑:

**`tests/test_mumae_core.py`**
- `test_default_down_ladder_levels_are_one_and_two` — 신규 `StrategyState()`의 기본값이 `[1, 2]` (요구사항 1)
- `test_build_plan_only_includes_enabled_ladder_levels` — `levels=[1,2,4]`일 때 3·5단계 주문이 계획에 없는지 (요구사항 3)
- `test_build_plan_buy_notional_excludes_disabled_levels` — 경고/필요금액 계산에 비활성 단계 미포함 (요구사항 4)
- `test_validate_rejects_invalid_or_duplicate_or_missing_required_levels` — 잘못된 번호/중복/1·2 누락 시 `ValueError`
- `test_down_ladder_price_formula_unchanged` — 기존 `test_verified_down_ladder_example` 등 기존 테스트가 그대로 통과하는지 확인(회귀)

**`tests/test_state_store.py`**
- `test_missing_down_ladder_levels_defaults_to_one_and_two` — 필드가 없는 레거시 JSON 로드 시 `[1,2]` (요구사항 1, 8)
- `test_down_ladder_levels_are_independent_per_symbol` — KORU와 SOXL을 각각 저장 후 서로 영향 없는지 (요구사항 2, 7)

**`tests/test_runtime_store.py`**
- `test_known_symbols_last_attempt_and_error_round_trip` — 신규 필드 저장/복원 (요구사항 8)
- `test_legacy_runtime_json_without_new_fields_loads_with_defaults` — 레거시 파일 로드 시 기본값 적용

**`tests/test_web_trading.py`** (fake broker만 사용, 실제 네트워크 없음)
- `test_stop_auto_blocks_new_order_submission` — 중지 후 `order.submit` 경로 시도 시 브로커 `submit_order` 미호출 (요구사항 5)
- `test_stop_auto_keeps_syncing_fills_and_order_status` — 중지 상태에서도 `sync_orders`/체결 반영이 계속되는지 (요구사항 6)
- `test_stop_auto_does_not_cancel_open_broker_orders` — `broker.cancel_order` 호출 안 됨 (요구사항 9)
- `test_auto_tick_continues_other_active_symbols_when_one_is_stopped` — 멀티 심볼, 한 종목 중지가 다른 종목에 영향 없음 (요구사항 7)
- `test_rejected_order_replacement_blocked_while_stopped` — `AUTO_REPRICE_SYMBOLS` 대상 거부 주문 재시도가 중지 상태에서 발생하지 않음 (요구사항 10)
- `test_down_ladder_level_change_does_not_cancel_existing_open_orders` — 설정 변경 시 취소 API 미호출 (요구사항 9)
- `test_pending_order_count_reflects_open_statuses`

**`tests/test_application_engine.py`**
- `test_order_submit_command_rejected_for_stopped_symbol`
- `test_start_auto_still_works_to_transition_stopped_to_running` (chicken-egg 케이스)
- `test_etf_overview_reports_running_last_order_time_error_and_pending_count`
- `test_concurrent_auto_tick_and_manual_command_do_not_duplicate_submission` — `command_lock` 기반 중복 실행 방지 검증 (요구사항: 잠금/멱등성)
- `test_strategy_set_ladder_levels_rejects_invalid_and_duplicate_and_unknown_symbol`
- `test_restart_restores_active_symbols_known_symbols_and_ladder_levels` — 새 엔진 인스턴스를 같은 데이터 디렉터리로 재생성해 상태 복원 확인 (요구사항 8)
- `test_no_real_network_call_is_made` — 모든 테스트가 `broker_factory`로 fake를 주입하는지 구조적으로 보장(코드 리뷰 체크리스트 + 필요 시 `unittest.mock.patch("toss_api.TossBroker._request")`에 `AssertionError`를 던지는 가드를 심어 실제 HTTP 계층이 절대 호출되지 않음을 증명) (요구사항 11)

**`tests/test_web_dashboard.py`**
- `test_etf_status_endpoint_returns_all_symbols`
- `test_command_endpoint_accepts_schedule_update_and_persists_delay_minutes`

**전체 회귀 (요구사항 12)**
- `python -m unittest discover -s tests` 전체 실행하여 기존 테스트(특히 `test_mumae_core.py`, `test_web_trading.py`, `test_application_engine.py`, `test_web_dashboard.py`)가 모두 그대로 통과하는지 확인.

모든 테스트는 `tempfile.TemporaryDirectory()` + 인프로세스 fake broker(`mode="DRY_RUN"` 또는 테스트 전용 fake 객체의 `mode="LIVE"` 속성 — 기존 `LiveTradingBroker` 패턴과 동일하게 실제 네트워크를 타지 않는 순수 파이썬 스텁)만 사용한다. `toss_api.TossBroker`의 실제 HTTP 요청 메서드는 테스트에서 호출되지 않는다.

---

## 8. 기존 데이터 마이그레이션 / 기본값 처리 방식

- **별도 마이그레이션 스크립트를 만들지 않는다.** `StateStore._decode()`와 `RuntimeStore.load()`는 이미 `{field.name for field in fields(...)} `로 알려진 필드만 골라 `dataclass(**...)`를 생성하는 구조라서, JSON에 없는 키는 자동으로 `dataclass`의 `default_factory`/기본값이 채워진다 (`down_ladder_enabled_levels=[1,2]`, `known_symbols=[]`, `last_auto_attempt_at={}`, `last_auto_error={}`, `auto_order_delay_minutes=15`).
- 즉 **기존 `state.json`/`runtime.json`을 열자마자 신규 필드가 기본값으로 채워진 `StrategyState`/`RuntimeStatus` 객체가 만들어지고**, 다음 `save()` 시점에 자연스럽게 새 키가 파일에 기록된다. 파일을 미리 손대거나 초기화할 필요가 전혀 없다.
- `active_symbols` 등 기존 키는 이름/의미 모두 그대로 유지한다 (§3).
- 신규 커맨드(`strategy.set_ladder_levels`, `schedule.update`)는 기존 감사로그(`audit_log.py` / `data/audit.jsonl`)에 자동으로 기록된다 (`ApplicationEngine.execute()`가 모든 커맨드를 감사 기록하는 기존 구조를 그대로 사용).
- 롤백 시나리오(§9)에서도 구버전 코드가 새 키를 무시하고 읽을 수 있어야 하므로, 위 자동 필터링 동작이 양방향 호환을 보장한다.

---

## 9. 위험 요소와 롤백 방법

| 위험 | 완화 방법 |
|---|---|
| `build_plan()` 필터링 실수로 1·2단계까지 걸러질 가능성 | `StrategyState.validate()`에서 `{1,2} ⊆ levels` 강제, 전용 회귀 테스트로 고정 |
| 신규 주문 차단 가드를 `submit_orders()` 내부가 아니라 호출부(`_dispatch`)에 두었을 때, `start_auto`의 최초 배치 전송이 실수로 막히는 회귀 | `start_auto`는 `_dispatch`의 `order.submit` 분기를 거치지 않고 `submit_orders()`를 직접 호출하는 기존 구조를 그대로 유지 — chicken/egg 케이스 전용 테스트로 고정 |
| `auto_tick`을 "동기화 대상 = known_symbols"로 넓히면서 브로커 API 호출량 증가 | 대상은 "한 번이라도 시작된 심볼"로 한정(전체 11종목이 아님), 기존과 동일하게 심볼별 `try/except`로 개별 실패가 다른 심볼에 전파되지 않도록 격리 |
| 동시 요청으로 `state.json`/`runtime.json` 쓰기 경합 | 기존 `os.replace()` 원자적 교체 + `ApplicationEngine.command_lock`(RLock)이 모든 `execute()` 경로를 이미 직렬화 — 신규 커맨드도 반드시 `execute()`를 통해서만 상태를 변경하도록 구현(직접 `StateStore.save()`를 다른 곳에서 호출하지 않음) |
| `auto_order_delay_minutes`를 비정상적으로 크게/음수로 설정해 자동매매가 영구히 멈추거나 개장 직후 변동성 구간에 진입 | `schedule.update` 핸들러에서 0~120분 범위 검증 |
| 새 UI 표가 11개 심볼을 매번 폴링하며 브로커 부하 증가 | `/api/etf-status`는 브로커를 직접 호출하지 않고 마지막으로 동기화된 인메모리 값만 반환(사이드이펙트 없음) — 실제 브로커 호출은 기존과 동일하게 60초 백그라운드 틱 또는 사용자가 명시적으로 "새로고침"할 때만 발생 |
| 기존 Windows 프로그램과의 데이터 파일 공유 충돌 | Windows GUI는 이 저장소의 파이썬 코드를 실행하지 않으므로 직접 영향 없음. 다만 같은 `state.json`/`runtime.json`을 공유하는 만큼, 신규 필드가 없는 상태로 Windows 쪽이 파일을 다시 쓰면 우리 쪽 신규 필드가 사라질 수 있음 — 이는 기존에도 존재하던 "공유 파일" 특성이며 이번 작업이 새로 만드는 위험은 아님. 다만 문서에 명시해 둠 |
| 롤백 필요 시 | 모든 변경이 "필드 추가"와 "신규 엔드포인트/커맨드 추가"뿐이라 기존 필드/엔드포인트를 삭제하거나 이름을 바꾸지 않음 → 코드만 이전 커밋으로 되돌리면 됨. 새 코드가 써놓은 `down_ladder_enabled_levels`, `known_symbols` 등의 키는 구버전 코드가 단순히 무시하므로 데이터 파일을 되돌릴 필요도 없음 |

---

## 10. (추가 요청) 자동 주문 시작 지연시간 조절 기능

방금 요청하신 "자동 주문 시간이 지금은 10:45로 고정" 건을 코드에서 확인했습니다. 저장소 전체를 검색했지만 `"10:45"`라는 리터럴은 어디에도 없고, 대신 `web_gui/trading_service.py:396`에 다음과 같이 **"정규장 개장 + 15분" 하드코딩**이 있습니다.

```python
if start + timedelta(minutes=15) <= now <= end:
    session_key = start.date().isoformat()
```

이 15분이 각 세션에서 자동매매가 실제로 시도되는 가장 이른 시각을 결정합니다. 사용자 환경에서 개장 시각 + 15분이 체감상 10:45로 보인 것으로 추정됩니다. `scheduler.py`(레거시 로컬 드라이런 스크립트, 지금 실서비스 경로가 아님)에는 `--time` 옵션이 있지만 이건 지금 쓰이는 웹 서비스와 무관합니다.

**설계:**
- `RuntimeStatus`에 `auto_order_delay_minutes: int = 15` 추가 (전역 값 — 현재 구조상 이 지연은 종목별이 아니라 세션 진입 여부를 한 번만 판단하는 전역 로직이므로 전역 설정으로 유지. 종목별로 원하시면 별도 후속 작업으로 분리 가능).
- `auto_tick()`의 `timedelta(minutes=15)`를 `timedelta(minutes=self.runtime.auto_order_delay_minutes)`로 교체.
- 새 커맨드 `schedule.update` (§5) + GUI 입력창(§6)으로 값 변경, `runtime.json`에 영속화되어 재부팅 후에도 유지.
- "정규장 개장 후 N분"이라는 기존 로직(개장 직후 변동성 구간 회피 목적으로 추정) 자체는 유지하고, N만 조절 가능하게 하는 것을 권장 — 완전히 임의의 절대 시각(HH:MM)으로 바꾸려면 타임존/서머타임 처리를 새로 설계해야 해서 이번 범위를 벗어난다고 판단됩니다. 절대 시각 지정이 꼭 필요하시면 별도로 말씀해 주세요.

---

## 자체 검토 (Self-Review)

- [x] 요구사항 1(시작·중지)의 9개 세부 조건 각각에 대응하는 설계/테스트가 있는가 → §3, §7에 매핑 완료.
- [x] 요구사항 2(Down Ladder)의 조건 각각 대응 → §4, §7에 매핑 완료. 가격/수량 공식은 변경하지 않음을 명시.
- [x] "중지"라는 사용자 표시 문구와 내부 `new_orders_enabled` 의미 분리 요구 반영 → §3 accessor 설계.
- [x] 기존 미체결 주문 자동 취소 코드를 추가하지 않았는지 → §3, §4, §9에서 명시적으로 "취소 API 미호출" 테스트로 고정.
- [x] 테스트가 실제 토스 API를 호출하지 않는지 → §7 전용 테스트(`test_no_real_network_call_is_made`) + 모든 테스트가 fake broker만 사용.
- [x] 재부팅 복원 → dataclass 기본값 기반 자동 상위호환 설계로 별도 마이그레이션 불필요 (§8).
- [x] 동시성/락 → 기존 `command_lock` 재사용으로 충분함을 확인, 신규 원시 락 도입 없이 기존 인프라로 요구사항 충족 — 단, 신규 커맨드도 반드시 `execute()` 경로를 통하도록 구현 시 주의 필요(§9에 명시).
- [ ] 미확정: `strategy.set_ladder_levels`/`schedule.update`를 `MUMAE_WEB_LIVE_ACTIONS` 게이트에 포함할지 여부 — 구현 착수 전 확인 필요(§5).
- [ ] 미확정: `auto_order_delay_minutes`를 전역이 아닌 종목별로 둘지 여부 — 현재는 전역으로 제안, 필요시 후속 논의.

---

**다음 단계:** 위 두 가지 미확정 항목만 확인해 주시면, 테스트 파일부터 순서대로 작성하겠습니다 (구현 코드는 승인 전까지 작성하지 않습니다).
