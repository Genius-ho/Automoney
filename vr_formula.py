"""Pure Value Rebalancing (VR_SKILL) "실력공식" calculations.

Only the skill formula is implemented here:

    V_next = V + Pool/G + (E - V) / (2 * sqrt(G))

The plain/base VR formula from the book is intentionally NOT implemented in
this module. Per spec, the operating Strategy Engine only ever uses the
skill formula; the base formula, if ever needed, belongs only in book-example
comparison tests, never in production code.

All math is Decimal. sqrt(G) uses Decimal.sqrt() under the interpreter's
current decimal context (28 significant digits by default) -- precise enough
that it never needs its own rounding step. Only the final V/band results are
rounded to the cent (via mumae_core.money's existing ROUND_HALF_UP-to-cent
rule, the same rule used for order prices), so intermediate terms keep full
precision and rounding never compounds across cycles.
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from mumae_core import money

TWO = Decimal("2")
HUNDRED = Decimal("100")


@dataclass(frozen=True)
class VBreakdown:
    """Full-precision components of one V_next calculation, for audit
    logging and the UI formula breakdown."""

    old_V: Decimal
    E: Decimal
    Pool: Decimal
    G: Decimal
    pool_term: Decimal
    market_adjustment_term: Decimal
    new_V: Decimal


def next_v(V: Decimal, E: Decimal, Pool: Decimal, G: Decimal) -> VBreakdown:
    """Compute V_next using the VR skill formula.

    V_next = V + Pool/G + (E - V) / (2 * sqrt(G))
    """
    if G <= 0:
        raise ValueError("G must be positive.")
    pool_term = Pool / G
    market_adjustment_term = (E - V) / (TWO * G.sqrt())
    new_V = money(V + pool_term + market_adjustment_term)
    return VBreakdown(
        old_V=V,
        E=E,
        Pool=Pool,
        G=G,
        pool_term=pool_term,
        market_adjustment_term=market_adjustment_term,
        new_V=new_V,
    )


def band(V: Decimal, band_pct: Decimal) -> tuple[Decimal, Decimal]:
    """Return (lower_band, upper_band) = V * (1 -+ band_pct%)."""
    if band_pct <= 0:
        raise ValueError("Band percentage must be positive.")
    lower = money(V * (Decimal("1") - band_pct / HUNDRED))
    upper = money(V * (Decimal("1") + band_pct / HUNDRED))
    return lower, upper
