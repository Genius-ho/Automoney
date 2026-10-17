from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo
import hashlib
import io
import re
import threading
import pandas as pd
import numpy as np

REQUIRED = ["Open", "High", "Low", "Close", "Volume"]


def clean_exchange_rates(frame, today=None):
    df=frame.copy()
    if 'Date' in df:df=df.set_index('Date')
    if 'Close' not in df:raise ValueError('환율 종가가 없습니다.')
    df.index=pd.to_datetime(df.index,errors='coerce')
    if df.index.isna().any():raise ValueError('환율 날짜가 잘못되었습니다.')
    if df.index.tz is not None:df.index=df.index.tz_localize(None)
    df.index=df.index.normalize()
    df=df[~df.index.duplicated(keep='last')].sort_index()
    today=today or datetime.now(ZoneInfo('America/New_York')).date()
    df=df.loc[df.index<pd.Timestamp(today),['Close']]
    df['Close']=pd.to_numeric(df.Close,errors='coerce')
    if (df.Close.dropna()<=0).any() or np.isinf(df.Close.to_numpy()).any():
        raise ValueError('환율은 유효한 양수여야 합니다.')
    missing=int(df.Close.isna().sum());df=df.dropna()
    if df.empty:raise ValueError('완료된 환율 자료가 없습니다.')
    df.index.name='Date'
    df.attrs['rate_warning']=f'환율 종가 누락 {missing}행 제외; 이전 관측값은 최대 7일까지만 사용합니다.' if missing else None
    return df


def clean_prices(frame, market="KR", today=None):
    df = frame.copy()
    if "Date" in df:
        df = df.set_index("Date")
    if not set(REQUIRED).issubset(df.columns):
        raise ValueError("Date, Open, High, Low, Close, Volume 열이 필요합니다.")
    df.index = pd.to_datetime(df.index, errors="raise").tz_localize(None).normalize()
    df = df[REQUIRED].apply(pd.to_numeric, errors="raise").sort_index()
    df = df[~df.index.duplicated(keep="last")]
    excluded = []
    if market == "KR":
        # Korean feeds retain the close on some days with no trades, while
        # reporting zero O/H/L and volume. These are not executable bars.
        nontrading = ((df[["Open", "High", "Low"]] == 0).all(axis=1) &
                     (df.Volume == 0) & (df.Close > 0) & np.isfinite(df.Close))
        excluded = df.index[nontrading].strftime("%Y-%m-%d").tolist()
        df = df.loc[~nontrading].copy()
    if not np.isfinite(df.to_numpy()).all() or (df[REQUIRED[:4]] <= 0).any().any() or (df.Volume < 0).any():
        raise ValueError("가격/거래량에 음수, 결측 또는 무한값이 있습니다.")
    corrected = []
    if market == "KR":
        upper = df[["Open", "Close"]].max(axis=1)
        lower = df[["Open", "Close"]].min(axis=1)
        # Bound the exception to integer KR prices and a one-won difference.
        # Keep larger discrepancies and inverted high/low ranges invalid.
        one_won = (((df.High < upper) | (df.Low > lower)) &
                   (upper - df.High <= 1) & (df.Low - lower <= 1) &
                   (df.High >= df.Low) & (df[REQUIRED[:4]] % 1 == 0).all(axis=1))
        corrected = df.index[one_won].strftime("%Y-%m-%d").tolist()
        df.loc[one_won, "High"] = df.loc[one_won, ["High", "Open", "Close"]].max(axis=1)
        df.loc[one_won, "Low"] = df.loc[one_won, ["Low", "Open", "Close"]].min(axis=1)
    if ((df.High < df[["Open", "Close", "Low"]].max(axis=1)) |
        (df.Low > df[["Open", "Close", "High"]].min(axis=1))).any():
        raise ValueError("고가/저가와 시가/종가 관계가 잘못되었습니다.")
    today = today or datetime.now(ZoneInfo("Asia/Seoul" if market == "KR" else "America/New_York")).date()
    df = df[df.index < pd.Timestamp(today)]
    df.index.name = "Date"
    if df.empty:
        raise ValueError("완료된 가격 데이터가 없습니다.")
    warnings = []
    if excluded:
        dates = ", ".join(excluded[:8]) + (" 외" if len(excluded) > 8 else "")
        warnings.append(f"무거래 일봉 {len(excluded)}건 제외: {dates}. 예측 기간은 남은 일봉 기준입니다.")
    if corrected:
        dates = ", ".join(corrected[:8]) + (" 외" if len(corrected) > 8 else "")
        warnings.append(f"고가/저가 1원 경계 불일치 {len(corrected)}건 보정: {dates}.")
    df.attrs["price_warning"] = "; ".join(warnings) or None
    return df


def read_csv(text, market="KR"):
    if len(text.encode("utf-8")) > 10_000_000:
        raise ValueError("CSV는 10MB 이하로 입력하세요.")
    return clean_prices(pd.read_csv(io.StringIO(text), dtype={"Date": str}), market)


def original_frame(frame):
    """Preserve raw source rows and supplied Change for original AI calculations."""
    df = frame.copy()
    if 'Date' in df:
        df = df.set_index('Date')
    if not set(REQUIRED).issubset(df.columns):
        raise ValueError('Date, Open, High, Low, Close, Volume 열이 필요합니다.')
    df.index = pd.to_datetime(df.index, errors='raise').tz_localize(None)
    if df.empty:
        raise ValueError('데이터를 불러올 수 없습니다.')
    # CSV column order may differ; Close must occupy original position 3.
    df = df[REQUIRED + [c for c in df.columns if c not in REQUIRED]].apply(pd.to_numeric, errors='raise')
    if (df.Close <= 0).any() or (df[REQUIRED] < 0).any().any():
        raise ValueError('가격/거래량에 음수 또는 유효하지 않은 종가가 있습니다.')
    return df


def read_original_csv(text):
    if len(text.encode('utf-8')) > 10_000_000:
        raise ValueError('CSV는 10MB 이하여야 합니다.')
    df = original_frame(pd.read_csv(io.StringIO(text), dtype={'Date': str}))
    if 'Change' not in df:
        df['Change'] = df.Close.pct_change(fill_method=None)
    return df


def data_hash(df):
    return hashlib.sha256(df.to_csv(float_format="%.10g").encode()).hexdigest()


def timed_call(call, timeout=25):
    result, done = [], threading.Event()
    def worker():
        try:
            result.append((True, call()))
        except Exception as exc:
            result.append((False, exc))
        finally:
            done.set()
    threading.Thread(target=worker, daemon=True).start()
    if not done.wait(timeout):
        raise TimeoutError("주가 조회 시간 초과. 캐시 또는 CSV를 사용하세요.")
    ok, value = result[0]
    if not ok:
        raise value
    return value


class DataProvider:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)

    def exchange_rates(self,years=5):
        cache=self.directory/'FX_USDKRW.csv'
        start=(datetime.now()-timedelta(days=years*366+10)).date().isoformat()
        warning=None
        try:
            import FinanceDataReader as fdr
            df=clean_exchange_rates(timed_call(lambda:fdr.DataReader('USD/KRW',start)))
            warning=df.attrs.get('rate_warning')
            try:df.to_csv(cache)
            except OSError:warning='; '.join(filter(None,[warning,'환율 캐시 저장 실패']))
            source='FinanceDataReader'
        except Exception as exc:
            if not cache.exists():raise ValueError(f'환율 조회 실패: {exc}') from exc
            df=clean_exchange_rates(pd.read_csv(cache))
            warning='; '.join(filter(None,[f'환율 실시간 조회 실패, 캐시 사용: {exc}',df.attrs.get('rate_warning')]))
            source='환율 캐시'
        df=df.loc[df.index>=pd.Timestamp(start)]
        if df.empty:raise ValueError('조회 기간에 유효한 환율 자료가 없습니다.')
        return df,{'source':source,'last_date':str(df.index[-1].date()),'warning':warning}

    def original_prices(self, code, market='KR'):
        if not re.fullmatch(r'[A-Za-z0-9.&^:_-]{1,30}', code):
            raise ValueError('잘못된 종목 코드입니다.')
        cache = self.directory / f"original_{market}_{code.replace(':', '_')}.csv"
        warning = None
        try:
            import FinanceDataReader as fdr
            df = original_frame(timed_call(lambda: fdr.DataReader(code)))
            source = 'FinanceDataReader'
            try:
                df.to_csv(cache, index_label='Date')
            except OSError:
                warning = '원본 가격 캐시 저장 실패'
        except Exception as exc:
            if not cache.exists():
                raise ValueError(f'원본 가격 조회 실패: {exc}. CSV 입력도 사용할 수 있습니다.') from exc
            df = original_frame(pd.read_csv(cache))
            source = '원본 가격 캐시'
            warning = f'실시간 조회 실패, 원본 캐시 사용: {exc}'
        return df, {'source': source, 'last_date': str(df.index[-1].date()),
                    'warning': warning, 'history': '전체 조회 이력', 'current_day_included': True}

    def prices(self, code, years=10, market="KR", completed_today=False):
        if not re.fullmatch(r"[A-Za-z0-9.&^:_-]{1,30}", code):
            raise ValueError("잘못된 종목 코드입니다.")
        cache = self.directory / f"{market}_{code.replace(':', '_')}.csv"
        start = (datetime.now() - timedelta(days=years * 366)).date().isoformat()
        warning = None
        try:
            import FinanceDataReader as fdr
            raw = timed_call(lambda: fdr.DataReader(code, start))
            local_now = datetime.now(ZoneInfo("Asia/Seoul" if market == "KR" else "America/New_York"))
            cutoff = (local_now.date()+timedelta(days=1)) if completed_today and market == "KR" and local_now.hour >= 18 else None
            df = clean_prices(raw, market, today=cutoff)
            warning = df.attrs.get("price_warning")
            try:
                df.to_csv(cache)
            except OSError:
                warning = "; ".join(filter(None, [warning, "가격 캐시 저장 실패"]))
            source = "FinanceDataReader"
        except Exception as exc:
            if not cache.exists():
                raise ValueError(f"가격 조회 실패: {exc}. CSV 입력도 사용할 수 있습니다.") from exc
            local_now = datetime.now(ZoneInfo("Asia/Seoul" if market == "KR" else "America/New_York"))
            cutoff = (local_now.date()+timedelta(days=1)) if completed_today and market == "KR" and local_now.hour >= 18 else None
            df = clean_prices(pd.read_csv(cache), market, today=cutoff)
            df = df[df.index >= pd.Timestamp(start)]
            source = "가격 캐시"
            warning = "; ".join(filter(None, [f"실시간 조회 실패, 캐시 사용: {exc}",
                                               df.attrs.get("price_warning")]))
        return df, {"source": source, "last_date": str(df.index[-1].date()), "warning": warning}
