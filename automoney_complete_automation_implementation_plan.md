# Automoney 완전 자동화 구현 계획서

작성일: 2026-07-25  
프로젝트: Automoney  
현재 개발 환경: Windows `C:\Dogfoot\automoney`  
최종 운영 환경: 고정 공인 IP 기반 Debian 13 Linux 서버  
주요 판매채널: 쿠팡, 네이버 스마트스토어  
주요 공급처: 도매매·도매꾹  
AI 우선 사용: Codex CLI (`GPT-5.6 Sol`, reasoning effort `low`)  
AI 보조/대체 사용: Claude

---

# 1. 문서 목적

이 문서는 Automoney를 단순 상품등록 도구가 아니라 **상품 발굴·등록·개선·주문·발주·배송 통합 자동화 시스템**으로 완성하기 위한 기준서다.

용도:

- Claude 또는 Codex에 개발 지시를 전달하는 기준 문서
- 현재 구현 상태와 미구현 범위를 구분하는 인수인계 문서
- 기존 기능과 실등록 상품을 보호하기 위한 회귀 기준
- Windows 개발 후 Linux 서버 이전을 고려한 설계 기준

---

# 2. 전체 목표

```text
[상품 발굴]
3일마다 안전 카테고리 3개 선정
→ 카테고리별 상품 수집
→ 중복·MOQ·수익성·위험도 검증
→ 카테고리별 최고점 상품 1개 선정

[기본 등록]
선정 상품 최대 3개
→ 도매매·도매꾹 스피드등록
→ 쿠팡·네이버에 즉시 기본 등록
→ 채널 상품번호를 Automoney에 저장

[상품 개선]
개선 큐에 등록 상품 적재
→ 하루에 1개씩 AI 분석
→ 대표이미지 생성
→ 상세이미지 생성
→ 제목 최적화
→ 키워드 최적화
→ 기존 등록상품의 마케팅 요소만 수정

[판매 운영]
공급처 가격·재고·판매상태 감시
→ 손실·품절 위험 상품 정지 또는 관리자 확인

[주문 처리]
30분마다 쿠팡·네이버 주문 수집
→ 공급처 상품·옵션 매핑
→ 최신 가격·재고·MOQ 재검증
→ 도매매 발주안 생성
→ 사용자 승인
→ 실제 도매매 배송대행 발주

[배송 처리]
도매매 송장 수집
→ 쿠팡·네이버 발송 처리
→ 배송상태 추적
→ 취소·품절·반품·오류만 관리자에게 표시
```

최종적으로 사람이 확인할 영역:

- AI가 만든 이미지와 제목의 품질 검수
- 초기 도매매 실발주 승인
- 공급가 급등, 품절, 옵션 불일치 같은 예외 처리
- 취소·교환·반품
- 인증·법적 위험상품 판단

---

# 3. 핵심 운영 원칙

## 3.1 등록과 개선을 분리

```text
3일마다 최대 3개 기본 등록
매일 최대 1개 상품 개선
```

상품은 원본 상태로 우선 등록하고, 개선 큐가 순차적으로 따라간다.

## 3.2 최초 등록은 스피드등록 우선

```text
Automoney 상품 선정
→ Playwright로 도매매·도매꾹 스피드등록 실행
→ 쿠팡·네이버 등록 결과 확보
→ 외부 상품번호 저장
```

Automoney 역할:

- 등록 상품 선정
- 중복 방지
- 스피드등록 자동 실행
- 등록 성공 여부 기록
- 채널 상품번호 연결
- 상품 개선
- 주문·발주·배송 자동화

## 3.3 상품 개선 범위 제한

자동 수정 허용:

- 대표이미지
- 상세이미지/상세페이지
- 상품명
- 검색 키워드/태그

상품 개선 단계에서 수정 금지:

- 판매가
- 재고
- 옵션
- 카테고리
- 배송비
- 출고지/반품지
- 인증정보
- 상품정보제공고시
- 공급처 및 채널 상품번호

## 3.4 금전 단계 승인 게이트

초기 자동 확정 금지:

- 실제 도매매 주문
- 가격 급등 후 판매가 변경
- 손실 주문 처리
- 반품·교환 승인

## 3.5 모든 작업은 재개 가능하게 설계

- 현재 단계 저장
- 생성 결과 재사용
- 동일 draft 재개
- 중복 draft 생성 금지
- 중복 채널 등록 금지
- 중복 발주 금지

---

# 4. 지금까지 구현한 것

아래 상태는 현재 대화와 개발 보고를 기준으로 정리했다. 개발 재개 전 로컬 저장소와 DB에서 최종 재검증한다.

## 4.1 기본 시스템

- Node.js 기반 관리자 서비스
- PostgreSQL 기반 데이터 저장
- 상품 draft 관리
- 이미지 및 분석결과 관리
- 판매채널 등록 이력 관리
- 관리자 화면 기반 검수 흐름

## 4.2 상품 수집 및 후보 분석

- 도매매·도매꾹 상품정보 수집
- 원가와 배송비 분석
- 후보상품 수익성 계산
- 공급처 표시문구 제거
- 상품명 정규화
- 네이버 경쟁상품과 키워드 조사
- 문서 빈도 기반 키워드 점수
- 안전 카테고리 whitelist
- 위험 카테고리 제외
- 최근 선택 카테고리 회피
- 후보 점수 0~100 계산
- 카테고리별 winner 선정

## 4.3 자동 상품 발굴 Stage 1

- 3일 주기 발굴 구조
- 안전 카테고리 중 무작위 3개 선택
- 최근 30일 선택 카테고리 회피
- 카테고리별 후보 수집
- 카테고리별 1위 선정
- 배치 실행이력
- 중복 실행 방지 lock

## 4.4 처리 큐 Stage 2

- winner를 처리 큐에 적재
- 동시 처리 수 1개
- 하루 1개 처리 구조
- 진행 중 작업 우선 재개
- 상태 관리

대표 상태:

```text
queued
analyzing
generating_images
awaiting_approval
ready_for_registration
failed
```

AI 사용량 부족은 실패가 아니라 재개 대기상태로 관리해야 한다.

## 4.5 이미지 분석 및 생성

- Python OCR 및 이미지 전처리
- Codex CLI 상품 이미지 분석
- Python 결과와 Codex 결과 병합
- 분석 JSON 저장
- 관리자 화면 검수 및 적용
- 대표이미지 생성
- 상세이미지 10장 생성 흐름
- 승인 전 자동 사용 금지
- 기존 업로드·승인 흐름 연결

## 4.6 Cloudflare R2

- 생성 이미지 업로드
- 공개 이미지 URL 생성
- 쿠팡 등록/수정 payload에 URL 사용
- 이미지와 채널 등록이력 연결

## 4.7 쿠팡

- HMAC 인증
- 카테고리 추천 및 메타데이터 조회
- 출고지/반품지 코드 연결
- 상품 payload 생성
- 단일·옵션상품 대응
- 실제 상품 생성
- 상품 수정
- 상태 조회
- 승인 요청
- 중복 등록 방지
- sellerProductId 저장
- 대표·상세이미지 수정 가능

실등록 이력:

| Draft | sellerProductId | 비고 |
|---:|---:|---|
| 64 | 16301574570 | 옵션상품 실등록 및 승인 흐름 검증 |
| 46 | 16301910938 | 등록·이미지 흐름 검증 |
| 27 | 16311872388 | 단일상품 및 자동 생성 이미지 흐름 검증 |

## 4.8 네이버 스마트스토어

사용자 확인 기준:

- 스피드등록을 통한 실제 등록 성공
- 등록 상품 이미지 수정 가능
- 공개 상품 페이지 확인

검증 상품:

```text
스토어: wowpickmeup
channelProductNo: 13681000551
https://smartstore.naver.com/wowpickmeup/products/13681000551
```

향후 자동 저장 필요:

- `originProductNo`
- `channelProductNo`
- 채널 ID
- 공급처 상품번호
- Automoney draft ID

## 4.9 스피드등록

쿠팡과 네이버 실등록 자체는 성공했다. 앞으로 필요한 것은 수동 클릭을 Playwright로 자동화하고, 등록 후 외부 상품번호를 DB에 연결하는 것이다.

## 4.10 보호 데이터

- draft 64 `generated_detail_html` 길이 3896
- draft 64 SHA-256 `67ee716e9d48a39ae8a744e3451c3d7bd198399227aaf4b87997be54b86c5758`
- main image prompt revision 2
- detail page prompt revision 1
- draft 27, 46, 64 sellerProductId
- 승인 대표·상세이미지
- 기존 R2 URL
- DOCX 원문/렌더링 프롬프트
- 기존 등록 및 승인 이력

---

# 5. 앞으로 구현해야 할 것

1. 스피드등록 완전 자동화
2. 등록 결과 상품번호 자동 연결
3. 하루 1개 상품 개선 완전 자동화
4. 공급처 가격·재고 감시
5. 주문 자동 수집
6. 도매매 발주안 및 실발주
7. 송장·발송 자동 처리
8. 취소·품절·반품 예외 처리

---

# 6. Phase 1 — 현재 상태 감사 및 AI Provider 정리

## 6.1 개발 재개 전 감사

Claude가 먼저 확인:

```text
1. 현재 branch
2. git status
3. 최근 commit
4. DB migration 상태
5. processing queue 상태
6. 중단 draft 상태
7. 스케줄러 활성화 여부
8. 쿠팡·네이버 등록 이력
9. 이미지 수정 endpoint
10. 전체 테스트
```

금지:

- `git reset --hard`
- `git clean -fd`
- 기존 이미지 삭제
- 기존 draft 재생성
- sellerProductId 삭제
- 기존 migration 수정

## 6.2 Codex/Claude 공통 Provider

기본 실행 우선순위는 다음과 같이 확정한다.

```text
1순위: Codex CLI
- model: GPT-5.6 Sol
- reasoning effort: low

2순위: Claude
- Codex 사용량 부족, 로그인 오류 또는 장기 장애 시 fallback

3순위: Manual Provider
- 자동화 실패 시 관리자가 수동 결과를 등록
```

공통 구조:

```text
AI Task Router
├─ Codex CLI Provider
├─ Claude Provider
└─ Manual Provider
```

공통 작업:

```text
analyze_product
generate_main_image
generate_detail_images
optimize_title
generate_keywords
```

권장 환경변수:

```env
AI_ANALYSIS_PROVIDER=codex
AI_IMAGE_PROVIDER=codex
AI_FALLBACK_PROVIDER=claude
AI_MAX_CONCURRENCY=1

CODEX_MODEL=gpt-5.6-sol
CODEX_REASONING_EFFORT=low
CODEX_RETRY_REASONING_EFFORT=medium
```

기본 정책:

```text
1차 실행: GPT-5.6 Sol / low
→ 자동 품질검사 통과: 결과 사용
→ 품질검사 실패: 동일 provider로 1회 재시도
→ 재시도 실패: GPT-5.6 Sol / medium으로 승격
→ Codex quota 또는 로그인 문제: 동일 작업을 Claude로 fallback
```

한 상품의 대표이미지와 상세이미지 세트는 가능하면 동일 provider로 끝까지 생성한다.

대기 상태:

```text
waiting_for_ai_quota
waiting_for_ai_login
waiting_for_ai_retry
```

규칙:

- 실패 처리하지 않음
- 동일 draft 유지
- 기존 결과 유지
- 중단 단계부터 재개
- provider 변경 시 중복 파일 방지
- 한 상세이미지 세트는 한 provider가 끝까지 생성

---
# 7. Phase 2 — 상품 선정 기준 완성

## 7.1 중복 방지

중복 판정에 사용할 정보:

- 도매매·도매꾹 상품번호
- 공급처 판매자 ID
- 원본 URL
- GTIN/바코드
- 모델번호
- 정규화 상품명
- 대표이미지 perceptual hash
- 쿠팡 sellerProductId/vendorItemId
- 네이버 originProductNo/channelProductNo

규칙:

- 동일 공급처 상품번호: 영구 재등록 금지
- 동일 GTIN/모델번호: 영구 재등록 금지
- 동일 이미지+유사 제목: 최소 180일 제외
- 최근 탈락 후보: 최소 30일 재평가 금지
- 최근 선택 카테고리: 30일 회피

권장 유니크 키:

```text
supplier + supplier_product_id
channel + external_product_id
batch_run_id + supplier_product_id
```

## 7.2 카테고리 선정

3일마다 안전 카테고리 3개를 가중 무작위로 선택한다.

가중치:

- 최근 30일 미선택 카테고리 우대
- 등록 상품 수가 적은 카테고리 우대
- 평균 마진이 높은 카테고리 우대
- 반품 위험이 낮은 카테고리 우대
- 이미지 개선이 쉬운 카테고리 우대

자동 제외:

- 식품
- 건강기능식품
- 의약품
- 의료기기
- 화장품
- 전기·배터리·충전제품
- 생활화학제품
- 어린이 인증 대상
- 위험물
- 설치·시공 제품
- 브랜드 위조 위험 제품

## 7.3 경쟁력 점수

| 평가항목 | 점수 |
|---|---:|
| 예상 순이익 | 20 |
| 마진율 | 12 |
| 가격 경쟁력 | 12 |
| 검색 수요/키워드 | 10 |
| 공급 안정성 | 10 |
| 상품정보 완성도 | 8 |
| 이미지 개선 가능성 | 8 |
| 옵션 복잡도 | 6 |
| 반품 위험도 | 5 |
| 인증/법적 위험도 | 5 |
| 기존 상품과 중복도 | 4 |

최소 통과 기준:

- 총점 70점 이상
- 예상 순이익 5,000원 이상
- 마진율 25% 이상
- 필수정보 누락 없음
- 공급처 판매중
- 위험 카테고리 아님
- 이미지 개선 가능

통과상품이 2개면 2개만 등록한다. 3개를 억지로 채우지 않는다.

---

# 8. Phase 3 — MOQ와 2개 세트 기준

## 8.1 MOQ 1

가장 우선한다.

- 감점 없음
- 단일상품 판매
- 원가 계산 단순
- 발주수량과 판매수량 동일

## 8.2 MOQ 2

모두 만족할 때만 허용:

- 2개 세트 판매가 자연스러움
- 2개 합산 공급원가 기준 계산
- 실제 tiered price 구간 적용
- 총 공급원가 15,000원 이하 권장
- 예상 판매가 35,000원 이하 권장
- 예상 순이익 5,000원 이상
- 마진율 25% 이상
- 배송비 포함 후 경쟁력 있음

적합 예시:

- 소형 수납함
- 후크
- 문구
- 정리용품
- 주방 소모성 소품

부적합 예시:

- 대형 가구
- 고가 장식품
- 보통 한 개만 필요한 제품
- 색상 조합이 복잡한 제품

## 8.3 MOQ 3 이상

원칙적으로 자동등록 후보에서 제외한다. 매우 저렴한 소모품에 별도 허용정책이 있을 때만 예외로 둔다.

## 8.4 2개 세트 필수 반영

- 상품명
- 대표이미지
- 상세이미지
- 구성품
- 원가
- 판매가
- 마진
- 판매재고
- 공급처 발주수량

예시:

```text
채널 주문수량 1
→ 공급처 발주수량 2
```

상품명:

```text
무타공 벽걸이 수납함 2개 세트
```

## 8.5 코드 감사 항목

```text
1. minimum order quantity 파싱
2. tiered price 선택
3. 총 공급원가
4. 배송비
5. 예상 판매가
6. 순이익
7. 판매 구성수량 저장
8. 발주수량 변환
9. 제목 2개 세트 반영
10. 이미지 구성수량 반영
```

---

# 9. Phase 4 — Playwright 스피드등록 완전 자동화

## 9.1 목표

3일마다 선정된 최대 3개를 사람이 클릭하지 않아도 도매매·도매꾹 스피드등록으로 쿠팡과 네이버에 올린다.

## 9.2 흐름

```text
발굴 batch 완료
→ winner 최대 3개 확정
→ speed_registration_queue 적재
→ Playwright 로그인 세션 확인
→ 상품별 스피드등록 실행
→ 쿠팡 등록
→ 네이버 등록
→ 성공/실패 저장
→ 외부 상품번호 조회
→ 개선 큐 적재
```

## 9.3 Playwright 기준

- 영구 브라우저 프로필 사용
- ID/비밀번호 코드 저장 금지
- 로그인 만료 감지
- CAPTCHA/2차 인증 감지
- selector를 text 하나에만 의존하지 않음
- URL, role, label, data attribute 조합
- 단계별 screenshot 저장
- timeout 후 즉시 재클릭 금지
- 결과 불명확 시 채널 상품목록을 먼저 조회

## 9.4 상태

```text
queued
opening_supplier
login_required
selecting_product
selecting_channel
submitting
verifying_result
registered
partial_success
failed
unknown_result
duplicate_detected
```

## 9.5 부분 성공

쿠팡 성공, 네이버 실패인 경우:

- 쿠팡 결과 저장
- 네이버만 재시도
- 쿠팡 재등록 금지

## 9.6 완료 후 저장

```text
supplier_product_id
supplier_name
draft_id
batch_run_id
registration_method=speed_registration
coupang_seller_product_id
coupang_vendor_item_ids
naver_origin_product_no
naver_channel_product_no
registered_at
```

## 9.7 완료 기준

- 3개 상품 연속 등록 가능
- 동일 상품 중복 등록 0건
- 부분 성공 재개 가능
- 로그인 만료 관리자 표시
- 등록 screenshot 확인 가능
- 쿠팡·네이버 상품번호 DB 연결

---

# 10. Phase 5 — 하루 1개 상품 개선 자동화

## 10.1 흐름

```text
개선 큐 1개 선택
→ 원본 상품정보와 이미지 수집
→ AI 상품 분석
→ 대표이미지 1장 생성
→ 상세이미지 최대 10장 생성
→ 제목 최적화
→ 키워드 생성
→ 검수 정책 적용
→ 쿠팡·네이버 기존 상품 수정
→ 반영 재조회
```

## 10.2 우선순위

1. 중단된 `analyzing`
2. 중단된 `generating_images`
3. 가장 오래 대기한 상품
4. 조회가 있으나 미개선 상품
5. 발굴점수가 높은 상품

## 10.3 대표이미지 기준

- 1장
- 정사각형
- 상품 구조와 색상 유지
- 근거 없는 구성 추가 금지
- 텍스트·로고·배지·워터마크 금지
- MOQ 2는 2개 세트를 오인 없이 표현

## 10.4 상세이미지 기준

- 최대 10장
- 섹션별 개별 파일
- 근거 없는 기능·인증·판매량·효과 금지
- 공급처 문구와 로고 제거
- 제품 외형 변경 금지
- 크기·소재·구성은 원본 근거만 사용

## 10.5 제목 기준

```text
공급처 라벨 제거
→ 핵심 제품어
→ 주요 특징
→ 규격/구성
→ 브랜드/모델 보호
→ 반복 키워드 제거
```

MOQ 2는 `2개 세트` 명시.

## 10.6 키워드 기준

- 실제 관련 키워드만 사용
- 경쟁상품 반복 출현 단어 우대
- 반복으로 점수 부풀리기 금지
- 상표권 오인 키워드 금지
- 공급처명 금지

## 10.7 수정 안전장치

수정 전 상품 전체 데이터를 조회하고 허용 필드만 교체한다.

```text
대표이미지: 허용
상세페이지: 허용
상품명: 허용
키워드: 허용
가격: 차단
재고: 차단
옵션: 차단
카테고리: 차단
배송정보: 차단
```

## 10.8 완료 기준

- 하루 1건만 처리
- 중단 후 재개 가능
- 쿠팡과 네이버 반영 확인
- 금지 필드 변경 0건
- 수정 전후 snapshot 저장

---
# 11. Phase 6 — 공급처 가격·재고·판매상태 감시

## 11.1 필요성

등록 후 다음이 바뀔 수 있다.

- 공급가
- 배송비
- 재고
- 옵션
- MOQ
- 판매중지
- 상품 삭제

## 11.2 실행 주기

초기 권장:

- 하루 4회
- 6시간 간격
- 주문 발생 상품은 발주 직전 추가 조회

## 11.3 비교 항목

```text
supplier_price
supplier_shipping_fee
supplier_stock
supplier_option_status
supplier_moq
supplier_sale_status
checked_at
```

## 11.4 처리 정책

```text
공급처 품절
→ 쿠팡·네이버 판매중지 후보

공급처 판매중지/삭제
→ 즉시 판매중지

공급가 상승
→ 예상이익 재계산
→ 기준 미달 시 판매중지 또는 관리자 승인

공급가 하락
→ 가격 인하 후보 생성

MOQ 변경
→ 판매중지 후 관리자 확인

옵션 삭제
→ 해당 옵션 판매중지
```

초기에는 가격을 자동 수정하지 않고 변경안을 표시한다.

## 11.5 완료 기준

- 판매중 상품 전체 주기 점검
- 변경 이력 저장
- 품절 자동 감지
- 손실 주문 차단
- 마지막 정상 공급정보 확인 가능

---

# 12. Phase 7 — 쿠팡·네이버 주문 자동 수집

## 12.1 실행 주기

- 30분마다 실행
- 동시 실행 금지
- 마지막 성공 조회시각 저장
- 조회 구간을 일부 겹치되 유니크 키로 중복 제거

## 12.2 주문 유니크 키

쿠팡:

```text
orderId + orderItemId + vendorItemId
```

네이버:

```text
productOrderId
```

공통:

```text
channel + channel_order_item_id
```

## 12.3 저장 항목

- 채널
- 주문번호
- 주문상품번호
- 주문상태
- 상품번호
- 옵션
- 주문수량
- 판매금액
- 수령인
- 배송주소
- 우편번호
- 연락처
- 배송메모
- 주문시각
- 취소상태
- 공급처 매핑상태

개인정보는 화면과 로그에서 마스킹한다.

## 12.4 상품 매핑

```text
쿠팡 vendorItemId
또는 네이버 channelProductNo
→ channel_product
→ draft
→ supplier_product_id
→ supplier_option_id
→ supplier_order_multiplier
```

MOQ 2 예시:

```text
판매채널 주문수량 2
× 공급처 발주 multiplier 2
= 최종 발주수량 4
```

## 12.5 완료 기준

- 주문 발생 후 30분 이내 저장
- 중복 주문 0건
- 공급처 상품 자동 매핑
- 취소주문 발주 차단
- 매핑 실패 관리자 표시

---

# 13. Phase 8 — 도매매 Private API 및 발주안

## 13.1 사전 확인

상품조회 API와 실제 주문용 Private API 권한은 다를 수 있다.

확인 항목:

- Private API 사용 권한
- 세션/로그인 방식
- 주문 생성 API 사용 가능 여부
- e-money 잔액 조회 가능 여부
- 배송대행 주문 지원 여부
- 테스트 주문 취소 가능 여부

## 13.2 발주 직전 재검증

- 채널 주문 취소 여부
- 공급처 판매상태
- 옵션 존재 여부
- 최신 공급가
- 최신 배송비
- 최신 MOQ
- 공급처 재고
- 제주/도서산간 여부
- 예상 최종 이익
- 중복 발주 여부

## 13.3 발주 차단 조건

- 공급처 품절
- 공급처 판매중지
- 옵션 불일치
- MOQ 변경
- 공급가 상승으로 손실
- 배송비 상승으로 손실
- 주소 오류
- e-money 부족
- 주문 취소
- 기존 supplier order 존재

## 13.4 발주안 화면

표시 정보:

- 판매채널
- 채널 주문번호
- 고객 주문상품
- 옵션/수량
- 공급처 상품번호
- 공급처 옵션
- 실제 발주수량
- 판매금액
- 공급가
- 배송비
- 예상 수수료
- 예상 순이익
- 공급정보 확인시각
- 가격 변동
- 발주 승인 버튼

## 13.5 상태

```text
detected
mapping_required
validating_supplier
order_draft_ready
awaiting_purchase_approval
supplier_ordering
supplier_ordered
supplier_order_failed
cancelled
```

## 13.6 완료 기준

- 발주안 자동 생성
- 사용자 승인 없는 실제 주문 0건
- 중복 발주 0건
- 실주문 전 최신 정보 재검증
- 공급처 주문번호 저장

---

# 14. Phase 9 — 실제 발주, 송장, 채널 발송

## 14.1 실제 도매매 발주

사용자가 `발주 승인`을 누르면:

```text
최신 주문상태 재확인
→ 공급처 가격/재고 재확인
→ 중복 발주 확인
→ 도매매 주문 생성
→ 공급처 주문번호 저장
→ 발주 결과 원문 저장
```

## 14.2 송장 수집

저장 정보:

- 도매매 주문번호
- 공급처 판매자
- 택배사
- 송장번호
- 발송일
- 배송상태

## 14.3 택배사 코드 정규화

도매매 택배사명을 쿠팡·네이버 코드로 변환한다.

예시:

```text
CJ대한통운
한진택배
롯데택배
로젠택배
우체국택배
```

매핑 실패 시 자동 발송처리 금지.

## 14.4 채널 발송 처리

```text
송장 확인
→ 주문 취소 여부 재확인
→ 택배사 코드 변환
→ 쿠팡 발송 처리
→ 네이버 발송 처리
→ 성공 여부 저장
```

## 14.5 완료 기준

- 공급처 송장 자동 수집
- 쿠팡·네이버 발송 처리
- 동일 송장 중복 전송 0건
- 취소주문 발송 0건
- 발송 결과 조회 가능

---

# 15. Phase 10 — 취소·반품·교환·예외

## 15.1 주문 취소

```text
도매매 미발주
→ 발주 차단
→ 주문 종료

도매매 발주 완료, 미출고
→ 공급처 취소 가능 여부 관리자 확인

이미 출고
→ 자동 처리 금지
→ 관리자 예외 큐
```

## 15.2 품절

```text
주문 전 품절
→ 발주 차단
→ 채널 판매중지
→ 관리자 알림

주문 후 공급처 품절
→ 고객 취소/대체 처리 관리자 확인
```

## 15.3 반품·교환

초기에는 완전 자동화하지 않는다.

필요 정보:

- 고객 귀책/판매자 귀책
- 반품비
- 공급처 반품주소
- 공급처 반품 가능 기간
- 포장상태
- 상품 회수상태

모든 반품·교환은 관리자 예외 큐로 보낸다.

## 15.4 예외 코드

```text
SUPPLIER_OUT_OF_STOCK
SUPPLIER_PRICE_CHANGED
SUPPLIER_OPTION_MISMATCH
SUPPLIER_MOQ_CHANGED
INSUFFICIENT_MARGIN
ADDRESS_ERROR
DUPLICATE_ORDER_RISK
COUPANG_API_ERROR
NAVER_API_ERROR
DOME_API_ERROR
PLAYWRIGHT_LOGIN_REQUIRED
TRACKING_MAPPING_ERROR
```

---

# 16. 관리자 화면 최종 구성

## 16.1 대시보드

- 오늘 등록 수
- 오늘 개선 수
- 신규 주문 수
- 발주 승인 대기 수
- 송장 대기 수
- 품절/가격변동 수
- 자동화 오류 수

## 16.2 상품 발굴

- 다음 발굴 예정시각
- 선택 카테고리
- 후보상품
- 점수 세부내역
- 제외사유
- MOQ
- 묶음 구성수량

## 16.3 스피드등록

- 등록 대기
- 채널별 진행상태
- 쿠팡 상품번호
- 네이버 상품번호
- Playwright screenshot
- 실패사유
- 재시도 버튼

## 16.4 개선 큐

- 대기 상품
- 현재 처리 상품
- Claude/Codex provider
- 이미지 생성상태
- 수정 전후 비교
- 채널 반영상태

## 16.5 공급처 감시

- 품절 상품
- 가격 상승
- 배송비 상승
- MOQ 변경
- 마진 미달
- 판매중지 처리상태

## 16.6 주문·발주

- 신규 주문
- 매핑 실패
- 발주안
- 발주 승인 대기
- 도매매 주문완료
- 송장 대기
- 발송완료
- 취소/예외

---
# 17. 권장 데이터 구조

정확한 테이블명은 기존 DB를 우선한다. 아래는 필요한 논리 엔터티다.

## 17.1 supplier_products

```text
id
supplier
supplier_product_id
supplier_seller_id
source_url
normalized_name
gtin
model_number
moq
bundle_quantity
current_price
shipping_fee
sale_status
last_checked_at
```

## 17.2 channel_products

```text
id
draft_id
supplier_product_id
channel
external_product_id
external_origin_product_id
external_item_ids
registration_method
registration_status
registered_at
last_synced_at
```

## 17.3 product_discovery_history

```text
id
batch_run_id
category_id
supplier_product_id
score
selected
excluded_reason
created_at
```

## 17.4 processing_queue

```text
id
draft_id
task_type
status
provider
current_step
retry_count
last_error_code
last_error_message
scheduled_at
started_at
completed_at
```

## 17.5 supplier_snapshots

```text
id
supplier_product_id
price
shipping_fee
stock
moq
option_hash
sale_status
checked_at
```

## 17.6 channel_orders

```text
id
channel
channel_order_id
channel_order_item_id
channel_product_id
option_id
quantity
order_status
recipient_encrypted
address_encrypted
ordered_at
cancelled_at
```

## 17.7 supplier_orders

```text
id
channel_order_id
supplier
supplier_order_id
supplier_product_id
supplier_option_id
supplier_quantity
product_cost
shipping_cost
status
ordered_at
tracking_company
tracking_number
```

## 17.8 automation_events

```text
id
entity_type
entity_id
event_type
previous_status
new_status
actor
payload
created_at
```

---

# 18. 스케줄 기준

| 작업 | 주기 | 동시성 |
|---|---|---:|
| 상품 카테고리 발굴 | 3일마다 | 1 |
| 스피드등록 | 발굴 직후 최대 3개 | 1 |
| 상품 개선 | 매일 1개 | 1 |
| 공급처 가격·재고 감시 | 하루 4회 | 1 |
| 쿠팡 주문 조회 | 30분마다 | 1 |
| 네이버 주문 조회 | 30분마다 | 1 |
| 도매매 송장 조회 | 30분마다 | 1 |
| 배송상태 동기화 | 1~2시간마다 | 1 |

모든 작업은 실행 lock을 사용한다. 이전 작업이 실행 중이면 다음 실행은 skip하고 중복 실행하지 않는다.

---

# 19. API와 Playwright 역할 분담

## 19.1 공식 API 우선

- 도매매 상품정보 조회
- 쿠팡 상품 조회/수정
- 쿠팡 주문 조회
- 쿠팡 발송 처리
- 네이버 상품 조회/수정
- 네이버 주문 조회
- 네이버 발송 처리
- 도매매 Private API 주문/송장 조회

## 19.2 Playwright

- 도매매·도매꾹 스피드등록
- API 미지원 화면 기능
- 로그인/채널 연결 확인
- 실제 등록 결과 화면 검증
- 오류 screenshot

필수 안전장치:

- selector 중앙 관리
- 화면 버전 감지
- 단계별 screenshot
- 상세 로그
- 실패 후 무한 클릭 금지
- 결과 불명확 시 채널 상품목록 조회

---

# 20. 환경변수 기준

secret 값은 문서와 Git에 기록하지 않는다.

```env
# Database
DATABASE_URL=

# AI
AI_ANALYSIS_PROVIDER=codex
AI_IMAGE_PROVIDER=codex
AI_FALLBACK_PROVIDER=claude
CODEX_MODEL=gpt-5.6-sol
CODEX_REASONING_EFFORT=low
CODEX_RETRY_REASONING_EFFORT=medium
CODEX_COMMAND=
CLAUDE_COMMAND=
PYTHON_COMMAND=

# Coupang
COUPANG_ACCESS_KEY=
COUPANG_SECRET_KEY=
COUPANG_VENDOR_ID=

# Naver search/research
NAVER_SEARCH_CLIENT_ID=
NAVER_SEARCH_CLIENT_SECRET=

# Naver Commerce API
NAVER_COMMERCE_CLIENT_ID=
NAVER_COMMERCE_CLIENT_SECRET=

# Dome supplier API
DOME_API_KEY=
DOME_PRIVATE_API_KEY=

# R2
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=
R2_PUBLIC_BASE_URL=

# Playwright
PLAYWRIGHT_USER_DATA_DIR=
PLAYWRIGHT_HEADLESS=false

# Scheduler
DISCOVERY_INTERVAL_DAYS=3
MAX_REGISTRATIONS_PER_BATCH=3
DAILY_IMPROVEMENT_LIMIT=1
ORDER_POLL_INTERVAL_MINUTES=30
SUPPLIER_CHECK_INTERVAL_HOURS=6
```

기존 네이버 검색/시세조사용 키와 네이버 커머스API 키를 반드시 분리한다.

---

# 21. 보안 기준

- `.env` Git 추적 금지
- API secret 로그 금지
- Playwright 쿠키·프로필 Git 추적 금지
- 고객 이름·주소·전화번호 로그 마스킹
- 관리자 페이지 인증 필수
- 외부 접속은 Tailscale/VPN/SSH tunnel 권장
- PostgreSQL 정기 백업
- 주문 개인정보 보관기간 설정
- R2는 상품이미지만 공개
- AI에게 고객 개인정보 전달 금지
- 실발주 endpoint는 관리자 승인과 재검증을 모두 통과해야 호출

---

# 22. 최종 운영 환경 — Debian 13 고정 IP 서버 이전

최종 운영 대상은 사용자가 보유한 **고정 공인 IP 기반 Debian 13 Linux 서버**로 확정한다.

Windows는 기능 개발과 실등록 검증 환경으로 사용한다. 상품 발굴, 스피드등록, 상품 개선, 주문 수집, 발주안, 실발주, 송장처리까지 안정화된 뒤 Debian 13 서버로 이전한다.

## 22.1 최종 서버 역할

Debian 13 서버는 다음 작업을 24시간 수행한다.

- Automoney 관리자 웹서비스
- PostgreSQL 데이터베이스
- 상품 발굴 스케줄러
- Playwright 스피드등록 worker
- Codex CLI/Claude AI worker
- Python 이미지 분석·전처리 worker
- 상품 개선 worker
- 공급처 가격·재고 감시
- 쿠팡·네이버 주문 수집
- 도매매 발주·송장 조회
- 쿠팡·네이버 발송 처리
- 로그, 백업, 상태 모니터링

## 22.2 고정 IP 활용

고정 공인 IP는 다음 용도로 사용한다.

- 네이버 커머스API 호출 IP 등록
- 쿠팡 및 공급처 API의 IP 제한 대응
- Automoney 관리자 원격 접속
- SSH 유지관리
- Playwright 장기 로그인 세션 운영
- 방화벽 allowlist 구성

고정 IP가 있어도 관리자 페이지, PostgreSQL, Playwright 디버그 포트를 인터넷에 그대로 공개하지 않는다.

권장 접속 구조:

```text
외부 사용자 PC
→ Tailscale 또는 VPN
→ Debian 13 서버
→ Automoney 관리자 페이지
```

SSH 보안 기준:

- 공개키 인증만 사용
- root 직접 로그인 금지
- 비밀번호 로그인 비활성화
- 허용 사용자 제한
- fail2ban 또는 동등한 차단정책 적용
- 방화벽에서 필요한 포트만 허용

## 22.3 권장 디렉터리 구조

```text
/opt/automoney/app
/var/lib/automoney/data
/var/lib/automoney/images
/var/lib/automoney/playwright-profile
/var/lib/automoney/backups
/var/log/automoney
/etc/automoney/automoney.env
```

권한 기준:

- 전용 Linux 사용자 `automoney` 생성
- root로 앱 실행 금지
- `/etc/automoney/automoney.env` 권한 `600`
- Playwright 프로필과 주문정보는 `automoney` 사용자만 접근
- API key, secret, session 정보는 환경파일에서만 로드
- 관리자 업로드 파일과 주문 개인정보는 외부 공개 금지

## 22.4 권장 서비스 분리

최종 systemd 구성:

```text
automoney-web.service
automoney-scheduler.service
automoney-worker.service
automoney-playwright.service
automoney-order-poller.service
automoney-supplier-monitor.service
```

역할:

- `automoney-web`: 관리자 웹 UI/API
- `automoney-scheduler`: 3일 발굴, 하루 1개 개선 등 예약 실행
- `automoney-worker`: AI 분석·이미지·채널수정 처리
- `automoney-playwright`: 스피드등록 브라우저 자동화
- `automoney-order-poller`: 쿠팡·네이버 주문 및 송장 조회
- `automoney-supplier-monitor`: 공급가·재고·MOQ 감시

초기 이전 시 하나 또는 두 개의 process로 시작할 수 있지만 최종 운영에서는 장애 격리를 위해 분리한다.

## 22.5 Linux 호환성 기준

Windows 개발 중 다음 의존성을 제거하거나 설정화한다.

- Windows 절대경로 하드코딩 금지
- 드라이브 문자 기반 경로 금지
- `.bat` 전용 실행 금지
- `npm.cmd` 직접 의존 금지
- PowerShell 전용 명령 금지
- 사용자 PC 브라우저 프로필 고정 금지
- Windows 전용 파일 잠금 방식 금지

대신 다음을 사용한다.

- `path.join`, `path.resolve`
- 실행 명령 환경변수화
- 데이터·로그·이미지 경로 환경변수화
- Node.js/Python/Playwright 설치 스크립트
- Python virtual environment
- systemd 호환 worker
- POSIX 경로 지원
- graceful shutdown
- process lock 또는 PostgreSQL advisory lock

## 22.6 Debian 13 설치 항목

최소 설치 대상:

```text
Node.js LTS
npm
Python 3
python3-venv
PostgreSQL
Git
Codex CLI
Claude CLI/Claude Code
Playwright
Chromium 및 Playwright Linux dependencies
Nginx 또는 Caddy
Tailscale
fail2ban
```

Playwright는 화면이 없는 서버에서도 Chromium headless로 동작해야 한다. 로그인이나 CAPTCHA 대응을 위해 필요하면 Xvfb 또는 원격 브라우저 디버깅을 보조적으로 사용한다.

## 22.7 데이터 이전 절차

```text
1. Windows 전체 테스트 통과
2. PostgreSQL 백업 생성
3. 이미지·분석결과·프롬프트·Playwright 상태파일 목록화
4. Debian 13 서버에 앱 설치
5. PostgreSQL 복원
6. 파일 경로 변환
7. `.env` 신규 작성
8. Codex와 Claude 로그인
9. Playwright 로그인 세션 재생성
10. R2·쿠팡·네이버·도매매 read-only 검증
11. 스케줄러 비활성 상태로 수동 테스트
12. 주문 수집과 채널 수정 테스트
13. systemd 서비스 등록
14. Windows 스케줄러 중지
15. Debian 13 스케줄러 활성화
```

Windows와 Linux 스케줄러를 동시에 켜면 중복 등록과 중복 발주 위험이 있으므로 전환 시점에는 반드시 한쪽만 활성화한다.

## 22.8 백업 기준

- PostgreSQL: 매일 자동 백업
- 이미지/분석결과: 매일 증분 또는 주기적 동기화
- `.env`: 암호화된 별도 보관
- Playwright 프로필: 주기적 백업하되 쿠키 보안 유지
- 최근 7일 일일 백업
- 최근 4주 주간 백업
- 복원 테스트 정기 수행

## 22.9 모니터링 및 알림

최소 모니터링 항목:

- 웹서비스 상태
- worker 상태
- PostgreSQL 상태
- 디스크 사용량
- 메모리 사용량
- Playwright 로그인 만료
- Codex/Claude quota 오류
- 상품 발굴 실패
- 스피드등록 실패
- 주문 수집 지연
- 발주 실패
- 송장 반영 실패

치명적 오류는 관리자 화면과 텔레그램 등의 알림 채널로 전달할 수 있게 설계한다.

## 22.10 Debian 13 이전 완료 기준

- 서버 재부팅 후 모든 서비스 자동 시작
- 관리자 페이지 원격 접속 가능
- PostgreSQL 정상 복원
- Codex `GPT-5.6 Sol / low` 실행 성공
- Claude fallback 실행 성공
- Playwright 스피드등록 로그인 유지 또는 재로그인 가능
- 쿠팡·네이버 상품 조회/수정 성공
- 주문 조회 성공
- 도매매 read-only 조회 성공
- 백업 및 복원 테스트 통과
- Windows PC를 끈 상태에서도 72시간 이상 정상 운영

---


# 23. 테스트 기준

## 23.1 단위 테스트

- MOQ 계산
- tiered price 계산
- 판매수량→발주수량 변환
- 마진 계산
- 중복 상품 판정
- 중복 주문 판정
- 택배사 코드 변환
- 허용 필드 diff 검사

## 23.2 통합 테스트

- 상품 발굴→winner
- winner→스피드등록 큐
- 스피드등록→외부 상품번호 저장
- 외부 상품→개선 큐
- 이미지 개선→쿠팡/네이버 수정
- 주문→공급처 매핑
- 발주안→실발주
- 송장→채널 발송 처리

## 23.3 실운영 테스트

- 스피드등록 3건 연속
- 하루 1개 개선 3일 연속
- 공급처 가격변동 감지
- 쿠팡 주문 1건 수집
- 네이버 주문 1건 수집
- 도매매 소액 실발주
- 송장 자동 반영

## 23.4 회귀 테스트

- 기존 sellerProductId 유지
- draft 64 보호 해시 유지
- 기존 승인 이미지 유지
- 쿠팡 등록 payload 회귀 없음
- 네이버 이미지 수정 시 가격·옵션 불변

---

# 24. 구현 우선순위

## P0 — 즉시 구현

1. 현재 코드·DB·큐 상태 감사
2. Claude/Codex provider 공통 구조
3. MOQ와 2개 세트 계산 감사
4. 중복 상품 영구 방지
5. 스피드등록 Playwright 자동화
6. 쿠팡·네이버 상품번호 자동 저장
7. 하루 1개 개선을 기존 상품 수정까지 연결

## P1 — 판매 운영 필수

8. 공급처 가격·재고 감시
9. 쿠팡 주문 30분 수집
10. 네이버 주문 30분 수집
11. 주문과 공급처 상품·옵션 매핑
12. 도매매 발주안 생성
13. 사용자 발주 승인 화면

## P2 — 완전 자동화 마무리

14. 도매매 Private API 실발주
15. 송장 자동 수집
16. 쿠팡 발송 처리
17. 네이버 발송 처리
18. 취소·품절 예외 처리
19. 반품·교환 관리자 큐
20. 운영 알림

## P3 — 안정화 후

21. 일부 저위험 상품 자동 발주
22. 자동 가격조정
23. 카테고리별 성과분석
24. 실제 수익률에 따른 후보점수 자동 보정
25. 고정 IP Debian 13 서버 이전

---

# 25. 단계별 완료 조건

## 상품 발굴

- 3일마다 안전 카테고리 3개 선정
- 중복상품 0건
- MOQ와 마진 정확
- 카테고리별 최고점 선정

## 기본 등록

- 최대 3개 스피드등록
- 쿠팡·네이버 결과 저장
- 외부 상품번호 자동 연결
- 부분 성공 재개 가능

## 상품 개선

- 하루 1개 처리
- 대표·상세·제목·키워드만 수정
- 가격·재고·옵션 변경 0건
- Claude/Codex 전환 가능

## 주문 자동화

- 주문 30분 이내 수집
- 공급처 자동 매핑
- 중복 주문 0건
- 취소 주문 발주 0건

## 발주 자동화

- 최신 가격·재고 재검증
- 사용자 승인 후 실발주
- 중복 발주 0건
- 공급처 주문번호 저장

## 배송 자동화

- 송장 자동 수집
- 택배사 매핑
- 쿠팡·네이버 발송 처리
- 취소주문 오발송 0건

---

# 26. Claude에 전달할 개발 규칙

```text
1. 구현 전 현재 로컬 코드와 DB 상태를 먼저 조사한다.
2. 보고된 구현사항을 코드 확인 없이 다시 만들지 않는다.
3. 기존 draft, 이미지, sellerProductId, migration을 보호한다.
4. destructive git 명령을 사용하지 않는다.
5. 한 번에 하나의 Phase만 구현한다.
6. 구현 전 변경 파일과 데이터 흐름을 보고한다.
7. API 실제 호출은 read-only부터 검증한다.
8. 상품 등록·수정·발주 전 중복 방지 검사를 한다.
9. 실제 발주는 사용자 승인 뒤에만 실행한다.
10. 완료 보고에는 변경 파일, migration, 테스트 결과, 실제 검증 결과를 포함한다.
```

---

# 27. 당장 다음 작업 순서

```text
1. 현재 로컬 repo와 DB 상태 감사
2. 중단 AI 작업을 waiting_for_ai_quota로 정리
3. Claude/Codex provider 추상화
4. MOQ 1 우선 및 MOQ 2 세트 기준 감사
5. 상품 중복 방지 키 강화
6. 도매매·도매꾹 스피드등록 Playwright 자동화
7. 쿠팡·네이버 외부 상품번호 자동 수집
8. 등록 상품을 개선 큐에 적재
9. 하루 1개 상품 개선 후 두 채널 수정
10. 공급처 가격·재고 감시
11. 쿠팡 주문 30분 수집
12. 네이버 주문 30분 수집
13. 도매매 발주안 및 사용자 승인
14. 실발주·송장·채널 발송 처리
15. 전체 흐름 안정화 후 고정 IP Debian 13 서버 이전
```

---

# 28. 최종 목표 상태

```text
3일마다 새로운 상품 최대 3개가 자동 발굴되고
→ 도매매·도매꾹 스피드등록으로 쿠팡과 네이버에 올라가며
→ 하루 1개씩 대표·상세이미지·제목·키워드가 개선되고
→ 공급처 가격과 재고가 지속적으로 감시되며
→ 주문이 30분마다 수집되고
→ 도매매 발주안이 자동 생성되며
→ 사용자 승인 후 실발주되고
→ 송장이 쿠팡과 네이버에 자동 반영되는 상태
```

이 상태까지 완료되면 Automoney는 상품등록 프로그램이 아니라 **고정 IP Debian 13 서버에서 24시간 운영되는 무재고 온라인 판매 자동화 시스템**이 된다.
