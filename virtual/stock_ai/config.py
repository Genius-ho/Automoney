from pydantic import BaseModel, ConfigDict, Field, model_validator
from typing import Literal

TRAINING_VERSION = 'recent-5y-v1'


class Settings(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    feature_set: Literal['original','expanded'] = 'original'
    horizon: int = Field(10, ge=1, le=60)
    target_pct: float = Field(2, gt=0, le=100)
    threshold_pct: float = Field(60, ge=0, le=100)
    years: int = Field(10, ge=3, le=20)
    capital: float = Field(10000000, gt=0, le=1e12)
    buy_fee_pct: float = Field(.015, ge=0, le=5)
    sell_fee_pct: float = Field(.015, ge=0, le=5)
    sell_tax_pct: float = Field(.2, ge=0, le=50)
    slippage_pct: float = Field(.05, ge=0, le=5)
    fill_buffer_pct: float = Field(.05, ge=0, le=5)

    @model_validator(mode="after")
    def reasonable_costs(self):
        if self.sell_fee_pct + self.sell_tax_pct >= 100:
            raise ValueError("매도 비용 합계는 100% 미만이어야 합니다.")
        return self
