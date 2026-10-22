#!/usr/bin/env python3
"""Offline synthetic tests. No real archives, application models or SQL server."""

import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sqlite3
import stat
import tempfile
import unittest
from unittest.mock import patch
import zipfile


SCRIPT = Path(__file__).resolve().parents[1] / "eurodent-import-inventory.py"
SPEC = importlib.util.spec_from_file_location("eurodent_inventory", SCRIPT)
inventory = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(inventory)


class EurodentInventoryTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name)
        self.archive = self.directory / "source.zip"
        self.output = self.directory / "intake"

    def tearDown(self):
        self.temporary.cleanup()

    def make_archive(self, entries=None):
        with zipfile.ZipFile(self.archive, "w", zipfile.ZIP_STORED) as archive:
            for name, data in entries or [
                ("datos\\EDD00001.MDB", b"original-mdb-bytes"),
                ("datos\\EDC2000.mdb", b"configuration-do-not-read"),
                ("datos\\EDS00001.MDB", b"access-logs-do-not-read"),
                ("_exportacion\\LEEME.txt", b"copy verification"),
                ("_exportacion\\archivos-sha256.csv", b"path,sha256\n"),
                ("program.exe", b"must never execute or extract"),
                ("Recetas\\unrelated.txt", b"not an export verification document"),
            ]:
                archive.writestr(name, data)

    def receive(self):
        return inventory.intake(self.archive, self.output, "synthetic-clinic-1")

    def fake_tools(self, csv_text=None, listed="Paciente\nHistorial\nCfgAccesos\n"):
        text = csv_text or '"ID","Texto","Opcional"\n"7","Primera línea\nsegunda línea",""\n"7","Segundo registro",""\n'

        def run(_self, tool, arguments, output, error_output):
            if tool == "mdb-tables":
                self.assertTrue(str(arguments[-1]).endswith("EDD00001.MDB"))
                body = listed
            elif tool == "mdb-schema":
                self.assertEqual(arguments[0], "-T")
                self.assertIn(arguments[1], inventory.BUSINESS_TABLES)
                body = "CREATE TABLE `Paciente` (`ID` integer, `Texto` text, `Opcional` text);\n"
            elif tool == "mdb-export":
                self.assertEqual(arguments[:4], ["-D", "%Y-%m-%dT%H:%M:%S", "-b", "octal"])
                body = text
            else:
                self.fail("Unexpected external tool")
            inventory.private_write(output, body.encode("utf-8"))
            inventory.private_write(error_output, b"")

        return run

    def test_windows_paths_selective_intake_and_permissions(self):
        self.make_archive()
        result = self.receive()
        self.assertEqual(result["mdb_files"], 3)
        self.assertEqual(result["retained_files"], 5)
        self.assertEqual((self.output / "sources/datos/EDD00001.MDB").read_bytes(), b"original-mdb-bytes")
        self.assertFalse((self.output / "sources/program.exe").exists())
        self.assertFalse((self.output / "sources/Recetas/unrelated.txt").exists())
        for path in [self.output, *self.output.rglob("*")]:
            expected = 0o700 if path.is_dir() else 0o400 if "sources" in path.parts else 0o600
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), expected)
        manifest = json.loads((self.output / "intake.json").read_text())
        self.assertTrue(manifest["zip_crc_verified"])
        self.assertEqual(manifest["source_instance"], "synthetic-clinic-1")

    def test_root_manifest_is_retained_for_export_caveats(self):
        self.make_archive([("datos\\EDD00001.MDB", b"db"), ("MANIFEST.txt", b"The original application was open during copy")])
        self.receive()
        self.assertEqual((self.output / "sources/MANIFEST.txt").read_bytes(), b"The original application was open during copy")

    def test_expected_hash_mismatch_creates_nothing(self):
        self.make_archive()
        with self.assertRaisesRegex(inventory.InventoryError, "ZIP_EXPECTED_SHA256_MISMATCH"):
            inventory.intake(self.archive, self.output, "synthetic-clinic-1", "0" * 64)
        self.assertFalse(self.output.exists())

    def test_crc_failure_even_in_unselected_file_creates_nothing(self):
        self.make_archive([("datos/EDD00001.MDB", b"original-mdb"), ("program.exe", b"bad-crc-payload")])
        content = self.archive.read_bytes()
        self.archive.write_bytes(content.replace(b"bad-crc-payload", b"bad-crc-payloae", 1))
        with self.assertRaises(zipfile.BadZipFile):
            self.receive()
        self.assertFalse(self.output.exists())

    def test_zip_traversal_absolute_and_drive_paths_are_rejected(self):
        for name in ("..\\outside.mdb", "a/../outside.mdb", "/outside.mdb", "C:\\datos\\x.mdb", "a//b.mdb"):
            with self.subTest(name=name):
                self.make_archive([(name, b"data")])
                with self.assertRaises(inventory.InventoryError):
                    self.receive()
                self.assertFalse(self.output.exists())

    def test_windows_case_or_unicode_collisions_are_rejected(self):
        for left, right in (("datos\\Paciente.mdb", "DATOS/paciente.MDB"), ("datos/café.mdb", "datos/cafe\u0301.mdb")):
            with self.subTest(left=left):
                self.make_archive([(left, b"one"), (right, b"two")])
                with self.assertRaisesRegex(inventory.InventoryError, "ZIP_PATH_COLLISION"):
                    self.receive()
                self.assertFalse(self.output.exists())

    def test_symlink_and_file_parent_collisions_are_rejected(self):
        link = zipfile.ZipInfo("datos/link.mdb")
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        self.make_archive([(link, b"/etc/passwd")])
        with self.assertRaisesRegex(inventory.InventoryError, "ZIP_LINK_OR_SPECIAL_FILE"):
            self.receive()
        self.make_archive([("datos", b"file"), ("datos/EDD00001.MDB", b"db")])
        with self.assertRaisesRegex(inventory.InventoryError, "ZIP_FILE_DIRECTORY_COLLISION"):
            self.receive()

    def test_size_preflight_limit_applies_before_extract(self):
        self.make_archive()
        with patch.object(inventory, "MAX_EXPANDED_BYTES", 10):
            with self.assertRaisesRegex(inventory.InventoryError, "ZIP_EXPANSION_LIMIT"):
                self.receive()
        self.assertFalse(self.output.exists())

    def test_intake_repeat_does_not_overwrite_originals(self):
        self.make_archive()
        self.receive()
        before = inventory.file_sha(self.output / "intake.json")
        with self.assertRaisesRegex(inventory.InventoryError, "OUTPUT_ALREADY_EXISTS"):
            self.receive()
        self.assertEqual(inventory.file_sha(self.output / "intake.json"), before)

    def test_raw_sqlite_preserves_multiline_duplicate_keys_and_empty_ambiguity(self):
        self.make_archive()
        self.receive()
        with patch.object(inventory.MdbTools, "run", self.fake_tools()):
            result = inventory.inventory(self.output, ["datos/EDD00001.MDB:Paciente"], ["datos/EDD00001.MDB:Paciente:ID"])
        self.assertTrue(result["ok"])
        self.assertEqual(result["rows"], 2)
        with sqlite3.connect(self.output / "inventory/staging.sqlite") as database:
            status, rows, pk_duplicates, empty = database.execute("SELECT status,row_count,duplicate_pk_groups,ambiguous_empty_cells FROM source_tables").fetchone()
            self.assertEqual((status, rows, pk_duplicates, empty), ("complete", 2, 1, 2))
            raw, key, ambiguous = database.execute("SELECT raw_json,source_pk_json,ambiguous_empty_columns_json FROM source_rows ORDER BY source_ordinal LIMIT 1").fetchone()
            self.assertEqual(json.loads(raw), {"ID": "7", "Texto": "Primera línea\nsegunda línea", "Opcional": ""})
            self.assertEqual(json.loads(key), {"ID": "7"})
            self.assertEqual(json.loads(ambiguous), ["Opcional"])
            self.assertEqual(database.execute("SELECT COUNT(*) FROM source_rows").fetchone()[0], 2)
        for path in (self.output / "inventory").rglob("*"):
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_default_inventory_never_opens_configuration_or_access_databases(self):
        self.make_archive()
        self.receive()
        with patch.object(inventory.MdbTools, "run", self.fake_tools(listed="Paciente\nCfgAccesos\n")):
            result = inventory.inventory(self.output)
        self.assertEqual(result["tables"], 1)
        summary = json.loads((self.output / "inventory/inventory.json").read_text())
        self.assertEqual(sum(row["reason"] == "configuration_access_or_unknown_database" for row in summary["excluded"]), 2)
        with sqlite3.connect(self.output / "inventory/staging.sqlite") as database:
            self.assertEqual(database.execute("SELECT source_pk_json FROM source_rows LIMIT 1").fetchone()[0], None)

    def test_configuration_unknown_table_and_database_requests_fail(self):
        self.make_archive()
        self.receive()
        for selection in ("datos/EDD00001.MDB:CfgAccesos", "datos/EDC2000.mdb:Paciente", "datos/unknown.mdb:Paciente"):
            with self.subTest(selection=selection):
                with self.assertRaises(inventory.InventoryError):
                    inventory.inventory(self.output, [selection])
        self.assertFalse((self.output / "inventory").exists())

    def test_unselected_primary_key_request_is_not_silently_ignored(self):
        self.make_archive()
        self.receive()
        with self.assertRaisesRegex(inventory.InventoryError, "PRIMARY_KEY_TABLE_NOT_SELECTED"):
            inventory.inventory(self.output, ["datos/EDD00001.MDB:Paciente"], ["datos/EDD00001.MDB:Historial:ID"])
        with patch.object(inventory.MdbTools, "run", self.fake_tools(listed="Paciente\n")):
            with self.assertRaisesRegex(inventory.InventoryError, "PRIMARY_KEY_TABLE_NOT_SELECTED"):
                inventory.inventory(self.output, primary_keys=["datos/EDD00001.MDB:Historial:ID"])
        self.assertFalse((self.output / "inventory").exists())

    def test_inventory_replay_verifies_artifacts_without_export_or_duplicate_rows(self):
        self.make_archive()
        self.receive()
        with patch.object(inventory.MdbTools, "run", self.fake_tools()):
            inventory.inventory(self.output, ["datos/EDD00001.MDB:Paciente"])
        before = inventory.file_sha(self.output / "inventory/staging.sqlite")
        with patch.object(inventory.MdbTools, "run", side_effect=AssertionError("replay must not export")):
            result = inventory.inventory(self.output, ["datos/EDD00001.MDB:Paciente"])
        self.assertTrue(result["replayed"])
        self.assertEqual(result["rows"], 2)
        self.assertEqual(inventory.file_sha(self.output / "inventory/staging.sqlite"), before)
        with self.assertRaisesRegex(inventory.InventoryError, "DIFFERENT_SELECTION"):
            inventory.inventory(self.output, ["datos/EDD00001.MDB:Historial"])

    def test_modified_original_or_inventory_is_detected(self):
        self.make_archive()
        self.receive()
        original = self.output / "sources/datos/EDD00001.MDB"
        os.chmod(original, 0o600)
        original.write_bytes(b"tampered")
        with self.assertRaisesRegex(inventory.InventoryError, "IMMUTABLE_SOURCE_CHANGED"):
            inventory.inventory(self.output)

    def test_bad_row_rolls_back_table_and_retains_error_without_partial_records(self):
        self.make_archive()
        self.receive()
        text = '"ID","Texto"\n"7","valid"\n"8","bad","extra"\n'
        with patch.object(inventory.MdbTools, "run", self.fake_tools(csv_text=text)):
            result = inventory.inventory(self.output, ["datos/EDD00001.MDB:Paciente"])
        self.assertFalse(result["ok"])
        self.assertEqual(result["rows"], 0)
        with sqlite3.connect(self.output / "inventory/staging.sqlite") as database:
            self.assertEqual(database.execute("SELECT COUNT(*) FROM source_rows").fetchone()[0], 0)
            self.assertEqual(database.execute("SELECT error_code FROM source_tables").fetchone()[0], "MDB_EXPORT_ROW_WIDTH_INVALID")

    def test_cli_never_prints_source_exception_content(self):
        self.make_archive()
        self.receive()
        console = io.StringIO()
        with patch.object(inventory, "inventory", side_effect=ValueError("SENSITIVE_PATIENT_DETAILS")):
            with contextlib.redirect_stdout(console):
                code = inventory.main(["inventory", "--intake", str(self.output)])
        self.assertEqual(code, 2)
        self.assertNotIn("SENSITIVE", console.getvalue())
        self.assertEqual(json.loads(console.getvalue())["error"], "OFFLINE_INVENTORY_FAILED")


if __name__ == "__main__":
    unittest.main()
