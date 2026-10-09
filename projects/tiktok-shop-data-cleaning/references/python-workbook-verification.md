# Python workbook verification recipe

Use this after each successful cleaning invocation. It checks the output file, the expected `数据` sheet, a non-empty header, and actual non-empty data rows. Compare `actual_rows` with the runner's reported `rows`; equality is required, including the valid case `0 == 0`.

```python
from openpyxl import load_workbook
from pathlib import Path

path = Path(r"D:/广告数据部/<店铺名>/20_清洗数据/<清洗表>.xlsx")
expected_rows = <CLI rows>
assert path.exists(), path
wb = load_workbook(path, read_only=True, data_only=True)
assert "数据" in wb.sheetnames, wb.sheetnames
ws = wb["数据"]
rows = list(ws.iter_rows(values_only=True))
assert rows and any(v is not None and str(v).strip() for v in rows[0]), "empty header"
actual_rows = sum(any(v is not None for v in row) for row in rows[1:])
assert actual_rows == expected_rows, (actual_rows, expected_rows)
print({"path": str(path), "sheets": wb.sheetnames,
       "columns": len(rows[0]), "actual_rows": actual_rows})
```

For multiple requested targets, keep each expected row count and output path separate; never let a failed target prevent verification/reporting of the other outputs.
