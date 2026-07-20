# 무한매수 Web Dashboard

기존 Web GUI와 독립적으로 다시 작성한 읽기 중심 계좌 대시보드입니다.

- Windows GUI와 같은 데이터 폴더의 `secure_credentials.dat`, `state.json`, `runtime.json`을 사용합니다.
- 로그인 성공과 토스 계좌 조회 성공을 별도 상태로 표시합니다.
- 계좌 새로고침은 토스 보유종목, 현재가, 주문가능 현금, 일봉만 한 요청에서 조회합니다.
- Secret Key는 브라우저 응답에 포함하지 않습니다.
- 현재 V2에는 실주문 엔드포인트가 없습니다.

Windows에서는 기존과 동일하게 `web_gui/run_web.bat`을 실행합니다.
