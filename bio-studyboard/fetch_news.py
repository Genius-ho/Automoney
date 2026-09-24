#!/usr/bin/env python3
"""
바이오 스터디보드 — 바이오 뉴스 자동 수집기 (RSS → <out>/news/news.json)

대시보드에 들어있는 기업 이름으로 구글 뉴스 RSS를 검색하고, 바이오 전문 매체 RSS를
합쳐서 최근 N일 헤드라인을 모읍니다. 제목 키워드로 분류(임상/허가/딜/실적/정책)와
기업 태그를 붙이고, 페이지는 /news/news.json 을 읽어 '최신 헤드라인'과
기업별 '관련 뉴스'에 표시합니다. (요약은 없고 제목·출처·링크만 — 요약된 큐레이션 뉴스는
Claude에게 "뉴스 업데이트해줘"라고 요청하면 갱신됩니다.)

사용법 (파이썬 표준 라이브러리만 사용)
  python3 fetch_news.py --html /var/www/biostudy/index.html --out /var/www/biostudy
  python3 fetch_news.py ... --days 10 --max 400
"""
import argparse, datetime as dt, email.utils, html, json, os, re, sys, time
import urllib.parse, urllib.request
import xml.etree.ElementTree as ET

UA = "Mozilla/5.0 (X11; Linux x86_64) BioStudyBoard-NewsBot/1.0"

# 전문 매체 RSS — 주소가 바뀌거나 막히면 이 목록만 고치면 됩니다 (실패한 피드는 건너뜀)
FEEDS = [
    ("gl", "Fierce Biotech",  "https://www.fiercebiotech.com/rss/xml"),
    ("gl", "BioPharma Dive",  "https://www.biopharmadive.com/feeds/news/"),
    ("gl", "Endpoints News",  "https://endpts.com/feed/"),
    ("gl", "STAT",            "https://www.statnews.com/category/biotech/feed/"),
    ("kr", "히트뉴스",         "https://www.hitnews.co.kr/rss/allArticle.xml"),
    ("kr", "메디파나뉴스",     "https://www.medipana.com/rss/allArticle.xml"),
    ("kr", "약업신문",         "https://www.yakup.com/rss/news.xml"),
]
# 기업명과 무관한 일반 검색 (구글 뉴스)
GENERAL_QUERIES = [
    ("kr", "바이오 임상 결과"), ("kr", "신약 FDA 승인"), ("kr", "바이오 기술수출"),
    ("gl", "biotech phase 3 results"), ("gl", "FDA approval drug"), ("gl", "biotech acquisition"),
]
# 영문 기업명 → 검색어 (구글 뉴스에서 정확도를 높이기 위해 따옴표 사용)
GL_QUERY = {
    "lilly": '"Eli Lilly"', "pfizer": "Pfizer", "novonordisk": '"Novo Nordisk"', "merck": '"Merck" drug',
    "regeneron": "Regeneron", "moderna": "Moderna", "novartis": "Novartis", "abbvie": "AbbVie",
    "astrazeneca": "AstraZeneca", "amgen": "Amgen", "roche": "Roche drug", "xbi": "XBI biotech ETF",
}
# 제목에서 기업을 찾아 태그하기 위한 별칭 (국내는 대시보드 이름 자동 사용)
ALIASES = {
    "lilly": ["eli lilly", "lilly", "릴리"], "pfizer": ["pfizer", "화이자"], "novonordisk": ["novo nordisk", "novo", "노보"],
    "merck": ["merck", "msd", "머크"], "regeneron": ["regeneron", "리제네론"], "moderna": ["moderna", "모더나"],
    "novartis": ["novartis", "노바티스"], "abbvie": ["abbvie", "애브비"], "astrazeneca": ["astrazeneca", "아스트라제네카"],
    "amgen": ["amgen", "암젠"], "roche": ["roche", "genentech", "로슈", "제넨텍"],
    "aribio": ["아리바이오"], "samsungbio": ["삼성바이오로직스", "삼성바이오"], "samsungepis": ["삼성에피스", "삼성바이오에피스"],
    "celltrionph": ["셀트리온제약"], "hanall": ["한올바이오"], "kolontissue": ["코오롱티슈진", "tg-c"], "skbiopharm": ["sk바이오팜"],
}
CATS = [  # (category, regex on lower-cased title) — first match wins
    ("approval", r"fda|ema|식약처|허가|승인|approv|crl|pdufa|보완요구|advisory committee|자문위|품목허가|nda|bla"),
    ("clinical", r"임상|phase|trial|topline|톱라인|데이터|data|readout|results|효능|1상|2상|3상|esmo|asco|aacr|wclc|ctad|easd"),
    ("deal",     r"마일스톤|milestone|로열티|royalt|기술수출|기술이전|라이선스|licens|acqui|인수|m&a|merger|deal|계약|파트너십|partnership|collaborat|공동개발"),
    ("finance",  r"실적|매출|영업이익|earnings|revenue|유상증자|offering|ipo|상장|목표주가|target price|guidance|주가"),
    ("policy",   r"약가|관세|tariff|drug pricing|mfn|정책|규제|policy|보험|급여|법안|bill"),
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
