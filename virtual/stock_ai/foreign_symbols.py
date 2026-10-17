"""Preserve Korean names from the same public listing source used by FDR."""
from concurrent.futures import ThreadPoolExecutor
import math
import pandas as pd
import requests


def us_listing(exchange):
    if exchange not in ('NASDAQ','NYSE','AMEX'):raise ValueError('지원하지 않는 거래소입니다.')
    def page(number):
        response=requests.get(f'https://api.stock.naver.com/stock/exchange/{exchange}/marketValue',
            params={'page':number,'pageSize':60},headers={'User-Agent':'Mozilla/5.0'},timeout=8)
        response.raise_for_status()
        data=response.json()
        if not isinstance(data.get('stocks'),list):raise ValueError('해외 종목 목록 응답이 잘못되었습니다.')
        return data
    first=page(1);total=int(first['totalCount'])
    if not 0<total<=30000:raise ValueError('해외 종목 목록 크기가 잘못되었습니다.')
    records=list(first['stocks'])
    with ThreadPoolExecutor(max_workers=4) as pool:
        for data in pool.map(page,range(2,math.ceil(total/60)+1)):
            if not data['stocks']:raise ValueError('해외 종목 목록 일부가 누락되었습니다.')
            records.extend(data['stocks'])
    frame=pd.DataFrame([{'Symbol':row.get('symbolCode',''),
        'Name':row.get('stockNameEng',''),'NameKo':row.get('stockName',''),
        'Industry':(row.get('industryCodeType') or {}).get('industryGroupKor','')}
        for row in records])
    return frame.drop_duplicates('Symbol',keep='last')
