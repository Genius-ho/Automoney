# 스피드고 네이버 완전 자동 등록 설계

## 목적

도매매 상품 draft 하나를 입력받아 도매매의 스피드고 화면에서 네이버 상품 등록을 끝까지 자동 수행한다. 등록 결과의 Naver 상품 번호를 확보하고, Automoney DB에 연결한 뒤, 기존 Naver Commerce API 흐름으로 최종 이미지·가격을 반영하고 검증한다.

첫 구현 범위는 한 번에 하나의 `draftId`를 처리하는 CLI 흐름이다. 여러 draft의 일괄 처리와 scheduler 연결은 첫 실등록 성공 뒤 별도 범위로 확장한다.

## 확정된 운영 경계

- 로그인은 사용자가 이미 구성한 Playwright persistent profile의 자동 로그인에 맡긴다.
- 아이디·비밀번호를 소스 코드, 환경 파일, 로그, artifact에 새로 저장하거나 입력하지 않는다.
- 저장된 profile이 로그인 상태가 아니면 등록을 시도하지 않고 명확한 로그인 오류로 종료한다.
- 첫 실행은 dry-run을 지원한다. `--confirm`을 지정한 실행만 실제 스피드고 최종 등록 버튼을 누른다.
- `--confirm` 실행은 사용자 입력을 기다리지 않고 상품 등록, 결과 확인, DB 저장, 후처리까지 진행한다.
- CAPTCHA, 2차 인증, 사람 확인 화면은 우회하지 않는다. 자동 로그인 profile이 해결하지 못하면 해당 실행을 실패로 남긴다.

## 실행 인터페이스

기본 실행 형식은 다음과 같다.

```powershell
npm run speedgo:register -- 119
npm run speedgo:register -- 119 --confirm
```

지원 옵션:

- `draftId`: 필수 정수. 처리할 `product_drafts.id`.
- `--confirm`: 실제 스피드고 제출과 Naver 후처리를 허용한다. 없으면 제출 직전까지 준비하고 종료한다.
- `--headless`: 로그인 profile이 이미 유효한 경우에만 headless 실행을 허용한다. 기본은 headful이다.
- `--artifact-dir <path>`: 실행 결과 저장 위치를 덮어쓴다. 기본값은 `artifacts/speedgo/<draftId>/<timestamp>/`다.

실행 결과는 JSON 요약과 단계별 screenshot을 저장한다. 성공 결과에는 `draftId`, `supplierProductNo`, `originProductNo`, `channelProductNo`, `linkedVia`, Naver 검증 결과, 이미지·가격 후처리 결과가 포함된다. 비밀번호, access token, 전체 Authorization header, 쿠키 값, 민감한 네트워크 body는 저장하지 않는다.

## 구성 요소

### `src/speedgo-registration.mjs`

브라우저에 직접 의존하는 작업을 단계별 상태 흐름으로 감싼다.

상태는 다음 순서로 진행한다.

```text
draft_loaded
  -> session_verified
  -> supplier_product_found
  -> speedgo_transfer_opened
  -> naver_form_selected
  -> fields_filled
  -> submitted
  -> registration_ids_resolved
  -> db_reserved_and_completed
  -> naver_verified
  -> post_processed
  -> completed
```

각 단계는 현재 URL, screenshot 경로, 짧은 결과 요약을 실행 journal에 남긴다. 단계가 실패하면 상태와 오류 코드가 고정되고 다음 단계로 진행하지 않는다.

### `src/speedgo-selectors.mjs`

스피드고 UI의 selector와 locator 조합을 한 곳에 둔다. selector 우선순위는 다음과 같다.

1. `data-*`, `name`, `aria-label`, `role` 같은 구조적 식별자
2. 화면의 정확한 버튼·레이블 텍스트
3. URL/DOM 구조에 기반한 제한적인 CSS fallback

각 locator는 하나의 의미 있는 동작만 담당한다. 예를 들어 상품 검색 입력, 상품 결과, 스피드고 전송 버튼, 마켓 선택, 상품명 입력, 가격 입력, 이미지 file input, 상세 HTML 입력, 최종 제출 버튼, 성공 결과 영역을 별도 함수로 노출한다. live probe에서 확인하지 못한 selector는 추측한 단일 selector로 굳히지 않고 후보를 순서대로 시도하며, 모두 실패하면 selector 이름과 현재 URL을 오류에 포함한다.

### `scripts/speedgo-register.mjs`

CLI 진입점이다. 기존 config/database 초기화 패턴을 재사용하고 `runSpeedgoNaverRegistration()`을 호출한다. CLI는 성공 시 0, 자동화가 중단된 경우 1, 잘못된 인자나 구성 누락은 2로 종료한다.

### `src/naver-registration-store.mjs`

기존 `naver_product_registrations` 테이블을 사용한다. 새 테이블은 만들지 않는다.

- 제출 직전 draft별 unique row를 `status = 'submitting'`, `linked_via = 'speedgo_automation'`, `origin_product_no = null`로 예약한다.
- 성공 ID를 얻으면 같은 row를 `status = 'created'`로 갱신한다.
- 이미지 반영이 성공하면 기존 `recordImagesSwapped()`를 사용해 `images_swapped`로 갱신한다.
- 이미 `origin_product_no`가 있는 draft는 중복 제출하지 않는다.
- `submitting` row가 있는 재실행은 새 제출보다 결과 복구를 먼저 시도한다.

## 데이터 흐름

1. `exportProductDraft(db, draftId, 'naver')`로 네이버용 제목·가격·상세 HTML·옵션·검수 상태를 읽는다.
2. blocked draft, 존재하지 않는 draft, 제목·가격·필수 이미지가 없는 draft는 브라우저를 열기 전에 중단한다.
3. `supplierProductNo`를 사용해 도매매 상품을 검색한다. 검색 결과가 0개이거나 동일 후보가 여러 개면 자동 선택하지 않는다.
4. 상품 상세의 스피드고 전송을 열고 네이버 마켓을 선택한다.
5. DB의 최적화된 제목, 네이버 가격, 옵션·추가금·재고, 승인된 대표 이미지, 승인된 상세 이미지, 생성된 상세 HTML을 화면에 입력한다. 필드가 스피드고에서 제공되지 않으면 해당 필드의 실제 UI 상태를 journal에 기록하고 다음 호환 가능한 단계로 진행한다.
6. dry-run은 제출 직전까지 검증하고 종료한다. `--confirm`은 최종 제출 버튼을 클릭한다.
7. 등록 성공 결과에서 다음 순서로 식별번호를 찾는다.
   - 제출을 발생시킨 Playwright network response의 JSON
   - 성공 페이지 URL과 query/path 값
   - 성공 화면의 텍스트·링크·data attribute
   - 스피드고의 등록 결과 목록에서 draft의 정확한 상품명·공급처 상품번호를 이용한 재조회
8. `originProductNo`를 확인하지 못하면 성공으로 간주하지 않는다. 외부 등록이 의심되는 경우 journal과 screenshot을 보존하고, 재실행 시 중복 제출 대신 복구 경로를 먼저 사용한다.
9. 번호를 확보하면 Naver API `getProduct(originProductNo)`로 존재 여부와 상품명을 확인한다. `channelProductNo`는 응답 또는 스피드고 결과에서 확인되는 경우 저장한다.
10. 기존 Naver Commerce API 흐름으로 승인된 대표·상세 이미지를 업로드하고 `updateOriginProduct()`를 호출한다. 네이버 상품의 현재 가격과 옵션 구조를 먼저 읽은 뒤 `updateOptionStock()`으로 최종 가격을 반영한다.
11. 이미지·가격 후처리 뒤 다시 `getProduct()`를 호출해 상품명, 가격, 대표 이미지, 상세 이미지 수를 검증한다.
12. 전체 검증 성공 후 artifact에 `completed` 결과를 기록한다.

## 외부 등록 복구와 중복 방지

브라우저 제출과 DB 저장은 하나의 트랜잭션이 아니므로 다음 규칙을 사용한다.

- 기존 등록 row가 `created` 또는 `images_swapped`이고 ID가 있으면 실행을 no-op으로 끝낸다.
- `submitting` row가 있으면 draft snapshot hash와 artifact를 확인하고, 스피드고 결과 조회 또는 Naver 검증으로 이미 생성된 상품을 찾는다.
- 복구로 ID가 확인되면 기존 row를 완료 상태로 갱신한 뒤 후처리를 이어간다.
- ID가 확인되지 않으면 같은 draft를 다시 제출하지 않는다. `UNRESOLVED_EXTERNAL_RESULT`로 종료한다.
- Naver API 검증이 실패하면 등록 row는 유지하되 후처리 완료로 표시하지 않는다. 재실행은 등록 재제출이 아니라 검증·후처리부터 시작한다.

## 오류 처리

오류 코드는 최소한 다음을 구분한다.

- `DRAFT_NOT_FOUND`
- `DRAFT_BLOCKED`
- `DRAFT_NOT_READY`
- `NAVER_REGISTRATION_ALREADY_LINKED`
- `SPEEDGO_SESSION_EXPIRED`
- `SPEEDGO_SUPPLIER_PRODUCT_NOT_FOUND`
- `SPEEDGO_AMBIGUOUS_PRODUCT`
- `SPEEDGO_TRANSFER_UI_NOT_FOUND`
- `SPEEDGO_FORM_VALIDATION_FAILED`
- `SPEEDGO_SUBMIT_FAILED`
- `UNRESOLVED_EXTERNAL_RESULT`
- `NAVER_VERIFY_FAILED`
- `NAVER_POST_PROCESS_FAILED`
- `PERSISTENCE_FAILED`

모든 오류는 단계, URL, screenshot 경로, selector 이름 또는 API operation을 포함한다. API 오류에는 기존 client의 제한된 body preview만 사용한다. 실패 시 비밀번호나 token이 로그에 나타나지 않도록 redaction을 적용한다.

## 테스트와 검증

### 자동 테스트

- selector helper가 구조적 selector, 텍스트 selector, fallback 순서로 시도하는지 검증한다.
- fake Playwright adapter로 정상 상태 전이를 검증한다.
- draft 필드가 스피드고 필드에 올바르게 매핑되는지 검증한다.
- 최종 제출은 `--confirm`일 때만 호출되고 dry-run에서는 호출되지 않는지 검증한다.
- 제출 직전 reservation과 성공 ID completion이 중복 실행에 안전한지 검증한다.
- `submitting` 상태 재실행이 재제출하지 않고 복구를 먼저 시도하는지 검증한다.
- Naver API 검증·이미지·가격 후처리가 실패할 때 등록을 중복하지 않는지 검증한다.
- artifact 요약에서 token·cookie·password가 제거되는지 검증한다.

### 실제 smoke test

자동 로그인 profile이 유효한 환경에서 다음 순서로 실행한다.

```powershell
npm run speedgo:register -- 119
npm run speedgo:register -- 119 --confirm
```

첫 명령은 등록 직전까지의 selector와 필드 매핑을 확인하고, 두 번째 명령은 실제 등록·ID 연결·Naver 검증·후처리까지 확인한다. 실제 smoke test가 끝나면 `npm.cmd test`, 관련 focused test, `node --check`를 실행한다.

## 완료 기준

이 설계의 구현은 다음을 모두 만족해야 완료로 본다.

1. 자동 로그인된 persistent profile로 draft 하나를 사람의 추가 입력 없이 네이버에 등록한다.
2. 최종 제출 후 `originProductNo`를 확보해 DB에 자동 연결한다.
3. 재실행해도 같은 draft를 중복 등록하지 않는다.
4. Naver API 재조회가 성공한다.
5. 승인 이미지와 최종 가격이 자동 반영되고 다시 검증된다.
6. 성공·실패 artifact가 남고 민감정보가 노출되지 않는다.
7. 자동 테스트와 기존 전체 테스트가 통과한다.
