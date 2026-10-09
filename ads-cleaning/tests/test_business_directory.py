from __future__ import annotations

import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "business_directory.py"
SPEC = importlib.util.spec_from_file_location("business_directory", MODULE_PATH)
assert SPEC and SPEC.loader
business_directory = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(business_directory)


class BusinessDirectoryPublishTests(unittest.TestCase):
    def test_semantically_identical_xlsx_reuse_returns_actual_target_sha256(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_name:
            root = Path(temporary_name)
            source = root / "source.xlsx"
            source.write_bytes(b"new workbook bytes")
            source_sha256 = hashlib.sha256(source.read_bytes()).hexdigest()
            item = {
                "layer": "RAW",
                "name": "example_report",
                "mapping": {"chinese_group": "test_group", "chinese_table_name": "test_table"},
                "source": source,
                "sha256": source_sha256,
                "content_sha256": "same-semantic-content",
                "date_label": "2026-08-17",
            }
            target = root / "shop" / "10_导出原始" / "test_group" / "test_table" / "2026-08-17.xlsx"
            target.parent.mkdir(parents=True)
            target.write_bytes(b"existing workbook bytes")
            target_sha256 = hashlib.sha256(target.read_bytes()).hexdigest()
            original_content_hash = business_directory._xlsx_content_hash
            business_directory._xlsx_content_hash = lambda _: "same-semantic-content"
            try:
                published_target, version, was_reused, published_sha256 = business_directory._publish_item(item, root / "shop")
            finally:
                business_directory._xlsx_content_hash = original_content_hash

            self.assertEqual(published_target, target)
            self.assertEqual(version, 1)
            self.assertTrue(was_reused)
            self.assertEqual(published_sha256, target_sha256)
            self.assertNotEqual(published_sha256, source_sha256)

    def test_new_file_publish_returns_source_sha256(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_name:
            root = Path(temporary_name)
            source = root / "source.csv"
            source.write_bytes(b"header\nvalue\n")
            source_sha256 = hashlib.sha256(source.read_bytes()).hexdigest()
            item = {
                "layer": "CLEAN",
                "name": "example_dataset",
                "mapping": {"chinese_group": "test_group", "chinese_table_name": "test_table"},
                "source": source,
                "sha256": source_sha256,
                "content_sha256": None,
                "date_label": "2026-08-17",
            }

            target, version, was_reused, published_sha256 = business_directory._publish_item(item, root / "shop")

            self.assertEqual(version, 1)
            self.assertFalse(was_reused)
            self.assertEqual(published_sha256, source_sha256)
            self.assertEqual(target.read_bytes(), source.read_bytes())


if __name__ == "__main__":
    unittest.main()
