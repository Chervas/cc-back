#!/usr/bin/python3
"""Bind one public profile ARN from sibling source; no AWS/PKI/service operation."""
import ast
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys

TEMPLATE = Path(__file__).resolve(strict=True).with_name('credential-process.py')
PROFILE = re.compile(r'^arn:aws:rolesanywhere:eu-west-3:137819318729:profile/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
TRUST_ANCHOR = 'arn:aws:rolesanywhere:eu-west-3:137819318729:trust-anchor/081b1d2c-78d1-4fd6-8dde-8a76add437a6'
ROLE = 'arn:aws:iam::137819318729:role/clinicaclick-sc-archive-staging-role'


def require(value):
    if not value:
        raise ValueError('sc_archive_public_binding_unavailable')


def render(profile, template):
    require(isinstance(profile, str) and PROFILE.fullmatch(profile) is not None)
    text = template.decode('utf-8')
    tree = ast.parse(text)
    assignments = [node for node in tree.body if isinstance(node, ast.Assign)
                   and any(isinstance(target, ast.Name) and target.id == 'PROFILE_ARN' for target in node.targets)]
    require(len(assignments) == 1 and len(assignments[0].targets) == 1)
    node = assignments[0].value
    previous = ast.literal_eval(node)
    require(previous is None or isinstance(previous, str) and PROFILE.fullmatch(previous) is not None)
    require(node.lineno == node.end_lineno)
    constants = {entry.targets[0].id: ast.literal_eval(entry.value)
                 for entry in tree.body if isinstance(entry, ast.Assign) and len(entry.targets) == 1
                 and isinstance(entry.targets[0], ast.Name) and entry.targets[0].id in ('ROLE', 'TRUST_ANCHOR_ARN')}
    require(constants == {'ROLE': ROLE, 'TRUST_ANCHOR_ARN': TRUST_ANCHOR})
    lines = text.splitlines(keepends=True)
    line = lines[node.lineno - 1]
    lines[node.lineno - 1] = line[:node.col_offset] + repr(profile) + line[node.end_col_offset:]
    wrapper = ''.join(lines).encode('utf-8')
    settings = {'schema': 'clinicaclick-sc-archive-roles-anywhere/1', 'trustAnchorArn': TRUST_ANCHOR,
                'profileArn': profile, 'roleArn': ROLE, 'region': 'eu-west-3', 'durationSeconds': 900}
    return wrapper, (json.dumps(settings, indent=2) + '\n').encode('utf-8')


def checked_template():
    require(TEMPLATE.parent.resolve(strict=True) == TEMPLATE.parent)
    parent = TEMPLATE.parent.lstat()
    require(stat.S_ISDIR(parent.st_mode) and parent.st_uid == 0 and not parent.st_mode & 0o022)
    fd = os.open(str(TEMPLATE), os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_uid == 0 and before.st_nlink == 1
                and not before.st_mode & 0o022 and 0 < before.st_size <= 65536)
        body = os.read(fd, 65537)
        after, named = os.fstat(fd), TEMPLATE.lstat()
        keys = ('st_dev', 'st_ino', 'st_uid', 'st_gid', 'st_mode', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns')
        require(len(body) == before.st_size and all(getattr(before, k) == getattr(after, k) == getattr(named, k) for k in keys))
        return body
    finally:
        os.close(fd)


def main(argv):
    if not argv:
        print('{"status":"INERT_PUBLIC_METADATA_BINDER","operations":0}')
        return 0
    require(os.getuid() == os.geteuid() == 0 and len(argv) == 4
            and argv[0] == '--render-profile' and argv[2] == '--output-dir')
    out = Path(argv[3])
    require(out.is_absolute() and str(out) == os.path.normpath(str(out))
            and out.parent.resolve(strict=True) == out.parent)
    parent = out.parent.lstat()
    require(stat.S_ISDIR(parent.st_mode) and parent.st_uid == 0 and stat.S_IMODE(parent.st_mode) == 0o700)
    wrapper, settings = render(argv[1], checked_template())
    out.mkdir(mode=0o700)
    refs = []
    for name, body in [('credential-process.bound.py', wrapper), ('roles-anywhere.json', settings)]:
        fd = os.open(str(out / name), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(body)
            stream.flush()
            os.fsync(stream.fileno())
        refs.append({'path': str(out / name), 'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest()})
    fd = os.open(str(out), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    print(json.dumps({'status': 'PUBLIC_ARN_BOUND_CANDIDATE_NOT_INSTALLED', 'files': refs,
                      'aws': 0, 'keysRead': 0, 'servicesChanged': 0}, separators=(',', ':')))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv[1:]))
    except Exception:
        sys.stderr.write('sc_archive_public_binding_unavailable\n')
        sys.exit(1)
