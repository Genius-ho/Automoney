# 웹 GUI 폴더 안내

현재 `run_web.bat`이 실행하는 화면은 `web_gui/dashboard`입니다. `dashboard/server.py`, `dashboard/service.py`, `dashboard/static`이 현재 웹 관리 화면을 구성합니다.
# 무한매수 Web GUI

기존 Windows Tkinter 프로그램을 변경하지 않고 별도 웹 화면으로 분리한 첫 버전입니다.

## WEB.0.2 범위

- 종목별 전략 상태 조회 및 저장
- 현재가와 전일 종가를 이용한 주문계획 계산
- 토스 API 보유 종목, 매수 가능 금액, 현재가 조회
- 보유 종목의 현재가, 총액, 손익, 수익률, T 표시
- Windows와 Debian에서 동일한 Python 웹 서버 사용
- Windows GUI와 동일한 헤더, ETF 선택줄, 5개 주 탭, 우측 보유종목, 하단 상태바
- 전략 현황의 계좌 카드, STAR, 매수·매도 가이드, 진행 상황, 특수 LOC 설정
- 표 제목 더블클릭 정렬과 열 너비 조절
- 실주문 전송은 의도적으로 차단

## Windows 실행

`run_web.bat`을 실행하면 웹 관리 비밀번호를 묻고 브라우저에서 `http://127.0.0.1:8765`가 열립니다. 브라우저 하단의 `웹 로그인`에서 같은 비밀번호를 입력해야 실주문 버튼이 활성화됩니다. 비밀번호는 파일에 저장하지 않습니다.

## Debian 실행

```sh
cd /home/ho/apps/automoney/web_gui
chmod +x run_web.sh
./run_web.sh
```

토스 API 자격증명은 서버 프로세스 환경변수 `TOSS_CLIENT_ID`, `TOSS_CLIENT_SECRET`, `TOSS_ACCOUNT_SEQ`로 제공합니다. 실주문 기능이 추가되기 전까지 `MUMAE_MODE=DRY_RUN`을 유지하십시오.

기본 바인딩은 로컬 접속만 가능한 `127.0.0.1`입니다. 다른 PC에서 접속시키기 전에 로그인, HTTPS, 방화벽을 먼저 구성해야 합니다.

웹 로그인 세션은 HttpOnly·SameSite 쿠키와 CSRF 확인값으로 보호됩니다. Windows 실행기는 `MUMAE_WEB_PASSWORD`와 `MUMAE_WEB_LIVE_ACTIONS`를 해당 서버 프로세스에만 임시 설정합니다. Debian 서비스에서는 두 값을 서비스 환경변수로 직접 설정해야 합니다.

실주문·취소·자동매수는 로그인만으로 실행되지 않습니다. 토스 `LIVE` 모드, 토스 실주문 확인값, 토스 주문현황 동기화, 계획과 다른 OPEN 주문 없음, 화면의 `SUBMIT 종목 건수` 또는 `CANCEL 종목 건수` 확인 문구가 모두 통과해야 합니다.
