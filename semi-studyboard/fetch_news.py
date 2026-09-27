#!/usr/bin/env python3
"""
반도체 소부장 스터디보드 — 반도체 뉴스 자동 수집기 (RSS → <out>/news/news.json)

대시보드에 들어있는 기업 이름으로 구글 뉴스 RSS를 검색하고, 반도체 전문 매체 RSS를
합쳐서 최근 N일 헤드라인을 모읍니다. 제목 키워드로 분류(수주/실적/증설/정책)와
기업 태그를 붙이고, 페이지는 /news/news.json 을 읽어 '최신 헤드라인'과
기업별 '관련 뉴스'에 표시합니다.

사용법 (파이썬 표준 라이브러리만 사용)
  python3 fetch_news.py --html /var/www/semistudy/index.html --out /var/www/semistudy
  python3 fetch_news.py ... --days 10 --max 400
"""
import argparse, datetime as dt, email.utils, html, json, os, re, sys, time
import urllib.parse, urllib.request
import xml.etree.ElementTree as ET

UA = "Mozilla/5.0 (X11; Linux x86_64) SemiStudyBoard-NewsBot/1.0"

# 전문 매체 RSS — 주소가 바뀌거나 막히면 이 목록만 고치면 됩니다 (실패한 피드는 건너뜀)
FEEDS = [
    ("gl", "SemiAnalysis",     "https://semianalysis.com/feed/"),
    ("gl", "EE Times",         "https://www.eetimes.com/feed/"),
    ("kr", "디일렉",           "https://www.thelec.kr/rss/allArticle.xml"),
    ("kr", "전자신문",         "https://rss.etnews.com/Section901.xml"),
    ("kr", "한국경제",         "https://www.hankyung.com/feed/economy"),
]
# 기업명과 무관한 일반 검색 (구글 뉴스)
GENERAL_QUERIES = [
    ("kr", "반도체 소부장"), ("kr", "반도체 수주"), ("kr", "반도체 증설"),
    ("gl", "semiconductor equipment order"), ("gl", "chip export controls"), ("gl", "fab capacity expansion"),
]
# 영문 기업명 → 검색어 (구글 뉴스에서 정확도를 높이기 위해 따옴표 사용)
GL_QUERY = {
    "micron": "Micron", "asml": "ASML", "amat": '"Applied Materials"', "lamresearch": '"Lam Research"',
    "tel": '"Tokyo Electron"', "kla": "KLA Corporation", "advantest": "Advantest",
    "teradyne": "Teradyne", "asetech": '"ASE Technology"', "amkor": "Amkor",
    "asmpt": "ASMPT", "besi": "BESI semiconductor", "shinetsu": '"Shin-Etsu"',
    "sumco": "SUMCO", "entegris": "Entegris", "ibiden": "Ibiden semiconductor",
}
# 제목에서 기업을 찾아 태그하기 위한 별칭 (국내는 대시보드 이름 자동 사용)
ALIASES = {
    "micron": ["micron", "마이크론"], "asml": ["asml"], "amat": ["applied materials", "어플라이드 머티리얼즈"],
    "lamresearch": ["lam research", "램리서치", "램 리서치"], "tel": ["tokyo electron", "도쿄일렉트론"],
    "kla": ["kla"], "advantest": ["advantest", "어드반테스트"], "teradyne": ["teradyne", "테라다인"],
    "asetech": ["ase technology", "ase"], "amkor": ["amkor", "앰코"], "asmpt": ["asmpt"],
    "besi": ["besi"], "shinetsu": ["shin-etsu", "신에츠"], "sumco": ["sumco", "섬코"],
    "entegris": ["entegris", "인테그리스"], "ibiden": ["ibiden", "이비덴"],
}
CATS = [  # (category, regex on lower-cased title) — first match wins
    ("approval", r"인증|승인|품질인증|양산 승인|qualification|approv"),
    ("clinical", r"양산|수율|시제품|개발 성공|테스트 통과|샘플|R&D|기술 개발"),
    ("deal",     r"공급계약|수주|파트너십|partnership|계약|협력|공동개발|collaborat|MOU"),
    ("finance",  r"실적|매출|영업이익|earnings|revenue|증설|capa|캐펙스|capex|투자 확대|target price|가동률"),
    ("policy",   r"관세|tariff|수출규제|export control|보조금|subsidy|정책|규제|policy|법안|bill"),
]


# 번역기가 회사명을 직역하지 않도록 보호할 고유명사 목록 (해외 바이오 전문지 헤드라인에 자주 등장)
KNOWN_NAMES = [
    "Eli Lilly", "Lilly", "Pfizer", "Novo Nordisk", "Merck", "Regeneron", "Moderna", "Novartis",
    "AbbVie", "AstraZeneca", "Amgen", "Roche", "Genentech", "Recursion Pharmaceuticals", "Recursion",
    "Illumina", "Bristol Myers Squibb", "Bristol-Myers Squibb", "Gilead Sciences", "Gilead", "Sanofi",
    "GSK", "GlaxoSmithKline", "Johnson & Johnson", "J&J", "Vertex Pharmaceuticals", "Vertex", "Biogen",
    "Alnylam", "Sarepta Therapeutics", "Sarepta", "BioNTech", "argenx", "Ionis Pharmaceuticals", "Ionis",
    "Incyte", "Legend Biotech", "Genmab", "United Therapeutics", "Takeda", "Bayer", "Boehringer Ingelheim",
    "Eisai", "Daiichi Sankyo", "Jazz Pharmaceuticals", "Jazz", "Horizon Therapeutics", "Seagen",
    "Immunovant", "Halozyme", "Halozyme Therapeutics",
]


def _protect_names(title):
    """번역 전 고유명사를 자리표시자로 바꾸고, 복원용 매핑을 돌려줍니다."""
    mapping = {}
    protected = title
    for i, name in enumerate(sorted(KNOWN_NAMES, key=len, reverse=True)):
        placeholder = f"Zzq{i}Zzq"
        pattern = re.compile(re.escape(name), re.IGNORECASE)
        if pattern.search(protected):
            protected = pattern.sub(placeholder, protected)
            mapping[placeholder] = name
    return protected, mapping


def _restore_names(text, mapping):
    for placeholder, name in mapping.items():
        # 번역기가 대소문자를 바꾸거나 공백을 넣기도 해서 느슨하게 매칭
        text = re.sub(re.escape(placeholder), name, text, flags=re.IGNORECASE)
    return text


def translate_titles(items, cache_path, sleep=0.4, max_calls=200):
    """해외(region='gl') 헤드라인 제목을 한국어로 번역해 item['titleKo']에 채웁니다.
    MyMemory 무료 API(키 불필요, 일일 쿼터 제한)를 쓰고, 캐시 파일로 중복 번역을 피합니다."""
    try:
        cache = json.load(open(cache_path, encoding="utf-8"))
    except Exception:
        cache = {}
    calls = 0
    for item in items:
        if item.get("region") != "gl":
            continue
        title = item["title"]
        key = re.sub(r"[\W_]+", "", title.lower())[:80]
        cached = cache.get(key)
        if cached:
            item["titleKo"] = cached
            continue
        if calls >= max_calls:
            continue  # 다음 실행에서 이어서 번역 (캐시에 없는 항목만 남음)
        try:
            protected, mapping = _protect_names(title)
            q = urllib.parse.quote(protected[:490])
            resp = fetch(f"https://api.mymemory.translated.net/get?q={q}&langpair=en|ko", timeout=10)
            data = json.loads(resp)
            translated = (data.get("responseData") or {}).get("translatedText", "").strip()
            # MyMemory returns the English source back on failure/quota-exceeded; skip those
            if translated and translated.lower() != protected.lower() and "MYMEMORY WARNING" not in translated:
                translated = _restore_names(translated, mapping)
                item["titleKo"] = translated
                cache[key] = translated
        except Exception as e:
            print(f"[번역 실패] {title[:40]}...: {e}", file=sys.stderr)
        calls += 1
        time.sleep(sleep)
    # 캐시가 무한히 커지지 않도록 최근 4000건만 보관
    if len(cache) > 4000:
        cache = dict(list(cache.items())[-4000:])
    try:
        json.dump(cache, open(cache_path, "w", encoding="utf-8"), ensure_ascii=False, indent=0)
    except Exception:
        pass
    return items


def fetch(url, timeout=15):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/rss+xml, application/xml, text/xml, */*"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def gnews(q, region):
    if region == "kr":
        p = {"q": q + " when:14d", "hl": "ko", "gl": "KR", "ceid": "KR:ko"}
    else:
        p = {"q": q + " when:14d", "hl": "en-US", "gl": "US", "ceid": "US:en"}
    return "https://news.google.com/rss/search?" + urllib.parse.urlencode(p)


def parse_rss(raw):
    """RSS 2.0 / Atom → [{title, url, date(YYYY-MM-DD), source}]"""
    out = []
    try:
        root = ET.fromstring(raw)
    except ET.ParseError:
        return out
    ns = {"a": "http://www.w3.org/2005/Atom"}
    for it in root.iter("item"):
        title = (it.findtext("title") or "").strip()
        link = (it.findtext("link") or "").strip()
        src_el = it.find("source")
        src = src_el.text.strip() if src_el is not None and src_el.text else ""
        d = it.findtext("pubDate") or it.findtext("{http://purl.org/dc/elements/1.1/}date") or ""
        out.append({"title": title, "url": link, "date": norm_date(d), "source": src})
    for it in root.findall("a:entry", ns):
        title = (it.findtext("a:title", default="", namespaces=ns) or "").strip()
        le = it.find("a:link", ns)
        link = le.get("href") if le is not None else ""
        d = it.findtext("a:updated", default="", namespaces=ns) or it.findtext("a:published", default="", namespaces=ns)
        out.append({"title": title, "url": link, "date": norm_date(d), "source": ""})
    return out


def norm_date(s):
    s = (s or "").strip()
    if not s:
        return ""
    try:
        return email.utils.parsedate_to_datetime(s).date().isoformat()
    except Exception:
        pass
    m = re.match(r"(\d{4})[-./](\d{1,2})[-./](\d{1,2})", s)
    return f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}" if m else ""


def clean_title(t, source):
    t = html.unescape(re.sub(r"<[^>]+>", "", t)).strip()
    # 구글 뉴스 제목 끝의 " - 매체명" 제거
    if source and t.endswith(" - " + source):
        t = t[: -len(" - " + source)]
    return re.sub(r"\s+", " ", t)


def classify(title):
    low = title.lower()
    for cat, rx in CATS:
        if re.search(rx, low):
            return cat
    return None


def companies_from_html(path):
    txt = open(path, encoding="utf-8").read()
    rows = re.findall(r'id:"([a-z0-9]+)", name:"([^"]+)", ticker:"[^"]*", region:"(kr|gl)"', txt)
    return [{"id": i, "name": n, "region": r} for i, n, r in rows]


def tag_companies(title, companies):
    low = title.lower()
    hits = []
    for c in companies:
        names = ALIASES.get(c["id"], []) + [c["name"].lower().split("(")[0].strip()]
        if any(n and (re.search(r"\b" + re.escape(n) + r"\b", low) if n.isascii() else n in low) for n in names):
            hits.append(c["id"])
    return hits


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--html", help="대시보드 HTML 경로 (기업 목록 자동 추출)")
    ap.add_argument("--out", required=True, help="웹 루트 (여기에 news/news.json 생성)")
    ap.add_argument("--days", type=int, default=14, help="최근 N일 (기본 14)")
    ap.add_argument("--max", type=int, default=300, help="최대 항목 수 (기본 300)")
    ap.add_argument("--sleep", type=float, default=1.0, help="요청 간 대기(초)")
    ap.add_argument("--keep-uncategorized", action="store_true", help="분류 안 되는 제목도 보관")
    a = ap.parse_args()

    companies = companies_from_html(a.html) if a.html else []
    jobs = []  # (region, label, url, fixed_company_id)
    for c in companies:
        q = GL_QUERY.get(c["id"], c["name"].split("(")[0]) if c["region"] == "gl" else f'"{c["name"].split("(")[0]}"'
        jobs.append((c["region"], "Google News", gnews(q, c["region"]), c["id"]))
    for region, q in GENERAL_QUERIES:
        jobs.append((region, "Google News", gnews(q, region), None))
    for region, label, url in FEEDS:
        jobs.append((region, label, url, None))

    cutoff = (dt.date.today() - dt.timedelta(days=a.days)).isoformat()
    seen, items, ok, fail = set(), [], 0, 0
    for region, label, url, fixed in jobs:
        try:
            entries = parse_rss(fetch(url))
            ok += 1
        except Exception as e:
            fail += 1
            print(f"[skip] {label}: {e}", file=sys.stderr)
            time.sleep(a.sleep)
            continue
        for e in entries:
            src = e["source"] or label
            title = clean_title(e["title"], src)
            if not title or not e["url"] or (e["date"] and e["date"] < cutoff):
                continue
            key = re.sub(r"[\W_]+", "", title.lower())[:60]
            if key in seen:
                continue
            cat = classify(title)
            tags = tag_companies(title, companies)
            if fixed and fixed not in tags:
                # 기업명 검색 결과인데 제목에 기업명이 없으면 관련도가 낮음 → 건너뜀
                continue
            if not cat and not fixed and not a.keep_uncategorized:
                continue   # 일반 피드의 비(非)바이오 기사 제외; 기업명 검색 결과는 '기타'로 보관
            seen.add(key)
            items.append({"date": e["date"], "region": region, "category": cat or "etc",
                          "companies": tags, "title": title, "source": src, "url": e["url"]})
        time.sleep(a.sleep)

    items.sort(key=lambda x: x["date"], reverse=True)
    items = items[: a.max]
    os.makedirs(os.path.join(a.out, "news"), exist_ok=True)
    cache_path = os.path.join(a.out, "news", "translate_cache.json")
    items = translate_titles(items, cache_path)
    translated = sum(1 for x in items if x.get("titleKo"))
    path = os.path.join(a.out, "news", "news.json")
    tmp = path + ".tmp"
    json.dump({"generatedAt": dt.datetime.now().strftime("%Y-%m-%d %H:%M"), "items": items},
              open(tmp, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    os.replace(tmp, path)
    print(f"완료: 피드 {ok}개 성공 / {fail}개 실패, 헤드라인 {len(items)}개(번역 {translated}건) → {path}")


if __name__ == "__main__":
    main()
