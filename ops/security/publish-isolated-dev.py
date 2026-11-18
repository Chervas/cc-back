#!/usr/bin/python3
"""Publish the committed DEV application to its existing isolated service.

Requires root and an installed isolation boundary. Does not change SQL, runtime
secrets, firewall, public releases, or PM2. Never restores the old shared DEV.
"""
import os,pathlib,subprocess,tarfile,io,shutil,time,urllib.request,urllib.error,json,sys
import argparse,hashlib,stat
SOURCE=pathlib.Path('/home/ubuntu/wt/back-dev')
ROOT=pathlib.Path('/opt/clinicaclick-dev')
def run(args):
 p=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 if p.returncode:raise RuntimeError('dev_publish_command_failed')
 return p.stdout
def within(path, parent):
 try:path.relative_to(parent);return True
 except ValueError:return False

def require(condition, reason):
 if not condition:raise RuntimeError(reason)

def sha256(path):
 digest=hashlib.sha256()
 with path.open('rb') as source:
  for chunk in iter(lambda:source.read(1024*1024),b''):digest.update(chunk)
 return digest.hexdigest()

def trusted_entry(path):
 info=path.lstat()
 require(info.st_uid==0 and (stat.S_ISLNK(info.st_mode) or not info.st_mode & 0o022),
         'dependency_bundle_untrusted_owner_or_mode')
 require(stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode),
         'dependency_bundle_unsupported_file')
 return info

def trusted_tree(directory, symlink_boundary):
 trusted_entry(directory)
 for parent, directories, files in os.walk(directory,followlinks=False):
  for name in directories+files:
   path=pathlib.Path(parent)/name;info=trusted_entry(path)
   if stat.S_ISLNK(info.st_mode):
    require(within(path.resolve(strict=True),symlink_boundary),'dependency_bundle_symlink_outside_modules')

DEPENDENCY_SMOKE=r"""
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createRequire}=require('node:module');
(async()=>{
 assert.equal(Number(process.versions.node.split('.')[0]),22);
 assert.equal(process.getuid(),0);
 const root=fs.realpathSync(process.argv[1]),modules=path.join(root,'node_modules');
 const load=createRequire(path.join(root,'package.json'));
 const names=['sharp','bcrypt','postcss','htmlparser2','sanitize-html'];
 for(const name of names){const resolved=fs.realpathSync(load.resolve(name));assert.ok(resolved.startsWith(modules+path.sep));}
 const bcrypt=load('bcrypt');assert.ok(bcrypt.compareSync('isolated-smoke',bcrypt.hashSync('isolated-smoke',4)));
 const postcss=load('postcss');assert.equal(postcss.parse('p{color:red}').first.type,'rule');
 const {Parser}=load('htmlparser2');let text='';const parser=new Parser({ontext:value=>text+=value});
 parser.write('<b>verified</b>');parser.end();assert.equal(text,'verified');
 const clean=load('sanitize-html')('<script>unsafe()</script><p>verified</p>');
 assert.equal(clean,'<p>verified</p>');
 const sharp=load('sharp');const image=await sharp({create:{width:2,height:2,channels:3,background:{r:0,g:0,b:0}}}).resize(1,1).png().toBuffer();
 assert.ok(Buffer.isBuffer(image));assert.equal(image.subarray(1,4).toString(),'PNG');
 console.log(JSON.stringify({node_major:22,modules:names}));
})().catch(()=>{process.exitCode=1;});
"""

def verify_dependency_smoke(bundle):
 # Never pass runtime.env or inherited cloud credentials, NODE_OPTIONS/NODE_PATH,
 # npm hooks or the calling shell's environment to dependency verification.
 environment={'PATH':'/usr/bin:/bin','HOME':'/nonexistent','LANG':'C.UTF-8','NODE_ENV':'test'}
 try:
  result=subprocess.run(['/usr/bin/node','-e',DEPENDENCY_SMOKE,str(bundle)],cwd=str(bundle),env=environment,
                        stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=30)
  require(result.returncode==0,'dependency_bundle_smoke_failed')
  observed=json.loads(result.stdout)
 except (ValueError,OSError,subprocess.TimeoutExpired):raise RuntimeError('dependency_bundle_smoke_failed')
 require(observed=={'node_major':22,'modules':['sharp','bcrypt','postcss','htmlparser2','sanitize-html']},
         'dependency_bundle_smoke_failed')

def validate_dependency_bundle(value, candidate):
 bundle=pathlib.Path(value)
 base=ROOT/'dependency-bundles'
 require(bundle.is_absolute() and '..' not in bundle.parts and bundle!=base and within(bundle,base),
         'dependency_bundle_path_invalid')
 # Verify every ancestor too: an owner-only directory below a writable parent
 # must not be accepted as an immutable source.
 for directory in [bundle]+list(bundle.parents):
  info=trusted_entry(directory)
  require(stat.S_ISDIR(info.st_mode),'dependency_bundle_directory_symlink')
 require(bundle.resolve(strict=True)==bundle,'dependency_bundle_path_invalid')
 manifest_path=bundle/'dependency-bundle.json'
 require(manifest_path.is_file() and not manifest_path.is_symlink() and manifest_path.stat().st_size<=65536,
         'dependency_bundle_manifest_invalid')
 trusted_tree(bundle,bundle/'node_modules')
 try:manifest=json.loads(manifest_path.read_text())
 except (ValueError,UnicodeError):raise RuntimeError('dependency_bundle_manifest_invalid')
 expected={'schema','lock_sha256','package_sha256','node_major','smoke_verified'}
 require(isinstance(manifest,dict) and set(manifest)==expected and type(manifest['schema']) is int and manifest['schema']==1
         and type(manifest['node_major']) is int and manifest['node_major']==22 and manifest['smoke_verified'] is True,
         'dependency_bundle_manifest_invalid')
 for filename,key in [('package-lock.json','lock_sha256'),('package.json','package_sha256')]:
  path=bundle/filename
  require(path.is_file() and not path.is_symlink(),'dependency_bundle_package_invalid')
  require(isinstance(manifest[key],str) and len(manifest[key])==64 and all(c in '0123456789abcdef' for c in manifest[key]),
          'dependency_bundle_manifest_invalid')
  require(sha256(path)==manifest[key]==sha256(candidate/filename),'dependency_bundle_candidate_hash_mismatch')
 modules=bundle/'node_modules'
 require(modules.is_dir() and not modules.is_symlink(),'dependency_bundle_modules_invalid')
 verify_dependency_smoke(bundle)
 return bundle

def copy_bundle_modules(bundle, directory):
 source=bundle/'node_modules';destination=directory/'node_modules'
 # Independent files, never hardlinks to the prepared bundle or active runtime.
 shutil.copytree(source,destination,symlinks=True)
 for parent, directories, files in os.walk(destination,followlinks=False):
  for name in directories+files:
   path=pathlib.Path(parent)/name
   if path.is_symlink() and pathlib.Path(os.readlink(path)).is_absolute():
    resolved=(source/path.relative_to(destination)).resolve(strict=True)
    replacement=destination/resolved.relative_to(source)
    path.unlink();path.symlink_to(os.path.relpath(replacement,path.parent))
 trusted_tree(destination,destination)

def install_dependencies(previous,target,bundle=None):
 for rel in ['']+[str(p.relative_to(target)) for p in (target/'services').iterdir() if p.is_dir()]:
  directory=target/rel;old=previous/rel
  if rel=='' and bundle is not None:
   copy_bundle_modules(bundle,directory)
   continue
  if not (old/'node_modules').exists():continue
  # A root bundle cannot authorise dependency changes in a broker/subservice.
  assert (directory/'package-lock.json').read_bytes()==(old/'package-lock.json').read_bytes(), 'Dependency lock changed: prepare a reviewed independent dependency install first'
  shutil.copytree(old/'node_modules',directory/'node_modules',copy_function=os.link,symlinks=True)
  for p in (directory/'node_modules').rglob('*'):
   if p.is_symlink():assert within(p.resolve(),directory/'node_modules')

def main():
 parser=argparse.ArgumentParser(description=__doc__)
 parser.add_argument('--dependency-bundle',metavar='PATH',help='Root-owned, candidate-pinned independent dependency bundle')
 options=parser.parse_args()
 assert os.geteuid()==0
 os.umask(0o022)
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
   if p.parts[0] not in ['src','models','migrations','config','services'] and m.name not in ['package.json','package-lock.json','.sequelizerc','ops/security/schema-contract.json']:continue
   if 'Documentacion' in p.parts:continue
   assert not p.is_absolute() and '..' not in p.parts and not m.issym() and not m.islnk()
   dest=target/m.name
   if m.isdir():dest.mkdir(parents=True,exist_ok=True,mode=0o755)
   elif m.isfile():
    dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(tar.extractfile(m).read());os.chmod(dest,0o644)
 bundle=validate_dependency_bundle(options.dependency_bundle,target) if options.dependency_bundle else None
 install_dependencies(previous,target,bundle)
 (target/'release.json').write_text(json.dumps({'commit':sha,'source':str(SOURCE),'runtime':'dev-isolated-v1'})+'\n')
 # Fail before stopping the old service or switching code. The checker reads
 # only schema metadata using the protected DEV configuration; it never migrates.
 run(['/usr/bin/node',str(target/'src/scripts/security-schema-release.js'),'check','--runtime','dev',
      '--source',str(target),'--out',str(target/'schema-preflight.json')])
 temporary=ROOT/'next';assert not temporary.exists();temporary.symlink_to(target)
 security_active=subprocess.run(['systemctl','is-active','--quiet','clinicaclick-dev-security.service']).returncode==0
 if security_active:run(['systemctl','stop','clinicaclick-dev-security.service'])
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
  if security_active:
   run(['systemctl','start','clinicaclick-dev-security.service'])
   time.sleep(1)
   assert run(['systemctl','is-active','clinicaclick-dev-security.service']).strip()==b'active'
 except Exception:
  if security_active:run(['systemctl','stop','clinicaclick-dev-security.service'])
  run(['systemctl','stop','clinicaclick-back-dev.service'])
  temporary.symlink_to(previous);os.replace(temporary,ROOT/'current')
  run(['systemctl','start','clinicaclick-back-dev.service'])
  if security_active:run(['systemctl','start','clinicaclick-dev-security.service'])
  raise
 print(json.dumps({'status':'isolated_dev_published','commit':sha,'release':str(target),'publicRuntimeChanged':False}))
if __name__=='__main__':
 try:main()
 except Exception as e:
  print(json.dumps({'status':'dev_publish_failed','reason':str(e) if isinstance(e,(AssertionError,RuntimeError)) else type(e).__name__}),file=sys.stderr);sys.exit(1)
