#!/usr/bin/env python3
"""Extract only the reviewed contacts/appointments CSVs into private storage.

Archive paths are never used as output paths. No medical content is printed.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import zipfile


def extract(source, output):
    root = Path('/home/ubuntu/secure-imports').resolve(strict=True)
    destination = Path(output).resolve(strict=True)
    if destination == root or root not in destination.parents:
        raise ValueError('PRIVATE_SUBDIRECTORY_REQUIRED')
    for directory in [root, destination]:
        info = directory.stat()
        if info.st_mode & 0o077 or info.st_uid != os.getuid():
            raise ValueError('PRIVATE_DIRECTORY_PERMISSIONS_INVALID')
    if Path(source).stat().st_size > 64 * 1024 * 1024:
        raise ValueError('ARCHIVE_TOO_LARGE')
    archive_bytes = Path(source).read_bytes()
    if len(archive_bytes) > 64 * 1024 * 1024:
        raise ValueError('ARCHIVE_TOO_LARGE')
    manifest = {'version': 'cliniccloud-delta/1', 'archive_sha256': hashlib.sha256(archive_bytes).hexdigest(), 'files': []}
    with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
        selected = []
        for info in archive.infolist():
            if info.filename.startswith('__MACOSX/'):
                continue
            name = Path(info.filename).name
            if re.fullmatch(r'BACKUP_(?:CONTACTOS_\d{4}-\d{2}-\d{2}|CITAS_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2})\.csv', name):
                if info.file_size > 64 * 1024 * 1024 or info.flag_bits & 1:
                    raise ValueError('CSV_SIZE_OR_ENCRYPTION_INVALID')
                selected.append((info, name))
        if len(selected) != 2 or len({name.split('_')[1] for _, name in selected}) != 2:
            raise ValueError('EXACTLY_ONE_CONTACTS_AND_APPOINTMENTS_FILE_REQUIRED')
        for info, name in selected:
            contents = archive.read(info)
            contents.decode('utf-8-sig', errors='strict')
            target = destination / name
            fd = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'wb') as stream:
                stream.write(contents)
                stream.flush()
                os.fsync(stream.fileno())
            manifest['files'].append({'name': name, 'bytes': len(contents), 'sha256': hashlib.sha256(contents).hexdigest()})
    fd = os.open(destination / 'source-manifest.json', os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(manifest, stream, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    fd = os.open(destination, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--archive', required=True)
    parser.add_argument('--private-output-directory', required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(extract(args.archive, args.private_output_directory)))
    except Exception:
        raise SystemExit('CLINICCLOUD_DELTA_EXTRACTION_FAILED') from None
