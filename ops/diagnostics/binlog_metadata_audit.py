#!/usr/bin/env python3
"""Read binlog v4 metadata only. Never decode/read row images or SQL text."""
import collections
import datetime as dt
import json
import os
from pathlib import Path
import pwd
import re
import struct
import sys
import tempfile
import time

ROOT = Path('/var/lib/mysql')
EVIDENCE = Path('/home/ubuntu/qa-evidence/architecture-diagnostic-20261018-c3CWBj')
HEADER = struct.Struct('<IBIIIH')
ROW_TYPES = {20: 'insert', 21: 'update', 22: 'delete', 23: 'insert',
             24: 'update', 25: 'delete', 30: 'insert', 31: 'update',
             32: 'delete', 39: 'partial_update'}

def utc(ts):
    return dt.datetime.fromtimestamp(ts, dt.timezone.utc).isoformat() if ts else None

def ident(value):
    return value.decode('ascii') if re.fullmatch(rb'[A-Za-z0-9_$-]{1,64}', value) else 'identifier_redacted'

def table_map(body):
    if len(body) < 10:
        raise ValueError('invalid_table_map')
    table_id = int.from_bytes(body[:6], 'little')
    n = body[8]
    p = 9 + n
    if n > 64 or p + 2 > len(body) or body[p] != 0:
        raise ValueError('invalid_schema')
    m = body[p + 1]
    q = p + 2 + m
    if m > 64 or q >= len(body) or body[q] != 0:
        raise ValueError('invalid_table')
    return table_id, ident(body[9:p]), ident(body[p + 2:q])

def scan(fd, name, size, deadline, max_events=180000):
    if os.pread(fd, 4, 0) != b'\xfebin':
        raise ValueError('invalid_magic')
    pos, events, first, last = 4, 0, None, None
    types, tables, schemas, hours = collections.Counter(), {}, {}, {}
    maps = {}
    read_bytes, unmapped_rows = 4, 0
    stop = None
    while pos + HEADER.size <= size:
        if events >= max_events or time.monotonic() >= deadline:
            stop = 'bounded_budget'
            break
        h = os.pread(fd, HEADER.size, pos)
        read_bytes += len(h)
        if len(h) != HEADER.size:
            stop = 'short_header'
            break
        ts, kind, server_id, length, next_pos, flags = HEADER.unpack(h)
        if length < HEADER.size or pos + length > size or (next_pos and next_pos != pos + length):
            stop = 'invalid_or_incomplete_event'
            break
        first = ts if first is None else min(first, ts)
        last = ts if last is None else max(last, ts)
        types[kind] += length
        payload = pos + HEADER.size
        if kind == 15:
            body = os.pread(fd, min(100, length - HEADER.size), payload)
            read_bytes += len(body)
            if len(body) < 76 or int.from_bytes(body[:2], 'little') != 4 or body[56] != 19 or body[75] != 8:
                raise ValueError('unsupported_event_format')
        elif kind == 19:
            body = os.pread(fd, min(140, length - HEADER.size), payload)
            read_bytes += len(body)
            tid, schema, table = table_map(body)
            maps[tid] = (schema, table)
        elif kind in ROW_TYPES:
            # Only the six-byte table ID is read. Row values are skipped using event length.
            tid_bytes = os.pread(fd, 6, payload)
            read_bytes += len(tid_bytes)
            target = maps.get(int.from_bytes(tid_bytes, 'little'))
            if target is None:
                unmapped_rows += length
            else:
                schema, table = target
                key = schema + '.' + table
                bucket = tables.setdefault(key, collections.Counter())
                bucket['row_event_bytes'] += length
                bucket[ROW_TYPES[kind] + '_events'] += 1
                schemas[schema] = schemas.get(schema, 0) + length
                hour = (ts // 3600) * 3600
                hkey = str(hour) + '|' + key
                hours[hkey] = hours.get(hkey, 0) + length
        elif kind == 40:
            stop = 'compressed_transaction_unsupported'
            break
        elif kind in (2, 16):
            # SQL Query bodies are deliberately never read, including BEGIN/DDL/credentials.
            maps.clear()
        pos += length
        events += 1
    return {'file': name, 'snapshot_bytes': size, 'scanned_end_position': pos,
            'scanned_event_bytes': pos - 4, 'complete': pos == size,
            'stop_reason': stop, 'events': events, 'first_event_utc': utc(first),
            'last_event_utc': utc(last), 'requested_metadata_bytes': read_bytes,
            'row_event_bytes_by_schema': schemas, 'row_event_bytes_by_table': tables,
            'row_event_bytes_by_utc_hour_and_table': hours,
            'event_bytes_by_type_code': dict(types), 'unmapped_row_event_bytes': unmapped_rows}

def self_test():
    def event(kind, body, pos, ts=1700000000):
        length = HEADER.size + len(body)
        return HEADER.pack(ts, kind, 1, length, pos + length, 0) + body
    fde = bytearray(100)
    fde[:2] = (4).to_bytes(2, 'little')
    fde[56], fde[75] = 19, 8
    blob = b'\xfebin'
    blob += event(15, bytes(fde), len(blob))
    blob += event(2, b'SECRET_SQL_MUST_NOT_BE_READ', len(blob))
    tid = (17).to_bytes(6, 'little')
    mapping = tid + b'\0\0' + b'\x04test\0\x07QaTable\0'
    blob += event(19, mapping, len(blob))
    row_start = len(blob)
    blob += event(31, tid + b'SECRET_ROW_MUST_NOT_BE_READ' * 8, len(blob))
    original = os.pread
    sql_begin = 4 + HEADER.size + len(fde) + HEADER.size
    sql_end = sql_begin + len(b'SECRET_SQL_MUST_NOT_BE_READ')
    def checked(fd, n, offset):
        assert not (offset < sql_end and offset + n > sql_begin), 'SQL payload read'
        assert not (offset < len(blob) and offset + n > row_start + HEADER.size + 6), 'row image read'
        return original(fd, n, offset)
    with tempfile.TemporaryFile() as f:
        f.write(blob)
        f.flush()
        os.pread = checked
        try:
            r = scan(f.fileno(), 'synthetic', len(blob), time.monotonic() + 2)
        finally:
            os.pread = original
    assert r['complete'] and r['events'] == 4
    assert r['row_event_bytes_by_table']['test.QaTable']['update_events'] == 1
    assert r['row_event_bytes_by_schema']['test'] == len(blob) - row_start
    return {'synthetic_format_and_no_payload_read': 'passed'}

def run():
    test = self_test()
    files = []
    for entry in sorted(ROOT.iterdir()):
        if re.fullmatch(r'binlog\.\d+', entry.name) and entry.is_file() and not entry.is_symlink():
            fd = os.open(entry, os.O_RDONLY | os.O_NOFOLLOW)
            try:
                st = os.fstat(fd)
                h = os.pread(fd, HEADER.size, 4)
                created = HEADER.unpack(h)[0]
                files.append({'name': entry.name, 'bytes': st.st_size,
                              'first_event_ts': created, 'first_event_utc': utc(created),
                              'mtime_ts': st.st_mtime, 'mtime_utc': utc(st.st_mtime)})
            finally:
                os.close(fd)
    # Fixed historical coverage plus recent daily/backfill intervals. Exclude active last file.
    closed = files[:-1]
    choices = {round(i * (len(closed) - 1) / 7) for i in range(8)}
    for label in ['2026-09-20T02:30:00+00:00', '2026-10-11T02:30:00+00:00',
                  '2026-10-18T02:15:00+00:00', '2026-10-18T02:30:00+00:00',
                  '2026-10-18T07:20:00+00:00']:
        target = dt.datetime.fromisoformat(label).timestamp()
        idx = min(range(len(closed)), key=lambda i: abs(closed[i]['mtime_ts'] - target))
        choices.update(i for i in [idx - 1, idx, idx + 1] if 0 <= i < len(closed))
    deadline = time.monotonic() + 35
    scans = []
    # Start with the recent backfill, then distribute historical checks across the interval.
    selected = sorted(choices, reverse=True)
    for idx in selected:
        if time.monotonic() >= deadline:
            break
        meta = closed[idx]
        try:
            fd = os.open(ROOT / meta['name'], os.O_RDONLY | os.O_NOFOLLOW)
        except FileNotFoundError:
            continue
        try:
            scans.append(scan(fd, meta['name'], meta['bytes'], deadline))
        finally:
            os.close(fd)
    report = {'observed_at_utc': dt.datetime.now(dt.timezone.utc).isoformat(),
              'mode': 'metadata_only_bounded_directed_sample', 'self_test': test,
              'no_row_images_or_query_text_read': True, 'binlog_checksum_validation': False,
              'inventory': files, 'inventory_total_bytes': sum(x['bytes'] for x in files),
              'active_file_excluded': files[-1]['name'], 'selected_files': [closed[i]['name'] for i in selected],
              'samples': scans, 'sampled_event_bytes': sum(x['scanned_event_bytes'] for x in scans),
              'limit_seconds': 35,
              'limitations': ['Directed sample is not a complete monthly attribution.',
                             'Row event byte counts are not changed-row counts, CPU usage or AWS cost.',
                             'Schema/table identifies affected storage, not the human/process that caused it.',
                             'Query, transaction and other non-row events remain unattributed.']}
    path = EVIDENCE / ('binlog-metadata-sample-' + dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '.json')
    with path.open('x', encoding='utf8') as f:
        os.chmod(path, 0o600)
        json.dump(report, f, indent=2)
        f.write('\n')
    user = pwd.getpwnam('ubuntu')
    os.chown(path, user.pw_uid, user.pw_gid)
    tables, schemas = collections.Counter(), collections.Counter()
    for sample in scans:
        schemas.update(sample['row_event_bytes_by_schema'])
        tables.update({k: v['row_event_bytes'] for k, v in sample['row_event_bytes_by_table'].items()})
    print(json.dumps({'evidence': str(path), 'inventory_files': len(files),
                      'inventory_bytes': report['inventory_total_bytes'], 'sampled_files': len(scans),
                      'complete_sampled_files': sum(x['complete'] for x in scans),
                      'sampled_event_bytes': report['sampled_event_bytes'],
                      'row_event_bytes_by_schema': schemas, 'top_tables': tables.most_common(15)}))

if __name__ == '__main__':
    try:
        if len(sys.argv) == 2 and sys.argv[1] == '--self-test':
            print(json.dumps(self_test()))
        elif len(sys.argv) == 2 and sys.argv[1] == '--read-metadata':
            run()
        else:
            raise ValueError('invalid_arguments')
    except Exception as exc:
        print(json.dumps({'status': 'metadata_audit_failed', 'error_type': type(exc).__name__}))
        sys.exit(1)
