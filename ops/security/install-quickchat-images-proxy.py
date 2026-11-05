#!/usr/bin/env python3
"""Publish only the reviewed CRM streaming location; preserve all other routes."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

p = argparse.ArgumentParser()
p.add_argument('--source', required=True)
p.add_argument('--sha', required=True)
p.add_argument('--apply', action='store_true')
args = p.parse_args()
repo = Path(args.source).resolve()
sha = subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True).strip()
if sha != args.sha or subprocess.check_output(['git', '-C', str(repo), 'status', '--porcelain'], text=True).strip():
    raise SystemExit('Source must be the exact reviewed clean commit')
site = Path('/etc/nginx/sites-available/crm.clinicaclick.com')
snippet = Path('/etc/nginx/snippets/clinicaclick-quickchat-images.conf')
line = '    include /etc/nginx/snippets/clinicaclick-quickchat-images.conf;\n'
before = site.read_text()
if before.count('    location /api/ {') != 1:
    raise SystemExit('Unexpected CRM proxy layout')
after = before if line in before else before.replace('    location /api/ {', line + '\n    location /api/ {', 1)
body = (repo / 'ops/security/quickchat-images.nginx.conf').read_bytes()
if not args.apply:
    print(json.dumps({'plan': 'CRM image streaming only', 'source_sha': sha,
                      'site_sha256': hashlib.sha256(after.encode()).hexdigest(),
                      'snippet_sha256': hashlib.sha256(body).hexdigest()}))
    raise SystemExit(0)
if os.geteuid() != 0:
    raise SystemExit('Root required for publication')
backup = Path(tempfile.mkdtemp(prefix='quickchat-images-proxy-', dir='/home/ubuntu/qa-evidence'))
os.chmod(backup, 0o700)
shutil.copy2(site, backup / 'crm-before.conf')
os.chmod(backup / 'crm-before.conf', 0o600)
old_snippet = snippet.read_bytes() if snippet.exists() else None
if old_snippet is not None:
    (backup / 'snippet-before.conf').write_bytes(old_snippet)
    os.chmod(backup / 'snippet-before.conf', 0o600)
try:
    snippet.write_bytes(body)
    os.chmod(snippet, 0o644)
    site.write_text(after)
    subprocess.run(['/usr/sbin/nginx', '-t'], check=True, capture_output=True)
    subprocess.run(['systemctl', 'reload', 'nginx'], check=True, capture_output=True)
except BaseException:
    site.write_text(before)
    if old_snippet is None:
        snippet.unlink(missing_ok=True)
    else:
        snippet.write_bytes(old_snippet)
    raise
print(json.dumps({'published': True, 'source_sha': sha, 'backup': str(backup),
                  'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}))
