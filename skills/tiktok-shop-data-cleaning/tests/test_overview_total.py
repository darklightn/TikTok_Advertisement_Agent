from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from common import CleaningError, select_official_overview_total_row, safe_divide


@pytest.mark.parametrize("dimension", ["时间", "按天"])
def test_official_total_wins_over_different_detail_sum(dimension):
    total = {dimension: " - ", "成本": 3, "Gross revenue (Current shop)": 10.01}
    rows = [{dimension: "2026-08-01", "成本": 3, "Gross revenue (Current shop)": 10}, total]
    assert select_official_overview_total_row(rows) is total


@pytest.mark.parametrize("value", [None, "", "  ", "N/A", "--", float("nan")])
def test_missing_values_are_not_official_markers(value):
    with pytest.raises(CleaningError, match="缺少官方总计"):
        select_official_overview_total_row([{"按天": value, "成本": 5}])


@pytest.mark.parametrize("rows", [
    [], [{"unknown": "-"}],
    [{"按天": "2026-08-01"}, {"时间": "-"}],
    [{"按天": "2026-08-01"}, {"成本": 5}],
    [{"时间": "-", "按天": "2026-08-01"}],
])
def test_unknown_or_inconsistent_dimension_fails(rows):
    with pytest.raises(CleaningError) as exc:
        select_official_overview_total_row(rows)
    assert exc.value.code == "INVALID_OVERVIEW_SCHEMA"


def test_duplicate_totals_fail_even_if_identical():
    with pytest.raises(CleaningError) as exc:
        select_official_overview_total_row([{"按天": "-", "成本": 5}] * 2)
    assert exc.value.code == "DUPLICATE_OVERVIEW_TOTAL"


def test_consistent_dual_dimensions_and_zero_cost():
    total = {"时间": "-", "按天": "-", "成本": 0}
    assert select_official_overview_total_row([total]) is total
    assert safe_divide(10, total["成本"]) is None
