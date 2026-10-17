import json

import pandas as pd
import pytest

from stock_ai.symbols import SymbolResolver


@pytest.mark.parametrize('query,code', [('삼성저낮','005930'), ('셀트링노','068270'),
                                       ('SK하이닉쓰','000660')])
def test_typo_candidates_are_ranked_and_require_confirmation(tmp_path, query, code):
    resolver = SymbolResolver(tmp_path)
    resolver.rows.append({'code':'068270','name':'셀트리온','market':'KR','aliases':[]})
    matches = resolver.search(query)
    assert matches and matches[0]['code'] == code
    assert matches[0]['match_type'] == 'fuzzy'


def test_exact_codes_do_not_get_guessed_and_noise_does_not_match(tmp_path):
    resolver = SymbolResolver(tmp_path)
    assert resolver.search('005930')[0]['code'] == '005930'
    assert resolver.search('005931')[0]['unverified'] is True
    assert resolver.search('0167A0')[0]['market'] == 'KR'
    assert resolver.search('아무것도없는이름') == []
    assert resolver.search('삼성')[0].get('match_type') != 'fuzzy'


def test_old_catalog_merges_seeds_aliases_and_etfs_without_losing_saved_rows(tmp_path):
    rows = [{'code':'AAPL','name':'Apple Inc.','market':'US','aliases':['내별칭']},
            {'code':'128940','name':'한미약품','market':'KR','aliases':[]}]
    (tmp_path/'symbols.json').write_text(json.dumps({'rows':rows}), encoding='utf-8')
    resolver = SymbolResolver(tmp_path)
    assert resolver.search('애플')[0]['code'] == 'AAPL'
    assert resolver.search('내별칭')[0]['code'] == 'AAPL'
    assert resolver.search('한미약품')[0]['code'] == '128940'
    assert resolver.search('비트코인 ETF', market='US')[0]['code'] == 'IBIT'
    assert resolver.search('금 ETF', market='US')[0]['code'] == 'GLD'
    assert resolver.search('국채 ETF', market='US')[0]['code'] == 'TLT'
    assert resolver.search('GLD', market='KR') == []


def test_market_filter_happens_before_candidate_limit(tmp_path):
    resolver = SymbolResolver(tmp_path)
    resolver.rows = [{'code':str(i).zfill(6),'name':f'ETF {i}','market':'KR','aliases':[]} for i in range(60)]
    resolver.rows.append({'code':'TEST','name':'ETF US','market':'US','aliases':[]})
    assert resolver.search('ETF', market='US')[0]['code'] == 'TEST'


def test_refresh_imports_etf_symbol_column_updates_names_and_preserves_aliases(tmp_path, monkeypatch):
    import FinanceDataReader as fdr
    resolver = SymbolResolver(tmp_path)
    resolver.rows.append({'code':'069500','name':'Old ETF','market':'KR','aliases':['내ETF']})
    calls = []
    def listing(source):
        calls.append(source)
        if source == 'KRX':
            return pd.DataFrame([{'Code':'005930','Name':'삼성전자'}])
        return pd.DataFrame([{'Symbol':'069500','Name':'KODEX 200'},
                             {'Symbol':'411060','Name':'ACE KRX금현물'},
                             {'Symbol':'0167A0','Name':'SOL AI반도체TOP2플러스'},
                             {'Symbol':None,'Name':'잘못된 코드'}])
    monkeypatch.setattr(fdr,'StockListing',listing)
    resolver.refresh('KR')
    assert calls == ['KRX','ETF/KR']
    match = resolver.search('코덱스 200')[0]
    assert match['code'] == '069500' and match['asset_type'] == 'ETF'
    assert resolver.search('내ETF')[0]['code'] == '069500'
    assert resolver.search('금 ETF', market='KR')[0]['code'] == '411060'
    assert resolver.search('에이스 금 ETF', market='KR')[0]['code'] == '411060'
    assert resolver.search('솔 AI반도체')[0]['code'] == '0167A0'
    assert not any(row['code']=='00None' for row in resolver.rows)
    assert SymbolResolver(tmp_path).search('KODEX 200')[0]['name'] == 'KODEX 200'


def test_failed_refresh_keeps_catalog_on_disk_and_in_memory(tmp_path, monkeypatch):
    import FinanceDataReader as fdr
    resolver = SymbolResolver(tmp_path)
    before = list(resolver.rows)
    def listing(source):
        if source == 'ETF/KR':
            raise RuntimeError('offline')
        return pd.DataFrame([{'Code':'123456','Name':'New'}])
    monkeypatch.setattr(fdr,'StockListing',listing)
    with pytest.raises(RuntimeError, match='offline'):
        resolver.refresh('KR')
    assert resolver.rows == before
    assert not resolver.path.exists()


def test_korean_us_names_and_english_names_are_searchable_and_do_not_hide_domestic_matches(tmp_path):
    resolver=SymbolResolver(tmp_path)
    resolver.rows.append({'code':'067310','name':'하나마이크론','market':'KR','aliases':[]})
    matches=resolver.search('마이크론')
    assert {r['code'] for r in matches}>={'MU','067310'}
    micron=resolver.search('MU')[0]
    assert '마이크론' in micron['name'] and 'Micron' in micron['name_en']
    assert resolver.search('Micron Technology')[0]['code']=='MU'


def test_us_refresh_keeps_provider_korean_names_and_industry(tmp_path,monkeypatch):
    import stock_ai.foreign_symbols as foreign
    def listing(exchange):
        return pd.DataFrame([{'Symbol':'MU','Name':'Micron Technology Inc.','NameKo':'마이크론 테크놀로지','Industry':'반도체'}])
    monkeypatch.setattr(foreign,'us_listing',listing)
    resolver=SymbolResolver(tmp_path);resolver.refresh('US')
    match=resolver.search('MU')[0]
    assert match['name']=='마이크론 테크놀로지' and match['industry']=='반도체'
    assert resolver.search('Micron Technology')[0]['code']=='MU'
