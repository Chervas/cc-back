#!/usr/bin/python3
"""Publish the committed DEV application to its existing isolated service.

Requires root and an installed isolation boundary. Does not change SQL, runtime
secrets, firewall, public releases, or PM2. Never restores the old shared DEV.
"""
import os,pathlib,subprocess,tarfile,io,shutil,time,urllib.request,urllib.error,json,sys
SOURCE=pathlib.Path('/home/ubuntu/wt/back-dev')
ROOT=pathlib.Path('/opt/clinicaclick-dev')
def run(args):
 p=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 if p.returncode:raise RuntimeError('dev_publish_command_failed')
 return p.stdout
def within(path, parent):
 try:path.relative_to(parent);return True
 except ValueError:return False
def main():
 assert os.geteuid()==0 and len(sys.argv)==1
 assert pathlib.Path('/etc/clinicaclick-dev/runtime.env').is_file()
 git=['git','-c','safe.directory='+str(SOURCE),'-C',str(SOURCE)]
 assert not run(git+['status','--porcelain']).strip(), 'Commit DEV changes before publishing'
 sha=run(git+['rev-parse','HEAD']).decode().strip()
 previous=(ROOT/'current').resolve();target=ROOT/('release-'+sha)
 assert within(previous,ROOT) and not target.exists()
 target.mkdir(mode=0o755)
 archive=run(git+['archive','HEAD'])
 with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
  for m in tar.getmembers():
   p=pathlib.PurePosixPath(m.name)
   if p.parts[0] not in ['src','models','migrations','config','services'] and m.name not in ['package.json','package-lock.json','.sequelizerc']:continue
   if 'Documentacion' in p.parts:continue
   assert not p.is_absolute() and '..' not in p.parts and not m.issym() and not m.islnk()
   dest=target/m.name
   if m.isdir():dest.mkdir(parents=True,exist_ok=True,mode=0o755)
   elif m.isfile():
    dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(tar.extractfile(m).read());os.chmod(dest,0o644)
 for rel in ['']+[str(p.relative_to(target)) for p in (target/'services').iterdir() if p.is_dir()]:
  directory=target/rel;old=previous/rel
  if not (old/'node_modules').exists():continue
  assert (directory/'package-lock.json').read_bytes()==(old/'package-lock.json').read_bytes(), 'Dependency lock changed: prepare a reviewed independent dependency install first'
  shutil.copytree(old/'node_modules',directory/'node_modules',copy_function=os.link,symlinks=True)
  for p in (directory/'node_modules').rglob('*'):
   if p.is_symlink():assert within(p.resolve(),directory/'node_modules')
 (target/'release.json').write_text(json.dumps({'commit':sha,'source':str(SOURCE),'runtime':'dev-isolated-v1'})+'\n')
 temporary=ROOT/'next';assert not temporary.exists();temporary.symlink_to(target)
 run(['systemctl','stop','clinicaclick-back-dev.service'])
 os.replace(temporary,ROOT/'current')
 try:
  run(['systemctl','start','clinicaclick-back-dev.service'])
  deadline=time.monotonic()+20
  while True:
   try:urllib.request.urlopen('http://127.0.0.1:3004/api/auth/me',timeout=1)
   except urllib.error.HTTPError as e:
    if e.code==401:break
   except OSError:pass
   if time.monotonic()>deadline:raise RuntimeError('dev_publish_readiness_failed')
   time.sleep(.25)
 except Exception:
  run(['systemctl','stop','clinicaclick-back-dev.service'])
  temporary.symlink_to(previous);os.replace(temporary,ROOT/'current')
  run(['systemctl','start','clinicaclick-back-dev.service'])
  raise
 print(json.dumps({'status':'isolated_dev_published','commit':sha,'release':str(target),'publicRuntimeChanged':False}))
if __name__=='__main__':
 try:main()
 except Exception as e:
  print(json.dumps({'status':'dev_publish_failed','reason':str(e) if isinstance(e,(AssertionError,RuntimeError)) else type(e).__name__}),file=sys.stderr);sys.exit(1)
