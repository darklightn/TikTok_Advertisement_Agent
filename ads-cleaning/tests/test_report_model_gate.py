from __future__ import annotations

import json
from pathlib import Path
import sys
import tempfile
import unittest

SCRIPTS_ROOT = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS_ROOT))

from scripts.cleaning.errors import CleaningError
from scripts.cleaning.pipeline import _validate_cleanable_reports


class ReportModelGateTests(unittest.TestCase):
    def _model_path(self, root: Path) -> Path:
        path = root / "first-model-v1.json"
        path.write_text(
            json.dumps(
                {
                    "datasets": [
                        {
                            "name": "ready_dataset",
                            "report_id": "ready_report",
                            "capability_status": "model_ready",
                        },
                        {
                            "name": "deferred_dataset",
                            "report_id": "deferred_report",
                            "capability_status": "deferred",
                        },
                    ]
                }
            ),
            encoding="utf-8",
        )
        return path

    def test_model_ready_report_is_accepted(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_name:
            _validate_cleanable_reports(
                ["ready_report"],
                self._model_path(Path(temporary_name)),
            )

    def test_non_ready_report_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_name:
            with self.assertRaises(CleaningError) as raised:
                _validate_cleanable_reports(
                    ["deferred_report"],
                    self._model_path(Path(temporary_name)),
                )

        self.assertEqual(raised.exception.code, "unsupported_report")


if __name__ == "__main__":
    unittest.main()
