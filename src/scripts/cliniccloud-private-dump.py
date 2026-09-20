#!/usr/bin/env python3
"""Linux operator helper: put MySQL client options in RAM, never a disk file."""
import os
import sys

def main():
    options = bytearray()
    while True:
        chunk = os.read(3, 4096)
        if not chunk:
            break
        options.extend(chunk)
        if len(options) > 65536:
            raise ValueError('CLIENT_CONFIG_TOO_LARGE')
    os.close(3)
    descriptor = os.memfd_create('cc-private-mysql-client', flags=0)
    os.fchmod(descriptor, 0o600)
    os.write(descriptor, options)
    os.lseek(descriptor, 0, os.SEEK_SET)
    os.set_inheritable(descriptor, True)
    os.execv('/usr/bin/mysqldump', ['mysqldump', f'--defaults-extra-file=/proc/self/fd/{descriptor}', *sys.argv[1:]])

if __name__ == '__main__':
    main()
