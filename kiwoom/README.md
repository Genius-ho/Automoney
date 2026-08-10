# Kiwoom API 연동 (별도 프로그램)

메인 무한매수 엔진(토스 API 기반, `mumae_cli.py`)과 완전히 분리된 독립
프로그램입니다. import 관계도 없습니다. 자녀 명의 키움증권 계좌로 미국
3배 레버리지 ETF(TQQQ/SOXL/KORU 등)를 VR5.0 방식으로 운용하기 위한
용도입니다.

자녀가 2명이라 **프로필(`--profile`)로 완전히 분리**해서 같은 프로그램을
독립적으로 두 번 실행하는 구조로 만들었습니다 (코드를 복사하지 않고,
상태 파일과 인증 파일만 프로필별로 분리 — 버그 수정/기능 추가를 두 번
할 필요가 없습니다).

## 구성

```
kiwoom/
  kiwoom_api.py   # Kiwoom REST API 클라이언트 (인증만 완성, 나머지는 아래 참고)
  vr_engine.py    # VR5.0 계산 로직 (V/밴드/리밸런싱) -- backtest_vr.py와 동일 공식
  vr_state.py     # 프로필별 상태 저장/로드 (data/vr_<profile>.json)
  vr_cli.py       # 독립 실행 CLI (mumae_cli.py와 별개)
  web/            # 독립 웹 GUI (web_gui/와 별개, 포트도 다름)
    server.py
    service.py
    web_auth.py
    static/
  tests/
```

## 현재 상태

**구현됨**
- `kiwoom_api.py`: OAuth2 인증(`POST /oauth2/token`, client_credentials),
  토큰 캐싱, MOCK(모의투자, 기본값)/LIVE 모드 분리 — 토스 API와 동일하게
  실거래는 `KIWOOM_LIVE_TRADING_ACK` 환경변수를 명시적으로 설정해야만 허용.
- `vr_engine.py`: V 성장식(`V2=V1+Pool/G+적립금`), 밴드(`V×(1±폭)`),
  리밸런싱 목표수량 계산 — Fire Gate 캡처로 검증된 공식 그대로.
- `vr_state.py` / `vr_cli.py`: `init`/`status`/`plan`/`tick` 커맨드로
  프로필별 상태를 만들고 조회하고, 임의 가격으로 리밸런싱 계획을
  미리 계산해볼 수 있음 (Kiwoom API 없이도 지금 바로 테스트 가능).

**미구현**: 실제 미국주식 시세조회/일봉조회/잔고조회/주문 엔드포인트.
공식 문서(https://openapi.kiwoom.com/)에서 "계좌/시세/주문/실시간시세/조건검색"
메뉴 구조까지는 확인했지만, 로그인 없이는 정확한 경로·파라미터·응답
스키마가 공개되어 있지 않아서 임의로 만들지 않았습니다. `NotImplementedError`로
명확히 막아뒀습니다 — 실거래 자금이 걸린 부분이라 추측으로 구현하지
않는 게 맞다고 판단했습니다. `tick` 커맨드는 이 때문에 지금은 항상
막힌 이유를 안내하고 종료합니다.

## 다음에 할 일

1. Kiwoom Open API 사용신청 (https://openapi.kiwoom.com/, IP 화이트리스트 등록 필요) — 자녀별로 별도 신청 필요할 수 있음
2. 신청 후 "API 명세서 다운로드"에서 미국주식 주문/시세/잔고 API의 정확한 경로와 요청/응답 형식 확인
3. `kiwoom_api.py`의 `get_us_prices_raw`, `get_us_daily_candles_raw`, `get_us_holdings_raw`, `get_us_buying_power_raw`, `submit_us_order`, `cancel_order`를 실제 명세에 맞게 구현

## 사용법 (자녀 2명, 프로필로 분리)

```bash
# 초기 세팅 (자녀별로 한 번씩)
python3 kiwoom/vr_cli.py init --profile child1 --symbol TQQQ --cash 10000 --price 65.40
python3 kiwoom/vr_cli.py init --profile child2 --symbol SOXL --cash 10000 --price 22.10

# 상태 확인
python3 kiwoom/vr_cli.py status --profile child1

# 임의 가격으로 리밸런싱 계획만 미리 확인 (저장 안 함)
python3 kiwoom/vr_cli.py plan --profile child1 --price 60.00

# 실제 반영하며 계획 (--apply 시 저장됨)
python3 kiwoom/vr_cli.py plan --profile child1 --price 60.00 --apply

# 실시간 자동 실행 (Kiwoom API 엔드포인트 완성 후에만 동작)
python3 kiwoom/vr_cli.py tick --profile child1
```

`python3 kiwoom/vr_cli.py ...`는 어느 디렉터리에서 실행해도 동작합니다
(내부적으로 repo 루트를 sys.path에 넣음).

## 환경변수 (프로필별 파일: `deploy/kiwoom_<profile>.env`)

```
KIWOOM_APP_KEY=...
KIWOOM_APP_SECRET=...
KIWOOM_ACCOUNT_NO=...
KIWOOM_MODE=MOCK          # MOCK(기본, 모의투자) 또는 LIVE
KIWOOM_LIVE_TRADING_ACK=I_UNDERSTAND_KIWOOM_LIVE_TRADING   # LIVE 모드에서만 필요
```

`vr_cli.py tick --profile child1`은 자동으로 `deploy/kiwoom_child1.env`를
읽습니다. `deploy/kiwoom_child2.env`는 완전히 별개 파일이라 계좌/키가
섞이지 않습니다. 메인 엔진의 `deploy/mumae.env`와도 무관합니다.

## 웹 GUI

토스 `web_gui/`와 같은 디자인(카드 레이아웃, 로그인 다이얼로그, CSS
그대로 재사용)을 그대로 따르되, 완전히 별개 서버·별개 포트·별개 쿠키로
분리했습니다. 프로필(child1/child2) 전환은 웹 화면에서 라디오 버튼으로,
새 프로필 생성도 화면에서 바로 할 수 있습니다.

```bash
KIWOOM_WEB_PASSWORD=원하는비밀번호 python3 kiwoom/web/server.py --open
# 기본 포트 8766 (토스 웹 GUI는 8765라 겹치지 않음)
```

주문은 아직 Kiwoom API가 미완성이라 실제로 나가지 않습니다 — 화면의
"적용"은 로컬 상태만 갱신합니다(실주문 아님). `kiwoom_api.py`의
주문/시세 엔드포인트를 완성하면 그때 웹 GUI에도 실시간 시세/실주문
버튼을 이어붙이면 됩니다.

## 테스트

```
.venv/bin/python -m unittest kiwoom.tests.test_kiwoom_api kiwoom.tests.test_vr_state kiwoom.tests.test_vr_engine kiwoom.tests.test_vr_web_service kiwoom.tests.test_web_auth
```
