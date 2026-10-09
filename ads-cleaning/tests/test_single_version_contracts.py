from __future__ import annotations

import json
from pathlib import Path
import sys
import tempfile
import unittest
import uuid


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import business_directory
import locate_exports
from cleaning.errors import CleaningError
from cleaning.manifest_v3 import _validate_file_contract, validate_v3_manifest
from cleaning.output import detect_field_dictionary_schema
from cleaning.pipeline import clean
from cleaning.storage_contracts import validate_cleaning_batch_manifest_v3


class SingleVersionContractTests(unittest.TestCase):
    def test_clean_rejects_v1_and_v2_export_manifests(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_name:
            root = Path(temporary_name)
            for version in ("export_batch_manifest_v1", "export_batch_manifest_v2"):
                manifest_path = root / f"{version}.json"
                manifest_path.write_text(json.dumps({"schema_version": version}), encoding="utf-8")
                with self.subTest(version=version):
                    with self.assertRaises(CleaningError) as caught:
                        clean(
                            manifest_path,
                            ["gmvmax_campaign_overview"],
                            root / "output",
                            ROOT / "config" / "first-model-v1.json",
                            ROOT / "config" / "source-schema-baseline-v1.json",
                        )
                    self.assertEqual(caught.exception.code, "manifest_schema_unsupported")

    def test_locator_rejects_v1_and_v2_export_manifests(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_name:
            root = Path(temporary_name)
            for version in ("export_batch_manifest_v1", "export_batch_manifest_v2"):
                manifest_path = root / f"{version}.json"
                manifest_path.write_text(json.dumps({"schema_version": version}), encoding="utf-8")
                with self.subTest(version=version):
                    with self.assertRaises(locate_exports.LocatorError) as caught:
                        locate_exports._load_manifest(manifest_path)
                    self.assertEqual(caught.exception.code, "invalid_manifest")

    def test_field_dictionary_rejects_v1_and_v2(self) -> None:
        old_dictionaries = (
            {"example": {"fields": []}},
            {"schema_version": "cleaning_field_dictionary_v2", "datasets": {}},
        )
        for dictionary in old_dictionaries:
            with self.subTest(dictionary=dictionary):
                with self.assertRaises(CleaningError) as caught:
                    detect_field_dictionary_schema(dictionary)
                self.assertEqual(caught.exception.code, "field_dictionary_schema_unsupported")

    def test_cleaning_manifest_rejects_storage_contract_v1(self) -> None:
        batch_id = str(uuid.uuid4())
        manifest = {
            "schema_version": "cleaning_batch_manifest_v3",
            "cleaning_batch_id": batch_id,
            "cleaning_package_id": batch_id,
            "cleaning_batch_status": "success",
            "source_logical_job_status": None,
            "qa_status": "passed",
            "shop": {"shop_id": "seller"},
            "selected_advertiser": None,
            "created_at_utc": "2026-08-19T00:00:00Z",
            "published_at_utc": "2026-08-19T00:00:01Z",
            "storage_contract": {
                "contract_id": "cleaning_storage_contract",
                "contract_version": "1.0.0",
                "relative_path": "_system/contracts/cleaning-storage-contract-v1.json",
                "sha256": "0" * 64,
            },
        }
        with self.assertRaises(CleaningError) as caught:
            validate_cleaning_batch_manifest_v3(manifest)
        self.assertEqual(caught.exception.code, "cleaning_storage_contract_mismatch")

    def test_v3_no_data_manifest_remains_valid(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_name:
            export_root = Path(temporary_name)
            batch_id = str(uuid.uuid4())
            batch_root = export_root / "batches" / batch_id
            batch_root.mkdir(parents=True)
            manifest_path = batch_root / "manifest.json"
            manifest = {
                "schema_version": "export_batch_manifest_v3",
                "storage_contract": {"contract_id": "export_storage_contract", "contract_version": "1.0.0"},
                "export_batch_id": batch_id,
                "batch_status": "success",
                "created_at_utc": "2026-08-19T00:00:00Z",
                "published_at_utc": "2026-08-19T00:00:01Z",
                "request": {"shop_alias": "shop", "start_date": "2026-08-18", "end_date": "2026-08-18"},
                "shop": {
                    "provider_id": "provider",
                    "shop_alias": "shop",
                    "seller_id": "seller",
                    "shop_region": "PH",
                    "business_timezone": "Asia/Manila",
                    "business_timezone_source": "official_seller_common_get_current_seller",
                    "business_timezone_observed_at": "2026-08-19T00:00:00Z",
                },
                "reports": [{"report_id": "product_ratings_review_list", "owner_type": "shop", "status": "success"}],
                "work_unit_attempts": [{
                    "work_unit_id": "ratings:2026-08-18",
                    "work_unit_attempt_id": str(uuid.uuid4()),
                    "coverage_unit_key": "ratings:2026-08-18",
                    "report_id": "product_ratings_review_list",
                    "execution_status": "no_data",
                    "artifact_bindings": [],
                }],
                "artifacts": [],
            }
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

            selected, source_context = validate_v3_manifest(
                manifest_path,
                manifest,
                ["product_ratings_review_list"],
            )

            self.assertEqual(selected, [])
            self.assertEqual(source_context["source_manifest"]["export_batch_id"], batch_id)
            self.assertEqual(source_context["authoritative_work_units"][0]["execution_status"], "no_data")

    def test_daily_product_rejects_old_official_xlsx_contract(self) -> None:
        with self.assertRaises(CleaningError) as caught:
            _validate_file_contract(
                "shop_product_daily_performance",
                {"generated_file": False, "file_kind": "official_export", "metric_date": "2026-08-18"},
                {"unit": {"metric_date": "2026-08-18", "campaign_id": None, "product_id": None}},
                {"start_date": "2026-08-18", "end_date": "2026-08-18"},
            )
        self.assertEqual(caught.exception.code, "source_file_kind_invalid")

    def test_business_view_rejects_old_daily_product_xlsx(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_name:
            root = Path(temporary_name)
            source = root / "old.xlsx"
            source.write_bytes(b"not read")
            with self.assertRaises(business_directory.BusinessDirectoryError) as caught:
                business_directory._merge_partitioned_raw(
                    [{"name": "shop_product_daily_performance", "source": source}],
                    root,
                )
            self.assertEqual(caught.exception.code, "business_directory_product_daily_source_unsupported")


if __name__ == "__main__":
    unittest.main()
