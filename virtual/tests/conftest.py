import numpy as np
import pandas as pd
import pytest


@pytest.fixture
def prices():
    rng = np.random.default_rng(42)
    n = 1800
    change = rng.normal(0.0003, 0.015, n)
    close = 50000 * np.exp(np.cumsum(change))
    opening = np.r_[close[0], close[:-1]] * np.exp(rng.normal(0, 0.004, n))
    return pd.DataFrame({"Open": opening,
                         "High": np.maximum(opening, close) * (1 + rng.uniform(.001, .015, n)),
                         "Low": np.minimum(opening, close) * (1 - rng.uniform(.001, .015, n)),
                         "Close": close, "Volume": rng.integers(10000, 1000000, n)},
                        index=pd.bdate_range("2017-01-02", periods=n, name="Date"))
