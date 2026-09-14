"""Run explicitly as root in an isolated QA host; uses numeric UIDs without creating OS users."""
import errno
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest


@unittest.skipUnless(os.geteuid() == 0, 'requires explicit privileged QA; no users or services are installed')
class SocketPermissions(unittest.TestCase):
    def test_each_service_connects_only_to_its_credential_socket(self):
        root = Path(tempfile.mkdtemp(prefix='cc-audit-unix-permissions-'))
        root.chmod(0o711); os.chown(root, 43011, 43011)
        sockets = []
        try:
            for kind, gid in [('writer', 43012), ('reader', 43013)]:
                s = socket.socket(socket.AF_UNIX); sockets.append(s)
                target = root / (kind + '.sock'); s.bind(str(target)); s.listen(4)
                os.chown(target, 43011, gid); target.chmod(0o660)
            code = 'import socket,sys; s=socket.socket(socket.AF_UNIX); sys.exit(s.connect_ex(sys.argv[1]))'
            for kind, uid in [('writer', 43012), ('reader', 43013)]:
                other = 'reader' if kind == 'writer' else 'writer'
                for target, expected in [(kind, 0), (other, errno.EACCES)]:
                    def drop_identity():
                        os.setgroups([]); os.setgid(uid); os.setuid(uid)
                    result = subprocess.run([sys.executable, '-c', code, str(root / (target + '.sock'))], preexec_fn=drop_identity, timeout=5, capture_output=True)
                    self.assertEqual(result.returncode, expected, (kind, target))
        finally:
            for s in sockets:
                s.close()
            shutil.rmtree(root)


if __name__ == '__main__':
    unittest.main()
