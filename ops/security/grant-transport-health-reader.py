#!/usr/bin/env python3
"""Grant isolated DEV read access to certificate health metadata, never keys.

The default ACL survives the maintenance tools' same-directory atomic writes.
Does not add DEV to the application user's group or change monitor/job flags.
"""
import json
import os
import pathlib
import pwd
import stat
import subprocess
import sys


def main():
    assert os.geteuid() == 0 and sys.argv[1:] == ['--apply']
    account = pwd.getpwnam('clinicaclick-dev')
    assert account.pw_uid > 0 and account.pw_gid > 0
    root = pathlib.Path('/var/lib/clinicaclick-transport-health')
    assert root.resolve() == root and root.is_dir()
    assert root.stat().st_uid == 0 and not root.stat().st_mode & 0o022
    files = [root / name for name in ['status.json', 'servers.json']]
    before = {}
    for file in files:
        info = file.lstat()
        assert stat.S_ISREG(info.st_mode) and info.st_uid == 0
        assert stat.S_IMODE(info.st_mode) == 0o640 and info.st_size <= 16384
        before[file.name] = file.read_bytes()
    uid = str(account.pw_uid)
    # Traverse only; DEV cannot list the directory or write any metadata.
    subprocess.run(['setfacl', '-m', 'u:' + uid + ':--x', str(root)], check=True)
    subprocess.run(['setfacl', '-m',
                    'd:u::rw-,d:u:' + uid + ':r--,d:g::r--,d:m::r--,d:o::---',
                    str(root)], check=True)
    for file in files:
        subprocess.run(['setfacl', '-m', 'u:' + uid + ':r--', str(file)], check=True)
        assert file.read_bytes() == before[file.name]
        assert stat.S_IMODE(file.stat().st_mode) == 0o640
    print(json.dumps({'reader': account.pw_name, 'uid': account.pw_uid,
                      'metadataFiles': [p.name for p in files],
                      'defaultAclInstalled': True, 'contentChanged': False,
                      'groupsOrRuntimeFlagsChanged': False}))


if __name__ == '__main__':
    main()
