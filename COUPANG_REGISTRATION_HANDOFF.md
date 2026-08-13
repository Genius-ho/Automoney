# 쿠팡 직접등록(Direct API) 작업 인수인계

마지막 갱신: 2026-08-04, 브랜치 `feat/admin-coupang-registration-flow`

이 파일은 다음 세션에서 "어디까지 했고 뭘 해야 하는지" 바로 이어서 쓰기 위한 문서입니다.
전체 로드맵/스펙은 `automoney_complete_automation_implementation_plan.md` (특히 22장, 27장) 참고.

---

## 1. 채널 전략 (확정, 2026-07-28)

- **쿠팡** = Claude가 API로 처음부터 직접 등록 (`createDirectRegistration`, `src/coupang-registration-flow.mjs`)
- **네이버** = speedgo(도매매 스피드등록 데스크톱 툴)로 등록 → Claude가 이미지/가격만 나중에 맞춤

이유: 이 계정의 쿠팡 API 키가 자체개발(OpenAPI) 키라서 speedgo(도매매 서버)가 대신 호출하면 실패함.
반면 이 앱이 직접 같은 키로 호출하는 건 정상 동작. → 쿠팡만 분리해서 API 직접등록으로 감.

## 2. 이미 완료된 기능 (커밋됨)

- Phase 7~9 (주문 감지 → 발주 → 배송처리): 쿠팡·네이버 둘 다
- Phase 10 (취소/품절/반품/교환 예외처리): 쿠팡·네이버 둘 다
- 관리자 대시보드 (16.1/16.5) + 스케줄러 (`npm run admin`, 18번)
- 가격 조정 기능 (쿠팡 `updateItemPrice`, 네이버 `updateOptionStock`)
- 네이버 이미지 스왑 (`updateOriginProduct`)
- 쿠팡 브랜드/GTIN(MPN) 정책 대응 (`resolveBrandIdentifier`)
- 텔레그램 심각오류 알림 + 발주승인 인라인버튼 + 일일요약
- speedgo 로그인 세션 쿠키 영속화 (Playwright)
- 쿠팡 직접등록 파이프라인 자체 (`createDirectRegistration`, requested=false까지만 자동, 승인요청은 항상 수동)

이미 등록된 draft (쿠팡, `coupang_product_registrations` 테이블):

| draft | sellerProductId | status | 비고 |
|---|---|---|---|
| 64 | 16301574570 | linked | **보호 대상 (PROTECTED_DRAFT_ID)** — 이미 라이브/사람이 검증한 리스팅, 절대 건드리지 않음 |
| 46 | 16301910938 | approval_requested | 구 파이프라인(2026-07-13)으로 등록됨 |
| 27 | 16311872388 | approval_requested | 구 파이프라인으로 등록됨 |
| 31 | 16322995173 | created (requested=false) | 2026-07-28 raw-mode로 등록. **승인요청(WING에서 수동)이 아직 안 됨** — 다음에 WING 들어가서 확인 필요 |

## 3. 이번 세션(2026-08-04)에 확인한 것

`scripts/*-once.mjs` 7개 + `logo.png`는 커밋 안 된 상태(throwaway 스크립트, 2026-07-28 새벽 작성):
- `inspect-category-meta-once.mjs` — 카테고리 메타(필수옵션/고시정보) 조회용
- `dump-coupang-payload-once.mjs` / `preview-coupang-direct-once.mjs` — payload 미리보기(dry-run, 실호출 없음)
- `register-coupang-direct-once.mjs` / `run-coupang-direct-once.mjs` — 실제 createDirectRegistration 실행용 (draftId, overrides를 CLI 인자로 받음)
- `fix-coupang-draft31-once.mjs` — draft 31이 '수량' 필수속성 때문에 실패하던 걸 고쳐서 재등록한 스크립트 (이미 실행 완료, 재실행 불필요)
- `run-analysis-once.mjs` — Codex+Python 상품분석 1건 실행용

→ **정리 필요**: 커밋할지, 삭제할지, 재사용 스크립트로 다듬을지 아직 결정 안 함.

**다음 등록 후보 draft 확인 완료** (`raw` 모드 대상 — main 이미지 1장 + detail_slice 이미지 있고, 아직 쿠팡 등록 이력 없는 draft, id 내림차순):

```
119(needs_review, detail 43장) ← 가장 최근/우선 후보
118(draft, 9장), 117(draft, 21장), 116(draft, 13장), 111(blocked, 11장),
108(19장), 107(14장), 106(14장), 105(10장), 104(10장), 103(3장), 102(9장),
65(5장), 63(4장), 60(8장), 59(7장), 58(8장), 57(11장), 55(16장), 51(4장), 50(6장), 47(4장) ...
```
(115/114/113/112/99/98/66은 detail 이미지 0장이라 raw 모드로도 등록 불가 — 상세이미지부터 확보해야 함)

`selectRegistrationTarget()` (기존 `improved` 모드 선택 로직)은 draft 46이 이미 등록 이력이 있어서
자동으로 다음 후보를 못 찾음 (`noEligibleCandidate: true`) — 이건 raw 모드 대상 선정을 지원 안 하기 때문.
현재는 위처럼 SQL로 직접 후보를 뽑아서 draftId를 수동으로 골라 one-off 스크립트에 넘기는 방식으로 운영 중.

## 4. 오늘 발견한 블로커 — 쿠팡 API IP 화이트리스트 (⚠️ 코드 문제 아님)

`predictCategory`, `getProduct` 등 아무 쿠팡 API나 호출하면 전부 403:

```
"Your ip address 14.57.227.138 is not allowed for this request.
If you need service access, please contact the Coupang seller call center.
(Tel: +82-1600-9879, Email: openapisupport@coupang.com)"
```

사용자가 외부(집 아닌 다른 네트워크)에 있어서 발생 — 쿠팡 WING의 오픈API IP 화이트리스트에
지금 접속 중인 공인 IP가 등록되어 있지 않음. 집 IP로 돌아가면 정상 동작할 가능성 높음.

**장기 해법은 이미 마스터플랜 22장에 있음**: 최종적으로 고정 공인 IP Debian 13 서버로 이전하면
이 문제(및 네이버 커머스API IP 제한)가 근본적으로 해결됨. 지금은 그 전 단계라 로컬 PC의 유동 IP에 의존.

## 5. 다음에 할 일 (순서대로)

1. **집 네트워크(화이트리스트 등록된 IP)로 돌아온 뒤 재확인**: `curl https://api.ipify.org`로 현재 IP 확인 → 쿠팡 WING API 연동 관리에서 화이트리스트에 있는지 확인
2. **draft 31 승인요청**: WING에 직접 들어가서 sellerProductId 16322995173 상태가 "임시저장"인지 확인하고 사람이 직접 승인요청 (코드가 자동으로 하지 않는 설계 — `requestCoupangSaleApproval`은 존재하지만 의도적으로 별도 수동 트리거)
3. **draft 119 등록 진행**: `node scripts/preview-coupang-direct-once.mjs 119` 로 dry-run 미리보기 → readiness.missing 확인 → 필요한 override(재질/치수/제조자/제조국 등) 채워서 → `node scripts/register-coupang-direct-once.mjs 119 '{...overrides}'` 로 실등록 (confirm 필요)
4. 순차적으로 118 → 117 → 116 → ... 나머지 draft들도 같은 방식으로 진행
5. 상세이미지 0장인 draft(115,114,113,112,99,98,66)는 상세이미지 슬라이싱부터 먼저 해결해야 raw 등록 가능
6. one-off 스크립트 정리 여부 결정 (커밋 vs 삭제 vs 정식 CLI 도구화)

## 6. 참고 — 관련 메모리

Claude의 자동 메모리(`~/.claude/projects/.../memory/`)에도 이 프로젝트 관련 세부 정보가 있음:
`project_coupang-registration-workflow.md`, `project_phase7-phase8-order-and-purchase.md`,
`project_phase10-exceptions.md`, `feedback_admin-dashboard.md`, `project_scheduler.md`,
`project_speedgo-playwright-automation.md` 등.
