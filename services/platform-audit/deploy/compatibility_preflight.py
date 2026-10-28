#!/usr/bin/env python3
"""Read-only audit consumer inventory. No SQL, S3, credential/config reads or mutations."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

BASE = Path('/opt/clinicaclick-audit')
STATE = Path('/var/lib/clinicaclick-audit')
UNITS = {'reader': 'clinicaclick-audit-reader.service', 'writer': 'clinicaclick-audit-writer.service'}
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8', 'TZ': 'UTC'}
PROBE = r'''
const path = require('node:path');
const root = process.argv[1], c = require(path.join(root, 'src/event'));
const reader = require(path.join(root, 'src/reader-protocol'));
const id = '11111111-1111-4111-8111-111111111111', child = '22222222-2222-4222-8222-222222222222';
const digest = '0'.repeat(64), referenceVersions = [];
for (let v = 1; v <= 27; v++) {
  try { reader.refFor({ key: `app/platform/v${v}/2026-10-28/${id}-${digest}.json`, digest, versionId: 'fictitious-version' }, 'confirmed'); referenceVersions.push(v); } catch {}
}
const fixture = { version: 27, eventId: id, correlationId: id, requestCorrelationId: id,
  occurredAt: '2026-10-28T10:00:00.000Z', action: 'delegation.started', stage: 'completed', outcome: 'success', reason: 'handoff_exchanged',
  actor: { type: 'user', id: '1' }, effectiveActor: { type: 'user', id: '53' }, adminUserId: '1', sessionRef: child,
  parentSessionRef: '33333333-3333-4333-8333-333333333333', delegationId: child, expiresAt: '2026-10-28T10:15:00.000Z',
  runtimeNamespace: 'fictitious', scope: { type: 'platform', id: null }, http: null, socket: null, job: null, sourceEvent: null,
  capturePolicy: 'delegated-session-durable-v1' };
let delegationCodec = false;
try { const row = c.pack(fixture); delegationCodec = c.unpack(row).event.version === 27; } catch {}
process.stdout.write(JSON.stringify({ referenceVersions, delegationCodec, syntheticOnly: true, networkOperations: 0 }));
'''


def output(*args):
    return subprocess.check_output(list(args), env=ENV, text=True, timeout=20).strip()


def inventory(role):
    unit = UNITS[role]
    names = ['ActiveState', 'SubState', 'User', 'Group', 'WorkingDirectory', 'FragmentPath', 'DropInPaths', 'NRestarts']
    properties = output('systemctl', 'show', unit, '--no-pager', '--property=' + ','.join(names + ['ExecStart']))
    values = dict(line.split('=', 1) for line in properties.splitlines() if '=' in line)
    execution = values.pop('ExecStart', '')
    scripts = set(re.findall(r'(' + re.escape(str(BASE)) + r'/[A-Za-z0-9_.-]+/src/(?:reader-main|writer-https-main|writer-main)\.js)', execution))
    binary = re.search(r'(?:^|[ {;])path=([^ ;]+)', execution)
    if len(scripts) != 1 or not binary:
        raise ValueError('audit_executed_release_not_identified')
    entry = Path(scripts.pop()).resolve(strict=True)
    entry.relative_to(BASE)
    root = entry.parent.parent
    node = Path(binary.group(1)).resolve(strict=True)
    if node.name != 'node' or not os.access(node, os.X_OK):
        raise ValueError('audit_node_not_identified')
    node_version = output(str(node), '--version')
    if not re.fullmatch(r'v24\.\d+\.\d+', node_version):
        raise ValueError('audit_node_generation_invalid')
    paths = [root / 'package.json', root / 'package-lock.json', *sorted((root / 'src').rglob('*.js'))]
    sources = []
    for path in paths:
        resolved = path.resolve(strict=True)
        resolved.relative_to(root)
        body = path.read_bytes()
        sources.append({'path': str(path.relative_to(root)), 'sha256': hashlib.sha256(body).hexdigest(), 'size': len(body)})
    probe = json.loads(subprocess.check_output([str(node), '-e', PROBE, str(root)], cwd=root, env=ENV, text=True, timeout=20))
    state = STATE / role
    stat = state.stat()
    return {'role': role, 'unit': unit, 'unitMetadata': values, 'executedEntry': str(entry), 'executedRelease': str(root),
            'nodeBinary': str(node), 'nodeVersion': node_version, 'sources': sources, 'compatibility': probe,
            'stateDirectoryIdentity': {'path': str(state), 'device': stat.st_dev, 'inode': stat.st_ino,
                                       'uid': stat.st_uid, 'gid': stat.st_gid, 'mode': oct(stat.st_mode & 0o777)}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--role', choices=['reader', 'writer', 'both'], required=True)
    args = parser.parse_args()
    roles = ['reader', 'writer'] if args.role == 'both' else [args.role]
    try:
        data = {'version': 1, 'mode': 'read_only_compatibility_preflight', 'consumers': [inventory(role) for role in roles],
                'sqlOperations': 0, 'awsApiOperations': 0, 'configurationRead': False, 'mutations': 0}
        print(json.dumps(data, indent=2))
    except Exception:
        print(json.dumps({'version': 1, 'status': 'unavailable', 'error': 'audit_compatibility_preflight_unavailable'}))
        raise SystemExit(1)


if __name__ == '__main__':
    main()
