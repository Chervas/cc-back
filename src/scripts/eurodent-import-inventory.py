#!/usr/bin/env python3
"""Private, offline Eurodent intake and raw inventory; never writes Clinicaclick.

intake --zip FILE --output NEW_DIRECTORY --source-instance INSTANCE
inventory --intake DIRECTORY [--table datos/EDD00001.MDB:Paciente]

Requires external mdbtools only for inventory. MDB originals are never rewritten.
The SQLite is evidence/staging, not a clinical or economic migration.
"""

import argparse
import csv
import hashlib
import json
import os
import re
import resource
import shutil
import sqlite3
import stat
import subprocess
import sys
import tempfile
import unicodedata
import zipfile
from pathlib import Path, PurePosixPath


VERSION = "eurodent-offline-inventory/1"
MAX_ZIP_BYTES = 1024 ** 3
MAX_EXPANDED_BYTES = 2 * 1024 ** 3
MAX_FILE_BYTES = 600 * 1024 ** 2
MAX_TABLE_BYTES = 256 * 1024 ** 2
MAX_ENTRIES = 10000
BUSINESS_TABLES = frozenset("""Paciente Historial Presupuestos Presupuesto
Trabajo_Pendiente Primera_Visita Tratamiento FamTrat TraTipo Doctor Gabinete
Baremo FPago Entidad Comentarios Piezas Piezas_pri Periograma Protesico Proveedor
Agenda Age_Faltas CuestSalud CuestSaludPac ConsInfPac LOPDPac DocuExt HisInfAlta
Factura Factura2 Recibo Recibo2 Hist_Borr CodOperacion ReceNew Recetas
Radiografias Stv""".split())
BUSINESS_DATABASES = {"edd00001.mdb", "ed2000.mdb", "edi00001.mdb", "edimg.mdb"}
EXCLUDED_DATABASES = {"edc2000.mdb", "eds00001.mdb"}
DOC_SUFFIXES = {".txt", ".csv", ".json", ".reg"}


class InventoryError(Exception):
    """Only fixed error codes may reach the console; never source content."""


def fail(code):
    raise InventoryError(code)


def canonical_json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha(value):
    return hashlib.sha256(value).hexdigest()


def file_sha(path):
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def normalized_path(value):
    # Windows ZIP separators are path separators, not literal Linux filenames.
    if not isinstance(value, str) or not value or any(ord(c) < 32 for c in value):
        fail("ZIP_PATH_INVALID")
    value = unicodedata.normalize("NFC", value.replace("\\", "/"))
    if value.startswith("/") or re.match(r"^[A-Za-z]:", value):
        fail("ZIP_PATH_ABSOLUTE")
    parts = value.rstrip("/").split("/")
    if any(part in ("", ".", "..") or ":" in part for part in parts):
        fail("ZIP_PATH_TRAVERSAL_OR_INVALID")
    return "/".join(parts)


def regular_file(path, private=False):
    metadata = Path(path).lstat()
    if not stat.S_ISREG(metadata.st_mode):
        fail("REGULAR_FILE_REQUIRED")
    if private and (metadata.st_uid != os.getuid() or metadata.st_mode & 0o077):
        fail("PRIVATE_FILE_REQUIRED")
    return metadata


def private_directory(path):
    path = Path(path)
    metadata = path.lstat()
    if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.getuid() or metadata.st_mode & 0o077:
        fail("PRIVATE_DIRECTORY_REQUIRED")
    return path.resolve()


def private_write(path, content):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "wb") as destination:
        destination.write(content)
        destination.flush()
        os.fsync(destination.fileno())


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def selected_member(name):
    path = PurePosixPath(name)
    return (len(path.parts) == 1 and path.name.casefold() == "manifest.txt") or path.suffix.lower() == ".mdb" or (
        "_exportacion" in [part.casefold() for part in path.parts[:-1]]
        and path.suffix.lower() in DOC_SUFFIXES
    )


def inspect_zip(archive):
    entries = archive.infolist()
    if not entries or len(entries) > MAX_ENTRIES:
        fail("ZIP_ENTRY_LIMIT")
    seen, file_names, expanded, result = set(), set(), 0, []
    for entry in entries:
        original = getattr(entry, "orig_filename", entry.filename)
        if original != entry.filename:
            fail("ZIP_PATH_INVALID")
        name = normalized_path(entry.filename)
        key = name.casefold()
        if key in seen:
            fail("ZIP_PATH_COLLISION")
        seen.add(key)
        mode = entry.external_attr >> 16
        kind = stat.S_IFMT(mode)
        if kind not in (0, stat.S_IFREG, stat.S_IFDIR) or stat.S_ISLNK(mode):
            fail("ZIP_LINK_OR_SPECIAL_FILE")
        is_directory = entry.is_dir() or entry.filename.endswith("\\")
        if (kind == stat.S_IFDIR) != is_directory and kind:
            fail("ZIP_MEMBER_TYPE_CONFLICT")
        if entry.flag_bits & 1:
            fail("ZIP_ENCRYPTED_MEMBER")
        if not is_directory:
            file_names.add(key)
        expanded += entry.file_size
        if entry.file_size > MAX_FILE_BYTES or expanded > MAX_EXPANDED_BYTES:
            fail("ZIP_EXPANSION_LIMIT")
        if entry.file_size > max(1, entry.compress_size) * 1000:
            fail("ZIP_COMPRESSION_RATIO_LIMIT")
        result.append((entry, name, is_directory))
    for _, name, _ in result:
        parts = name.casefold().split("/")
        if any("/".join(parts[:index]) in file_names for index in range(1, len(parts))):
            fail("ZIP_FILE_DIRECTORY_COLLISION")
    return result


def intake(zip_path, output, source_instance, expected_sha256=None):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}", source_instance or ""):
        fail("EXPLICIT_SOURCE_INSTANCE_REQUIRED")
    source = Path(zip_path)
    metadata = regular_file(source)
    if metadata.st_size > MAX_ZIP_BYTES:
        fail("ZIP_SIZE_LIMIT")
    digest = file_sha(source)
    if expected_sha256 is not None and (
        not re.fullmatch(r"[0-9a-fA-F]{64}", expected_sha256) or digest != expected_sha256.lower()
    ):
        fail("ZIP_EXPECTED_SHA256_MISMATCH")
    output = Path(output).absolute()
    if output.exists() or output.is_symlink():
        fail("OUTPUT_ALREADY_EXISTS")
    # Validate every entry and CRC, including omitted executables, before extraction.
    with zipfile.ZipFile(source) as archive:
        entries = inspect_zip(archive)
        if not any(not directory and name.lower().endswith(".mdb") for _, name, directory in entries):
            fail("ZIP_HAS_NO_MDB")
        for entry, _, directory in entries:
            if directory:
                continue
            count = 0
            with archive.open(entry) as member:
                for block in iter(lambda: member.read(1024 * 1024), b""):
                    count += len(block)
                    if count > entry.file_size or count > MAX_FILE_BYTES:
                        fail("ZIP_MEMBER_SIZE_MISMATCH")
            if count != entry.file_size:
                fail("ZIP_MEMBER_SIZE_MISMATCH")
        if file_sha(source) != digest:
            fail("SOURCE_ZIP_CHANGED")
        # Exclusive output prevents replay from overwriting any earlier evidence.
        os.mkdir(output, 0o700)
        try:
            sources = output / "sources"
            sources.mkdir(mode=0o700)
            retained = []
            for entry, name, directory in entries:
                if directory or not selected_member(name):
                    continue
                destination = sources.joinpath(*PurePosixPath(name).parts)
                parent = sources
                for part in PurePosixPath(name).parts[:-1]:
                    parent = parent / part
                    parent.mkdir(mode=0o700, exist_ok=True)
                with archive.open(entry) as member:
                    descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                    with os.fdopen(descriptor, "wb") as target:
                        shutil.copyfileobj(member, target, 1024 * 1024)
                        target.flush()
                        os.fsync(target.fileno())
                        os.fchmod(target.fileno(), 0o400)
                retained.append({"path": name, "bytes": entry.file_size, "sha256": file_sha(destination),
                                 "kind": "mdb" if name.lower().endswith(".mdb") else "export_document"})
            if file_sha(source) != digest:
                fail("SOURCE_ZIP_CHANGED")
            body = {"version": VERSION, "source_system": "eurodent2000", "source_instance": source_instance,
                    "zip_sha256": digest, "zip_bytes": metadata.st_size, "zip_entry_count": len(entries),
                    "zip_crc_verified": True, "retained_files": retained,
                    "omitted_entry_count": len(entries) - len(retained), "operational_writes": False}
            body["manifest_sha256"] = sha(canonical_json(body).encode("utf-8"))
            private_write(output / "intake.json", (canonical_json(body) + "\n").encode("utf-8"))
            sync_directory(output)
            return {"ok": True, "mode": "intake", "zip_sha256": digest,
                    "retained_files": len(retained), "mdb_files": sum(row["kind"] == "mdb" for row in retained),
                    "operational_writes": False}
        except BaseException:
            # Only the fresh, exclusively-created directory belongs to this operation.
            shutil.rmtree(output)
            raise


def load_intake(directory):
    directory = private_directory(directory)
    manifest_path = directory / "intake.json"
    if regular_file(manifest_path, private=True).st_size > 2 * 1024 ** 2:
        fail("MANIFEST_TOO_LARGE")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    proof = manifest.pop("manifest_sha256", None)
    if manifest.get("version") != VERSION or proof != sha(canonical_json(manifest).encode("utf-8")):
        fail("INTAKE_MANIFEST_PROOF_INVALID")
    manifest["manifest_sha256"] = proof
    files, seen = [], set()
    for item in manifest["retained_files"]:
        name = normalized_path(item["path"])
        if name.casefold() in seen:
            fail("INTAKE_PATH_COLLISION")
        seen.add(name.casefold())
        path = private_directory(directory / "sources")
        for part in PurePosixPath(name).parts[:-1]:
            path = private_directory(path / part)
        path = path / PurePosixPath(name).name
        metadata = regular_file(path, private=True)
        if metadata.st_size != item["bytes"] or file_sha(path) != item["sha256"]:
            fail("IMMUTABLE_SOURCE_CHANGED")
        files.append((item, path))
    return directory, manifest, files


def table_spec(value):
    if ":" not in value:
        fail("TABLE_SPEC_INVALID")
    database, table = value.rsplit(":", 1)
    database = normalized_path(database)
    if table not in BUSINESS_TABLES:
        fail("TABLE_OUTSIDE_BUSINESS_ALLOWLIST")
    if PurePosixPath(database).name.lower() not in BUSINESS_DATABASES:
        fail("DATABASE_OUTSIDE_BUSINESS_ALLOWLIST")
    return database, table


def primary_key_spec(value):
    try:
        table_value, columns = value.rsplit(":", 1)
    except ValueError:
        fail("PRIMARY_KEY_SPEC_INVALID")
    database, table = table_spec(table_value)
    columns = columns.split(",")
    if not columns or any(not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_ ]{0,99}", c) for c in columns):
        fail("PRIMARY_KEY_SPEC_INVALID")
    if len(set(columns)) != len(columns):
        fail("PRIMARY_KEY_SPEC_INVALID")
    return (database, table), columns


class MdbTools:
    def __init__(self, directory=None, library_directory=None):
        self.directory = Path(directory).resolve() if directory else None
        self.environment = os.environ.copy()
        # Explicit interpretation of legacy Jet3 bytes, not inferred from clinic.
        self.environment.update({"MDB_JET3_CHARSET": "CP1252", "LC_ALL": "C.UTF-8"})
        self.provenance = {"executables": {}, "explicit_libraries": []}
        if library_directory:
            library = Path(library_directory).resolve()
            if not library.is_dir():
                fail("MDB_LIBRARY_DIRECTORY_MISSING")
            self.environment["LD_LIBRARY_PATH"] = str(library)
            self.provenance["explicit_libraries"] = [
                {"name": entry.name, "sha256": file_sha(entry), "bytes": entry.stat().st_size}
                for entry in sorted(library.glob("*.so*")) if entry.is_file()
            ]

    def run(self, tool, arguments, output, error_output):
        if tool not in ("mdb-tables", "mdb-schema", "mdb-export"):
            fail("MDB_TOOL_NOT_ALLOWED")
        executable = str(self.directory / tool) if self.directory else shutil.which(tool)
        if not executable or not Path(executable).is_file():
            fail("MDB_TOOL_MISSING")
        proof = {"sha256": file_sha(executable), "bytes": Path(executable).stat().st_size}
        if tool in self.provenance["executables"] and self.provenance["executables"][tool] != proof:
            fail("MDB_TOOL_CHANGED_DURING_READ")
        self.provenance["executables"][tool] = proof
        with os.fdopen(os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as stdout:
            with os.fdopen(os.open(error_output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as stderr:
                def limit_output():
                    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_TABLE_BYTES, MAX_TABLE_BYTES))
                process = subprocess.Popen([executable, *map(str, arguments)], stdout=stdout, stderr=stderr,
                                           stdin=subprocess.DEVNULL, env=self.environment, preexec_fn=limit_output)
                try:
                    code = process.wait(timeout=180)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                    fail("MDB_TOOL_TIMEOUT")
        if code != 0:
            fail("MDB_TOOL_FAILED")
        if file_sha(executable) != proof["sha256"]:
            fail("MDB_TOOL_CHANGED_DURING_READ")
        if Path(error_output).stat().st_size:
            # A zero exit code does not establish a complete export when MDB warns.
            fail("MDB_TOOL_REPORTED_DIAGNOSTIC")


SQLITE_SCHEMA = """
CREATE TABLE metadata (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
CREATE TABLE source_databases (
 id INTEGER PRIMARY KEY, source_path TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL);
CREATE TABLE source_tables (
 id INTEGER PRIMARY KEY, database_id INTEGER NOT NULL REFERENCES source_databases(id),
 table_name TEXT NOT NULL, columns_json TEXT, primary_key_columns_json TEXT,
 schema_sha256 TEXT, status TEXT NOT NULL, row_count INTEGER NOT NULL DEFAULT 0,
 duplicate_pk_groups INTEGER NOT NULL DEFAULT 0, duplicate_row_groups INTEGER NOT NULL DEFAULT 0,
 ambiguous_empty_cells INTEGER NOT NULL DEFAULT 0, error_code TEXT,
 UNIQUE(database_id, table_name));
CREATE TABLE source_rows (
 id INTEGER PRIMARY KEY, table_id INTEGER NOT NULL REFERENCES source_tables(id),
 source_ordinal INTEGER NOT NULL, raw_json TEXT NOT NULL, row_sha256 TEXT NOT NULL,
 source_pk_json TEXT, source_pk_sha256 TEXT, ambiguous_empty_columns_json TEXT NOT NULL,
 UNIQUE(table_id, source_ordinal));
CREATE INDEX source_rows_pk ON source_rows(table_id,source_pk_sha256);
CREATE INDEX source_rows_hash ON source_rows(table_id,row_sha256);
"""


def read_csv_to_sqlite(connection, table_id, csv_path, primary_columns):
    # mdbtools 0.7 emits the same CSV value for NULL and empty text. Preserve the
    # observed empty string and flag ambiguity instead of manufacturing SQL NULL.
    csv.field_size_limit(MAX_TABLE_BYTES)
    with open(csv_path, "r", encoding="utf-8", errors="strict", newline="") as source:
        rows = csv.reader(source, strict=True)
        try:
            columns = next(rows)
        except StopIteration:
            fail("MDB_EXPORT_HEADER_MISSING")
        if not columns or any(not column or "\x00" in column for column in columns) or len(set(columns)) != len(columns):
            fail("MDB_EXPORT_HEADER_INVALID")
        if any(column not in columns for column in primary_columns):
            fail("PRIMARY_KEY_COLUMN_MISSING")
        count, empty_cells = 0, 0
        for count, values in enumerate(rows, 1):
            if len(values) != len(columns):
                fail("MDB_EXPORT_ROW_WIDTH_INVALID")
            raw = dict(zip(columns, values))
            encoded = canonical_json(raw)
            ambiguous = [column for column, value in raw.items() if value == ""]
            empty_cells += len(ambiguous)
            # Missing or ambiguous key cells do not establish an entity identity.
            pk = {column: raw[column] for column in primary_columns} if primary_columns and all(raw[c] != "" for c in primary_columns) else None
            pk_json = canonical_json(pk) if pk else None
            connection.execute("INSERT INTO source_rows(table_id,source_ordinal,raw_json,row_sha256,source_pk_json,source_pk_sha256,ambiguous_empty_columns_json) VALUES(?,?,?,?,?,?,?)",
                               (table_id, count, encoded, sha(encoded.encode("utf-8")), pk_json,
                                sha(pk_json.encode("utf-8")) if pk_json else None, canonical_json(ambiguous)))
    duplicate_pk = connection.execute("SELECT COUNT(*) FROM (SELECT source_pk_sha256 FROM source_rows WHERE table_id=? AND source_pk_sha256 IS NOT NULL GROUP BY source_pk_sha256 HAVING COUNT(*)>1)", (table_id,)).fetchone()[0]
    duplicate_rows = connection.execute("SELECT COUNT(*) FROM (SELECT row_sha256 FROM source_rows WHERE table_id=? GROUP BY row_sha256 HAVING COUNT(*)>1)", (table_id,)).fetchone()[0]
    return columns, count, empty_cells, duplicate_pk, duplicate_rows


def inventory(directory, tables=None, primary_keys=None, tools_directory=None, library_directory=None):
    directory, manifest, files = load_intake(directory)
    requested = [table_spec(value) for value in (tables or [])]
    if len(set(requested)) != len(requested):
        fail("TABLE_SELECTION_REPEATED")
    primary = {}
    for value in primary_keys or []:
        identity, columns = primary_key_spec(value)
        if identity in primary:
            fail("PRIMARY_KEY_SELECTION_REPEATED")
        primary[identity] = columns
    if requested and any(identity not in requested for identity in primary):
        fail("PRIMARY_KEY_TABLE_NOT_SELECTED")
    available = {item["path"]: (item, path) for item, path in files if item["kind"] == "mdb"}
    if any(database not in available for database, _ in requested):
        fail("REQUESTED_DATABASE_NOT_IN_INTAKE")
    selection = {"tables": sorted(requested), "primary_keys": sorted((database, table, columns) for (database, table), columns in primary.items())}
    selection_sha = sha(canonical_json(selection).encode("utf-8"))
    final = directory / "inventory"
    if final.exists() or final.is_symlink():
        private_directory(final)
        previous_path = final / "inventory.json"
        regular_file(previous_path, private=True)
        previous = json.loads(previous_path.read_text(encoding="utf-8"))
        if previous.get("intake_sha256") != manifest["manifest_sha256"] or previous.get("selection_sha256") != selection_sha:
            fail("INVENTORY_ALREADY_EXISTS_FOR_DIFFERENT_SELECTION")
        for item in previous.get("artifacts", []):
            artifact = final / normalized_path(item["path"])
            regular_file(artifact, private=True)
            if file_sha(artifact) != item["sha256"]:
                fail("INVENTORY_ARTIFACT_CHANGED")
        return {"ok": previous["error_tables"] == 0, "mode": "inventory", "replayed": True,
                "tables": previous["tables"], "rows": previous["rows"], "error_tables": previous["error_tables"],
                "operational_writes": False}
    if shutil.disk_usage(directory).free < 100 * 1024 ** 2:
        fail("INSUFFICIENT_SCRATCH_DISK")
    temporary = Path(tempfile.mkdtemp(prefix=".inventory-", dir=directory))
    os.chmod(temporary, 0o700)
    tools = MdbTools(tools_directory, library_directory)
    database_path = temporary / "staging.sqlite"
    private_write(database_path, b"")
    connection = sqlite3.connect(database_path)
    failures = 0
    selected_count = 0
    total_rows = 0
    exclusions = []
    selected_identities = set()
    try:
        connection.execute("PRAGMA foreign_keys=ON")
        connection.executescript(SQLITE_SCHEMA)
        for key, value in {
            "version": VERSION, "source_system": "eurodent2000", "source_instance": manifest["source_instance"],
            "intake_sha256": manifest["manifest_sha256"], "selection": selection,
            "empty_null_semantics": "ambiguous_mdbtools_0_7_empty_string_retained",
            "primary_key_policy": "explicit_columns_only_no_inferred_ID", "charset": "CP1252",
            "date_export_format": "%Y-%m-%dT%H:%M:%S", "operational_writes": False,
        }.items():
            connection.execute("INSERT INTO metadata VALUES (?,?)", (key, canonical_json(value)))
        for database, (item, path) in sorted(available.items()):
            basename = PurePosixPath(database).name.lower()
            if basename not in BUSINESS_DATABASES:
                exclusions.append({"database": database, "reason": "configuration_access_or_unknown_database"})
                continue
            if requested and not any(db == database for db, _ in requested):
                continue
            # Default scope is the patient MDB only; other databases require selection.
            if not requested and basename != "edd00001.mdb":
                exclusions.append({"database": database, "reason": "not_in_default_patient_database_scope"})
                continue
            database_id = connection.execute("INSERT INTO source_databases(source_path,sha256) VALUES (?,?)", (database, item["sha256"])).lastrowid
            prefix = f"database-{database_id}"
            listing = temporary / f"{prefix}-tables.txt"
            tools.run("mdb-tables", ["-1", path], listing, temporary / f"{prefix}-tables.stderr")
            listed = listing.read_text(encoding="utf-8", errors="strict").splitlines()
            if len(set(listed)) != len(listed):
                fail("MDB_TABLE_NAMES_REPEATED")
            wanted = [table for db, table in requested if db == database] if requested else sorted(BUSINESS_TABLES.intersection(listed))
            if any(table not in listed for table in wanted):
                fail("REQUESTED_TABLE_NOT_IN_DATABASE")
            exclusions.extend({"database": database, "table": name, "reason": "table_outside_business_allowlist"} for name in listed if name not in BUSINESS_TABLES)
            for table in wanted:
                selected_identities.add((database, table))
                selected_count += 1
                table_id = connection.execute("INSERT INTO source_tables(database_id,table_name,status) VALUES(?,?,'pending')", (database_id, table)).lastrowid
                stem = f"table-{table_id}"
                schema_path = temporary / f"{stem}.schema.sql"
                export_path = temporary / f"{stem}.csv"
                pk_columns = primary.get((database, table), [])
                connection.execute("SAVEPOINT table_import")
                try:
                    tools.run("mdb-schema", ["-T", table, path, "mysql"], schema_path, temporary / f"{stem}-schema.stderr")
                    tools.run("mdb-export", ["-D", "%Y-%m-%dT%H:%M:%S", "-b", "octal", path, table], export_path, temporary / f"{stem}-export.stderr")
                    columns, rows, empty, duplicate_pk, duplicate_rows = read_csv_to_sqlite(connection, table_id, export_path, pk_columns)
                    connection.execute("UPDATE source_tables SET status='complete',columns_json=?,primary_key_columns_json=?,schema_sha256=?,row_count=?,ambiguous_empty_cells=?,duplicate_pk_groups=?,duplicate_row_groups=? WHERE id=?",
                                       (canonical_json(columns), canonical_json(pk_columns), file_sha(schema_path), rows, empty, duplicate_pk, duplicate_rows, table_id))
                    total_rows += rows
                    connection.execute("RELEASE table_import")
                except (InventoryError, UnicodeError, csv.Error, sqlite3.Error) as error:
                    connection.execute("ROLLBACK TO table_import")
                    connection.execute("RELEASE table_import")
                    code = str(error) if isinstance(error, InventoryError) else "TABLE_DECODE_OR_STORAGE_FAILED"
                    connection.execute("UPDATE source_tables SET status='error',error_code=? WHERE id=?", (code, table_id))
                    failures += 1
                finally:
                    if export_path.exists():
                        export_path.unlink()
            connection.commit()
        if not selected_count:
            fail("NO_BUSINESS_TABLE_SELECTED")
        if any(identity not in selected_identities for identity in primary):
            fail("PRIMARY_KEY_TABLE_NOT_SELECTED")
        connection.execute("INSERT INTO metadata VALUES (?,?)", ("mdbtools_provenance", canonical_json(tools.provenance)))
        connection.commit()
        connection.close()
        if file_sha(directory / "intake.json") != sha((canonical_json(manifest) + "\n").encode("utf-8")):
            fail("INTAKE_MANIFEST_CHANGED_DURING_INVENTORY")
        # Verify immutable MDBs again after external readers finish.
        for item, path in files:
            if file_sha(path) != item["sha256"]:
                fail("IMMUTABLE_SOURCE_CHANGED")
        artifacts = [{"path": path.name, "sha256": file_sha(path), "bytes": path.stat().st_size}
                     for path in sorted(temporary.iterdir()) if path.is_file()]
        summary = {"version": VERSION, "intake_sha256": manifest["manifest_sha256"],
                   "selection_sha256": selection_sha, "tables": selected_count, "rows": total_rows,
                   "error_tables": failures, "excluded": exclusions, "artifacts": artifacts,
                   "mdbtools_provenance": tools.provenance,
                   "primary_key_warning": "PK must be explicitly supplied after schema review; missing PK is not inferred from a column name",
                   "null_warning": "mdbtools 0.7 cannot distinguish NULL from empty text; ambiguous cells are retained and flagged",
                   "operational_writes": False}
        private_write(temporary / "inventory.json", (canonical_json(summary) + "\n").encode("utf-8"))
        sync_directory(temporary)
        # A concurrent inventory cannot overwrite an existing non-empty bundle.
        os.rename(temporary, final)
        sync_directory(directory)
        return {"ok": failures == 0, "mode": "inventory", "replayed": False,
                "tables": selected_count, "rows": total_rows, "error_tables": failures, "operational_writes": False}
    except BaseException:
        connection.close()
        shutil.rmtree(temporary)
        raise


def main(argv=None):
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    receive = commands.add_parser("intake", help="Validate ZIP and retain only MDB and export verification documents")
    receive.add_argument("--zip", required=True)
    receive.add_argument("--output", required=True)
    receive.add_argument("--source-instance", required=True)
    receive.add_argument("--expected-sha256")
    inspect = commands.add_parser("inventory", help="Create private raw SQLite staging using an explicit business allowlist")
    inspect.add_argument("--intake", required=True)
    inspect.add_argument("--table", action="append", default=[], metavar="DATABASE:TABLE")
    inspect.add_argument("--primary-key", action="append", default=[], metavar="DATABASE:TABLE:COLUMN[,COLUMN]")
    inspect.add_argument("--mdb-tools-dir")
    inspect.add_argument("--mdb-library-dir")
    args = parser.parse_args(argv)
    try:
        if args.command == "intake":
            result = intake(args.zip, args.output, args.source_instance, args.expected_sha256)
        else:
            result = inventory(args.intake, args.table, args.primary_key, args.mdb_tools_dir, args.mdb_library_dir)
        print(json.dumps(result, sort_keys=True))
        return 0 if result["ok"] else 2
    except InventoryError as error:
        print(json.dumps({"ok": False, "error": str(error)}))
        return 2
    except (OSError, ValueError, zipfile.BadZipFile, sqlite3.Error, UnicodeError):
        # Error messages from archives, readers and SQL may contain patient data.
        print(json.dumps({"ok": False, "error": "OFFLINE_INVENTORY_FAILED"}))
        return 2
    except Exception:
        # Unsupported ZIP compression and malformed private manifests must not
        # leak an exception traceback containing source values or filenames.
        print(json.dumps({"ok": False, "error": "OFFLINE_INVENTORY_FAILED"}))
        return 2


if __name__ == "__main__":
    sys.exit(main())
