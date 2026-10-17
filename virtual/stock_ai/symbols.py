import json
import re
import unicodedata
from difflib import SequenceMatcher
from pathlib import Path
from datetime import datetime
from .data import timed_call

SEEDS = [
    ("005930", "삼성전자", "KR", "Samsung Samsung Electronics"),
    ("005935", "삼성전자우", "KR", "Samsung preferred"),
    ("207940", "삼성바이오로직스", "KR", "Samsung Biologics 삼성바이오"),
    ("028260", "삼성물산", "KR", "Samsung C&T"),
    ("018260", "삼성에스디에스", "KR", "Samsung SDS 삼성SDS"),
    ("009150", "삼성전기", "KR", "Samsung Electro-Mechanics"),
    ("000660", "SK하이닉스", "KR", "SK Hynix 하이닉스"),
    ("035420", "NAVER", "KR", "네이버"),
    ("035720", "카카오", "KR", "Kakao"),
    ("005380", "현대차", "KR", "Hyundai Motor 현대자동차"),
    ("AAPL", "Apple", "US", "애플"),
    ("MSFT", "Microsoft", "US", "마이크로소프트"),
    ("NVDA", "NVIDIA", "US", "엔비디아"),
    ("TSLA", "Tesla", "US", "테슬라"),
    ("AMZN", "Amazon", "US", "아마존"),
    ("GOOGL", "Alphabet", "US", "구글 Google 알파벳"),
    ("MU", "Micron Technology", "US", "마이크론 마이크론테크놀로지"),
]

US_KOREAN_NAMES = {'AAPL':'애플','MSFT':'마이크로소프트','NVDA':'엔비디아',
    'TSLA':'테슬라','AMZN':'아마존','GOOGL':'알파벳','MU':'마이크론 테크놀로지',
    'AMD':'AMD','GLD':'SPDR 금 ETF','TLT':'아이셰어즈 미국 장기국채 ETF',
    'IBIT':'아이셰어즈 비트코인 ETF'}

# US ETF name coverage supplements the exchange listings. KR ETFs come from ETF/KR.
ETF_SEEDS = [
    ('GLD', 'SPDR Gold Shares', ['금', '금 ETF', '골드', '골드 ETF', 'SPDR 골드']),
    ('TLT', 'iShares 20+ Year Treasury Bond ETF',
     ['채권', '채권 ETF', '국채 ETF', '미국 국채', '미국 장기채', '미국 장기채 ETF']),
    ('IBIT', 'iShares Bitcoin Trust ETF',
     ['비트코인', '비트코인 ETF', '아이셰어즈 비트코인', 'Bitcoin ETF']),
]

ETF_BRANDS = {'KODEX':'코덱스', 'TIGER':'타이거', 'ACE':'에이스',
              'RISE':'라이즈', 'SOL':'솔', 'PLUS':'플러스', 'HANARO':'하나로',
              'KOSEF':'코세프', 'KINDEX':'킨덱스', 'KBSTAR':'케이비스타'}
KR_CODE = r'\d{4}[0-9A-HJ-NP-TV-Z][0-9KLMN]'


def etf_aliases(name):
    aliases = []
    for brand, korean in ETF_BRANDS.items():
        if name.upper().startswith(brand):
            aliases.append(korean + name[len(brand):])
    if re.search(r'KRX금|금현물|금선물|골드|gold', name, re.I):
        aliases += ['금', '금 ETF', '골드 ETF']
    if re.search(r'국채|국고채|채권|treasury|bond', name, re.I):
        aliases += ['채권', '채권 ETF']
    if re.search(r'국채|국고채|treasury', name, re.I):
        aliases.append('국채 ETF')
    return aliases

SAMSUNG_FIVE = [
    {'code': code, 'name': name, 'market': 'KR'}
    for code, name in [('207940', '삼성바이오로직스'), ('005930', '삼성전자'),
                       ('028260', '삼성물산'), ('018260', '삼성에스디에스'), ('009150', '삼성전기')]
]


def normal(value):
    return re.sub(r"[\s._\-()+/]+", "", unicodedata.normalize('NFC', value)).casefold().replace('이티에프', 'etf')


class SymbolResolver:
    def __init__(self, directory):
        self.path = Path(directory) / "symbols.json"
        self.rows = [{"code": c, "name": n, "market": m, "aliases": a.split(" ") + [a]}
                     for c, n, m, a in SEEDS]
        if self.path.exists():
            try:
                cached = json.loads(self.path.read_text(encoding="utf-8"))["rows"]
                if isinstance(cached, list) and all(isinstance(r, dict) and
                        all(isinstance(r.get(k), str) for k in ('code', 'name', 'market')) and
                        isinstance(r.get('aliases', []), list) and
                        all(isinstance(a, str) for a in r.get('aliases', [])) for r in cached):
                    merged = {(r['market'], r['code']): dict(r) for r in cached}
                    for seed in self.rows:
                        key = (seed['market'], seed['code'])
                        old = merged.get(key, seed)
                        merged[key] = {**old, 'aliases':list(dict.fromkeys(old.get('aliases', []) + seed['aliases']))}
                    self.rows = list(merged.values())
            except (OSError, ValueError, KeyError):
                pass
        merged = {(r['market'], r['code']): r for r in self.rows}
        for code, name, aliases in ETF_SEEDS:
            old = merged.get(('US', code), {'code':code, 'name':name, 'market':'US'})
            merged[('US', code)] = {**old, 'asset_type':'ETF',
                'aliases':list(dict.fromkeys(old.get('aliases', []) + aliases + [name]))}
        self.rows = list(merged.values())
        for row in self.rows:
            if row['market']=='US' and row['code'] in US_KOREAN_NAMES:
                english=row.get('name_en',row['name'])
                korean=row.get('name_ko',US_KOREAN_NAMES[row['code']])
                row.update(name=korean,name_ko=korean,name_en=english,
                    aliases=list(dict.fromkeys(row.get('aliases',[])+[english,korean])))

    def refresh(self, market="KR"):
        import FinanceDataReader as fdr
        if market not in ('KR', 'US'):
            raise ValueError('지원하지 않는 시장입니다.')
        listings = ["KRX", "ETF/KR"] if market == "KR" else ["NASDAQ", "NYSE", "AMEX"]
        # Build a replacement first, so a failed source cannot erase or half-update the cache.
        merged = {(r['market'], r['code']): dict(r) for r in self.rows}
        for listing in listings:
            if market=='US':
                from .foreign_symbols import us_listing
                frame=timed_call(lambda:us_listing(listing),timeout=90)
            else:
                frame = timed_call(lambda: fdr.StockListing(listing))
            for _, row in frame.iterrows():
                code = str(row.get("Code", row.get("Symbol", ""))).strip().upper()
                if market == "KR":
                    code = code.zfill(6)
                else:
                    code = code.upper()
                english = str(row.get("Name", "")).strip()
                korean = str(row.get('NameKo','')).strip()
                if korean in ('nan','None'):korean=''
                name = korean or english
                if not re.fullmatch(KR_CODE if market == 'KR' else r'[A-Z][A-Z0-9.-]{0,9}', code) or name in ('', 'nan', 'None'):
                    continue
                old = merged.get((market, code), {})
                if market=='US' and not korean and old.get('name_ko'):name=old['name_ko']
                aliases = old.get('aliases', []) + ([old['name']] if old.get('name') and old['name'] != name else [])
                if market=='US':aliases += [english]
                is_etf = listing == 'ETF/KR' or old.get('asset_type') == 'ETF'
                if is_etf:
                    aliases += etf_aliases(name)
                merged[(market, code)] = {**old, 'code':code, 'name':name, 'market':market,
                    'aliases':list(dict.fromkeys(aliases)), 'asset_type':'ETF' if is_etf else 'stock'}
                if market=='US':
                    merged[(market,code)].update(name_en=english,name_ko=korean or old.get('name_ko',''),
                        industry=str(row.get('Industry','')).strip())
        rows = list(merged.values())
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix('.json.tmp')
        temporary.write_text(json.dumps({"updated": datetime.now().isoformat(), "rows": rows},
                                       ensure_ascii=False), encoding="utf-8")
        temporary.replace(self.path)
        self.rows = rows

    def search(self, query, market=None):
        query = query.strip()
        q = normal(query)
        if not q:
            return []
        rows = [r for r in self.rows if market is None or r['market'] == market]
        codes = [r for r in rows if q == normal(r['code'])]
        if codes:
            return codes
        exact = [r for r in rows if q in [normal(r["name"]),
                                               *[normal(a) for a in r.get("aliases", [])]]]
        partial = [r for r in rows if any(q in normal(a) for a in
                   [r["name"], r["code"], *r.get("aliases", [])])]
        if exact:
            keys={(r['market'],r['code']) for r in exact}
            return (exact+[r for r in partial if (r['market'],r['code']) not in keys])[:50]
        if partial:
            return partial[:50]
        terms = [normal(term) for term in query.split() if normal(term)]
        if len(terms) > 1:
            keywords = [r for r in rows if all(term in normal(' '.join(
                [r['name'], *r.get('aliases', []), 'ETF' if r.get('asset_type') == 'ETF' else '']))
                for term in terms)]
            if keywords:
                return keywords[:50]
        kr_code = bool(re.fullmatch(KR_CODE, query.upper()))
        code_market = 'KR' if kr_code else 'US'
        if kr_code or re.fullmatch(r"[A-Z][A-Z0-9.-]{0,9}", query):
            if market is not None and market != code_market:
                return []
            return [{"code": query.upper(), "name": query.upper(), "market": code_market,
                     "aliases": [], "unverified": True}]
        if len(q) < 3 or q.isdigit():
            return []
        candidates = []
        for row in rows:
            score = 0
            for name in [row['name'], *row.get('aliases', [])]:
                target = normal(name)
                if min(len(q), len(target)) / max(len(q), len(target), 1) < .6:
                    continue
                literal = SequenceMatcher(None, q, target, autojunk=False).ratio()
                # Jamo comparison catches Korean syllables differing by one keystroke.
                jamo = SequenceMatcher(None, unicodedata.normalize('NFD', q),
                                       unicodedata.normalize('NFD', target), autojunk=False).ratio()
                value = .35 * literal + .65 * jamo
                if literal >= .45 and value >= .69:
                    score = max(score, value)
            if score:
                candidates.append({**row, 'match_type':'fuzzy', 'match_score':round(score, 4)})
        candidates.sort(key=lambda r: (-r['match_score'], len(r['name']), r['code']))
        return candidates[:8]
