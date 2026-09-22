#!/usr/bin/env python3
"""
바이오 스터디보드 — 증권사 리포트 수집기 (네이버 금융 리서치 → PDF 다운로드 + index.json)

대시보드(bio-studyboard.html)에 들어있는 국내 종목코드를 읽어서, 네이버 금융
'종목분석 리포트' 목록에서 최신 리포트를 찾아 PDF를 내려받고, 페이지가 읽는
<out>/reports/index.json 을 만듭니다.

사용법
  pip install requests beautifulsoup4
  python3 fetch_reports.py --html /var/www/biostudy/index.html --out /var/www/biostudy
  python3 fetch_reports.py --codes 196170,000100 --out /var/www/biostudy   # 종목 직접 지정
  python3 fetch_reports.py ... --debug     # 파싱이 0건이면 받은 HTML을 debug/ 에 저장

결과
  <out>/reports/<종목코드>/<날짜>_<nid>.pdf
  <out>/reports/index.json   ← 대시보드가 /reports/index.json 으로 읽음

주의: 리포트 저작권은 각 증권사에 있습니다. 개인 학습용으로만 쓰고, 서버를 외부에
공개한다면 /reports/ 경로에 인증(예: nginx basic auth)을 걸어 두세요.
"""
import argparse, datetime as dt, hashlib, json, os, re, sys, time
from urllib.parse import urljoin, urlparse, parse_qs

import requests
from bs4 import BeautifulSoup

BASE = "https://finance.naver.com/research/"
# 2026-09: finance.naver.com/research 가 stock.naver.com 으로 이전 → 모바일 JSON API 사용
LIST_URL = "https://m.stock.naver.com/api/research/stock/{code}?page={page}&pageSize=20"
DETAIL_API = "https://m.stock.naver.com/api/research/company/{nid}"
DETAIL_PAGE = "https://m.stock.naver.com/research/company/{nid}"
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
DATE_RE = re.compile(r"^\d{2}\.\d{2}\.\d{2}$")


def session():
    s = requests.Session()
    s.headers.update({"User-Agent": UA, "Referer": "https://finance.naver.com/research/"})
    return s


def decode(resp):
    # 네이버 금융은 EUC-KR(cp949)로 내려옴
    for enc in ("cp949", "utf-8"):
        try:
            return resp.content.decode(enc)
        except UnicodeDecodeError:
            continue
    return resp.content.decode("cp949", errors="replace")


def codes_from_html(path):
    txt = open(path, encoding="utf-8").read()
    # 대시보드 데이터의 ticker:"196170·KOSDAQ" 형태
    found = re.findall(r'ticker:"([0-9A-Z]{6})·(?:KOSPI|KOSDAQ)"', txt)
    seen, out = set(), []
    for c in found:
        if c not in seen:
            seen.add(c); out.append(c)
    return out


def parse_list(html):
    """네이버 리서치 종목분석 목록 HTML → [{title, nid, detail, broker, pdf, date}]"""
    soup = BeautifulSoup(html, "html.parser")
    items = []
    for tr in soup.select("table.type_1 tr"):
        a = tr.find("a", href=re.compile(r"company_read\.naver"))
        if not a:
            continue
        tds = tr.find_all("td")
        href = urljoin(BASE, a["href"])
        nid = (parse_qs(urlparse(href).query).get("nid") or [""])[0]
        pdf_a = tr.find("a", href=re.compile(r"\.pdf($|\?)", re.I))
        dates = [td.get_text(strip=True) for td in tds if DATE_RE.match(td.get_text(strip=True))]
        # 열 순서: 종목명 | 제목 | 증권사 | 첨부 | 작성일 | 조회수
        title_idx = next((i for i, td in enumerate(tds) if a in td.find_all("a")), 1)
        broker = tds[title_idx + 1].get_text(strip=True) if len(tds) > title_idx + 1 else ""
        items.append({
            "title": a.get_text(strip=True),
            "nid": nid,
            "detail": href,
            "broker": broker,
            "pdf_src": pdf_a["href"] if pdf_a else None,
            "date": ("20" + dates[0].replace(".", "-")) if dates else "",
        })
    return items


def parse_list_json(data):
    """모바일 API 목록 JSON → parse_list 와 같은 형태 (pdf_src 는 상세에서 채움)"""
    return [{"title": x.get("title", ""), "nid": str(x.get("researchId", "")),
             "detail": DETAIL_PAGE.format(nid=x.get("researchId")),
             "broker": x.get("brokerName", ""), "pdf_src": None,
             "date": x.get("writeDate", "")} for x in data if isinstance(x, dict)]


def fetch_detail_json(s, nid):
    """상세 JSON → (pdf 주소, 목표가, 투자의견)"""
    rc = s.get(DETAIL_API.format(nid=nid), timeout=15).json().get("researchContent") or {}
    goal = rc.get("goalPrice")
    target = f"{int(goal):,}원" if goal and str(goal).isdigit() and int(goal) > 0 else None
    return rc.get("attachUrl"), target, (rc.get("opinion") or None)


def parse_detail(html):
    """리포트 상세 페이지에서 목표가·투자의견 (없으면 None)"""
    soup = BeautifulSoup(html, "html.parser")
    target = opinion = None
    money = soup.select_one("em.money strong") or soup.select_one("em.money")
    if money:
        t = money.get_text(strip=True)
        if re.search(r"\d", t):
            target = t + ("원" if not t.endswith("원") else "")
    com = soup.select_one("em.coment") or soup.select_one("em.comment")
    if com:
        opinion = com.get_text(strip=True) or None
    return target, opinion


def safe(s):
    return re.sub(r"[^\w가-힣.-]+", "_", s).strip("_")[:40] or "report"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--html", help="대시보드 HTML 경로 (종목코드 자동 추출)")
    ap.add_argument("--codes", help="쉼표로 구분한 종목코드 (--html 과 함께 쓰면 합쳐짐)")
    ap.add_argument("--out", required=True, help="웹 루트 (여기에 reports/ 생성)")
    ap.add_argument("--max", type=int, default=10, help="종목당 최대 리포트 수 (기본 10)")
    ap.add_argument("--days", type=int, default=365, help="최근 N일 이내 리포트만 (기본 365)")
    ap.add_argument("--no-detail", action="store_true", help="상세 페이지(목표가/의견) 조회 생략")
    ap.add_argument("--sleep", type=float, default=0.8, help="요청 간 대기(초)")
    ap.add_argument("--debug", action="store_true")
    a = ap.parse_args()

    codes = []
    if a.html:
        codes += codes_from_html(a.html)
    if a.codes:
        codes += [c.strip() for c in a.codes.split(",") if c.strip()]
    codes = list(dict.fromkeys(codes))
    if not codes:
        sys.exit("종목코드가 없습니다. --html 또는 --codes 를 지정하세요.")

    root = os.path.join(a.out, "reports")
    os.makedirs(root, exist_ok=True)
    idx_path = os.path.join(root, "index.json")
    try:
        index = json.load(open(idx_path, encoding="utf-8"))
    except Exception:
        index = {"items": {}}
    cutoff = (dt.date.today() - dt.timedelta(days=a.days)).isoformat()
    s = session()
    total_new = 0

    for code in codes:
        try:
            r = s.get(LIST_URL.format(code=code, page=1), timeout=15)
            r.raise_for_status()
        except Exception as e:
            print(f"[{code}] 목록 요청 실패: {e}", file=sys.stderr)
            continue
        html = decode(r)
        try:
            listed = parse_list_json(json.loads(html))
        except ValueError:
            listed = parse_list(html)
        rows = [x for x in listed if not x["date"] or x["date"] >= cutoff][: a.max]
        if not rows:
            print(f"[{code}] 리포트 0건 (최근 {a.days}일)")
            if a.debug:
                os.makedirs("debug", exist_ok=True)
                open(f"debug/list_{code}.html", "w", encoding="utf-8").write(html)
            index["items"].setdefault(code, [])
            time.sleep(a.sleep)
            continue

        prev = {x.get("nid"): x for x in index["items"].get(code, [])}
        out_rows = []
        for x in rows:
            old = prev.get(x["nid"], {})
            item = {"date": x["date"], "broker": x["broker"], "title": x["title"],
                    "opinion": old.get("opinion"), "target": old.get("target"),
                    "nid": x["nid"], "detail": x["detail"], "source": x["pdf_src"] or old.get("source"), "pdf": old.get("pdf")}
            x["pdf_src"] = x["pdf_src"] or old.get("source")
            if not a.no_detail and not old:
                try:
                    time.sleep(a.sleep)
                    x["pdf_src"], item["target"], item["opinion"] = fetch_detail_json(s, x["nid"])
                    item["source"] = x["pdf_src"]
                except Exception as e:
                    print(f"[{code}] 상세 실패 nid={x['nid']}: {e}", file=sys.stderr)
            if x["pdf_src"]:
                folder = os.path.join(root, code)
                os.makedirs(folder, exist_ok=True)
                fname = f"{x['date']}_{x['nid'] or hashlib.md5(x['title'].encode()).hexdigest()[:10]}.pdf"  # ASCII-only
                fpath = os.path.join(folder, fname)
                if not os.path.exists(fpath):
                    try:
                        time.sleep(a.sleep)
                        pr = s.get(x["pdf_src"], timeout=30)
                        pr.raise_for_status()
                        if pr.content[:4] != b"%PDF":
                            raise ValueError("PDF가 아닌 응답")
                        with open(fpath, "wb") as f:
                            f.write(pr.content)
                        total_new += 1
                        print(f"[{code}] ↓ {fname}")
                    except Exception as e:
                        print(f"[{code}] PDF 실패 {x['pdf_src']}: {e}", file=sys.stderr)
                        fpath = None
                if fpath and os.path.exists(fpath):
                    item["pdf"] = f"reports/{code}/{fname}"  # 페이지 기준 상대경로 (/bio/ 아래 서빙)
            out_rows.append(item)
        index["items"][code] = out_rows
        print(f"[{code}] {len(out_rows)}건")
        time.sleep(a.sleep)

    index["generatedAt"] = dt.datetime.now().strftime("%Y-%m-%d %H:%M")
    tmp = idx_path + ".tmp"
    json.dump(index, open(tmp, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    os.replace(tmp, idx_path)
    print(f"완료: 새 PDF {total_new}개, index → {idx_path}")


if __name__ == "__main__":
    main()
