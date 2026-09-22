# 바이오 스터디보드 — 리눅스 서버 설치 가이드

## 파일 구성

```
/var/www/biostudy/
├── index.html              ← bio-studyboard-standalone.html 을 이 이름으로 복사
└── reports/                ← fetch_reports.py 가 자동 생성
    ├── index.json          ← 페이지가 읽는 리포트 목록
    └── 196170/2026-09-09_91234.pdf ...
/opt/biostudy/fetch_reports.py
/opt/biostudy/fetch_news.py     ← 바이오 뉴스 헤드라인 수집 (표준 라이브러리만 사용)
```

## 1. 페이지 올리기

```bash
sudo mkdir -p /var/www/biostudy /opt/biostudy
sudo cp bio-studyboard-standalone.html /var/www/biostudy/index.html
sudo cp fetch_reports.py fetch_news.py /opt/biostudy/
```

## 2. 리포트 수집기 설치 · 첫 실행

```bash
pip install requests beautifulsoup4        # 또는 python3 -m venv 후 설치
python3 /opt/biostudy/fetch_reports.py --html /var/www/biostudy/index.html --out /var/www/biostudy
```

- 대시보드에 있는 국내 12개 종목코드를 자동으로 읽어서, 네이버 금융 리서치의 종목별 최신 리포트(기본 10건, 최근 1년)를 받습니다.
- 목표가·투자의견은 리포트 상세 페이지에서 읽고, 이미 받은 PDF는 다시 받지 않습니다.
- 직접 추가한 종목도 받으려면 `--codes 128940,293480` 처럼 덧붙이세요.
- **결과가 0건이면** 네이버 HTML 구조가 바뀐 것일 수 있어요. `--debug` 를 붙여 실행하면 `debug/list_<코드>.html` 이 저장되니, 그 파일을 Claude에게 주면 파서를 고쳐드립니다.

## 2-1. 뉴스 수집기 첫 실행

```bash
python3 /opt/biostudy/fetch_news.py --html /var/www/biostudy/index.html --out /var/www/biostudy
```

- 대시보드 24개 기업 이름으로 구글 뉴스 RSS를 검색하고, Fierce Biotech·BioPharma Dive·Endpoints·STAT·히트뉴스·메디파나·약업신문 RSS를 합쳐 최근 14일 헤드라인을 `news/news.json`에 저장해요.
- 제목 키워드로 임상/허가/기술수출/실적/정책을 분류하고 기업 태그를 붙여요. 페이지의 '바이오 뉴스' 탭 상단 '최신 헤드라인'과 기업별 '관련 뉴스'에 나타나요.
- 막히거나 주소가 바뀐 피드는 건너뛰고(`[skip]` 로그), 스크립트 맨 위 `FEEDS` 목록만 고치면 돼요.
- 요약·"왜 중요한지"가 붙은 큐레이션 뉴스는 Claude에게 "뉴스 업데이트해줘"라고 하면 새로 정리해서 페이지에 넣어드려요.

## 3. 매일 자동 실행 (cron)

```bash
crontab -e
# 평일 오전 7시 30분, 오후 6시
30 7,18 * * 1-5  /usr/bin/python3 /opt/biostudy/fetch_reports.py --html /var/www/biostudy/index.html --out /var/www/biostudy >> /var/log/biostudy-reports.log 2>&1
# 뉴스는 3시간마다
0 */3 * * *      /usr/bin/python3 /opt/biostudy/fetch_news.py --html /var/www/biostudy/index.html --out /var/www/biostudy >> /var/log/biostudy-news.log 2>&1
```

## 4. nginx 예시

```nginx
server {
    listen 80;
    server_name bio.example.com;
    root /var/www/biostudy;
    index index.html;

    location /reports/ {
        # 리포트 저작권은 증권사에 있음 — 외부 공개 서버라면 인증을 걸어두세요
        auth_basic "private";
        auth_basic_user_file /etc/nginx/.htpasswd;   # sudo htpasswd -c /etc/nginx/.htpasswd 호우
        add_header Cache-Control "no-cache";
    }

    # 나중에 한국투자증권 Open API 가격 서버를 붙일 때
    # location /api/ { proxy_pass http://127.0.0.1:8000; }
}
```

## 페이지가 서버 데이터를 쓰는 방식

| 경로 | 없으면 | 있으면 |
|---|---|---|
| `/reports/index.json` | 리포트 섹션에 조사된 애널리스트 기사 + 네이버 리서치 링크만 표시 | 종목별 최신 리포트 목록 + **PDF 바로 열기** |
| `/news/news.json` | 큐레이션 뉴스(요약 포함)만 표시 | 뉴스 탭에 '최신 헤드라인' + 기업별 관련 뉴스에 자동 수집 기사 추가 |
| `/api/bio-prices` | 9/21 스냅샷 가격 표시 | 현재가·등락률 실시간 반영 (형식은 페이지 소스의 PRICE_API 주석 참고) |

해외 종목의 증권사 리포트는 유료라 PDF 수집 대상이 아니고, 페이지에 애널리스트 의견 기사와 컨센서스 페이지 링크로 대신 표시됩니다.
