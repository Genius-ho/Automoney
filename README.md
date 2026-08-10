# automoney

Domeme product import MVP CLI.

## Run

Set `DATABASE_URL` to a local PostgreSQL database URL, then run:

```powershell
node scripts/process-test-products.mjs
```

Default input is `test-products.csv`; default pricing rules are in `pricing-rules.json`.

## Database

The app uses PostgreSQL only. Local PostgreSQL and Supabase must both be accessed through the same `DATABASE_URL` setting. Keep schema changes in `schema.sql` or migration files so the same SQL can be applied to either database.

The current schema is maintained in `schema.sql`.

## Environment

The loader reads `.env` first and falls back to `env` for the current workspace.

- `DATABASE_URL`: PostgreSQL connection string for local PostgreSQL or Supabase
- `DOMEME_API_KEY`: Domeme Open API key
- `DOMEME_PRODUCT_DETAIL_ENDPOINT`: optional product-detail API endpoint override

Coupang and Smartstore listing APIs are not called by this MVP.

## Windows 수동 실행

관리자 서버는 자동으로 시작되지 않습니다. Windows 작업 스케줄러나 서비스도 등록하지 않습니다.

최초 한 번, PowerShell 또는 명령 프롬프트에서 프로젝트 폴더로 이동한 다음 바탕화면 바로가기를 설치합니다.

```powershell
npm.cmd run admin:windows:install-shortcut
```

이후 바탕화면의 `Automoney 시작`을 더블클릭하면 다음 작업이 수행됩니다.

1. Node.js와 관리자 서버 파일을 확인합니다.
2. 서버가 이미 실행 중이면 중복 실행하지 않고 관리자 페이지를 엽니다.
3. 서버가 꺼져 있으면 보이는 터미널에서 서버를 실행합니다.
4. 준비가 끝나면 `http://127.0.0.1:3000/`을 브라우저에서 엽니다.

서버를 종료하려면 실행 중인 터미널을 선택하고 `Ctrl+C`를 누릅니다. 터미널을 닫아도 서버가 종료됩니다. `PORT` 환경 변수가 설정되어 있으면 3000 대신 해당 포트를 사용합니다.

바로가기 없이 터미널에서 직접 실행할 수도 있습니다.

```powershell
npm.cmd run admin:windows
```

### 문제 해결

- Node.js 오류: `node --version`으로 Node.js 24 이상이 설치되고 PATH에 등록됐는지 확인합니다.
- 포트 오류: `PORT`는 1부터 65535 사이의 정수여야 합니다. 다른 프로그램이 같은 포트를 사용 중이면 그 프로그램을 종료하거나 다른 `PORT`를 지정합니다.
- 준비 시간 초과: 터미널에 표시된 데이터베이스 및 환경설정 오류를 먼저 확인한 뒤 다시 실행합니다.
- 텔레그램이 작동하지 않음: `.env`의 텔레그램 설정을 확인합니다. 실행기는 `.env`의 값을 화면에 출력하거나 변경하지 않습니다.

## 상품 자동화 일정

상품 관련 고부하 작업은 `Asia/Seoul` 기준으로 분산 실행됩니다.

- 매일 07:00: 대기 상품 드래프트 최대 1개 준비
- 매일 08:00: 등록된 상품 분석 최대 1개
- 매일 09:00: 분석 완료 상품 이미지 생성 최대 1개
- 3일마다 10:00: 카테고리 선택과 신규 후보 발굴

서버가 늦게 시작되면 놓친 작업을 동시에 실행하지 않고 5분 점검마다 가장 오래된 작업 하나만 복구합니다. 주문, 배송, 반품 및 텔레그램 확인 주기는 변경되지 않습니다. 상품 등록과 이미지·판매 승인은 기존처럼 사용자가 확인합니다.
