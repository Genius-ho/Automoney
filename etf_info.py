"""Offline reference information for supported leveraged products."""

ETF_INFO = {
    "TQQQ": ("ProShares UltraPro QQQ", "ETF · NASDAQ-100 일간 3배", "나스닥 비금융 대형주에 집중합니다.", [("NVDA","엔비디아"),("MSFT","마이크로소프트"),("AAPL","애플"),("AMZN","아마존"),("AVGO","브로드컴"),("GOOGL","알파벳"),("META","메타"),("TSLA","테슬라")]),
    "SOXL": ("Direxion Daily Semiconductor Bull 3X", "ETF · 미국 반도체 일간 3배", "반도체 설계·제조·장비 기업에 집중합니다.", [("NVDA","엔비디아"),("AVGO","브로드컴"),("AMD","AMD"),("QCOM","퀄컴"),("MU","마이크론"),("AMAT","어플라이드 머티어리얼즈"),("LRCX","램리서치"),("KLAC","KLA")]),
    "KORU": ("Direxion Daily MSCI South Korea Bull 3X", "ETF · 한국 주식 일간 3배", "한국 대형·중형주와 원화 환율 영향을 받습니다.", [("005930","삼성전자"),("000660","SK하이닉스"),("207940","삼성바이오로직스"),("005380","현대차"),("000270","기아"),("105560","KB금융"),("035420","NAVER")]),
    "UPRO": ("ProShares UltraPro S&P500", "ETF · S&P 500 일간 3배", "미국 대형주 시장 전반에 노출됩니다.", [("NVDA","엔비디아"),("MSFT","마이크로소프트"),("AAPL","애플"),("AMZN","아마존"),("META","메타"),("AVGO","브로드컴"),("JPM","JP모건")]),
    "SPXL": ("Direxion Daily S&P 500 Bull 3X", "ETF · S&P 500 일간 3배", "미국 대형주 시장 전반에 노출됩니다.", [("NVDA","엔비디아"),("MSFT","마이크로소프트"),("AAPL","애플"),("AMZN","아마존"),("META","메타"),("AVGO","브로드컴"),("JPM","JP모건")]),
    "TECL": ("Direxion Daily Technology Bull 3X", "ETF · 미국 기술주 일간 3배", "정보기술 섹터에 집중합니다.", [("NVDA","엔비디아"),("MSFT","마이크로소프트"),("AAPL","애플"),("AVGO","브로드컴"),("CRM","세일즈포스"),("ORCL","오라클"),("CSCO","시스코")]),
    "FNGU": ("MicroSectors FANG+ 3X Leveraged ETN", "ETN · FANG+ 일간 3배", "ETF가 아니며 대형 성장주 집중위험과 발행사 신용위험이 있습니다.", [("META","메타"),("AAPL","애플"),("AMZN","아마존"),("NFLX","넷플릭스"),("GOOGL","알파벳"),("MSFT","마이크로소프트"),("NVDA","엔비디아")]),
    "LABU": ("Direxion Daily S&P Biotech Bull 3X", "ETF · 미국 바이오텍 일간 3배", "미국 바이오테크 기업에 분산 노출됩니다.", [("ALNY","앨나일람"),("VRTX","버텍스"),("REGN","리제네론"),("GILD","길리어드"),("BIIB","바이오젠"),("MRNA","모더나")]),
    "TNA": ("Direxion Daily Small Cap Bull 3X", "ETF · Russell 2000 일간 3배", "미국 소형주 시장에 분산 노출됩니다.", [("IWM","Russell 2000 노출"),("INSM","인스메드"),("FTAI","FTAI 에비에이션"),("HIMS","힘스앤허스"),("RKLB","로켓랩")]),
    "FAS": ("Direxion Daily Financial Bull 3X", "ETF · 미국 금융주 일간 3배", "은행·보험·결제·자본시장 기업에 집중합니다.", [("BRK.B","버크셔 해서웨이"),("JPM","JP모건"),("V","비자"),("MA","마스터카드"),("BAC","뱅크오브아메리카"),("GS","골드만삭스")]),
    "UDOW": ("ProShares UltraPro Dow30", "ETF · 다우30 일간 3배", "미국 대표 우량주 30개로 구성된 가격가중 지수에 노출됩니다.", [("UNH","유나이티드헬스"),("GS","골드만삭스"),("MSFT","마이크로소프트"),("HD","홈디포"),("CAT","캐터필러"),("V","비자")]),
}