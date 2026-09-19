'use strict';
// Root is required to reproduce the three actual UID boundaries in owned /tmp.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
assert.equal(process.env.META_IDENTITY_ROOT_TEST,'1');assert.equal(process.getuid(),0);
const M=require('./prepare-meta-client-identities.cjs'),uids={devApi:998,devWorker:996,staging:1000};
function fixture(t){
 const parent=fs.mkdtempSync('/tmp/cc-meta-identity-qa-');fs.chmodSync(parent,0o711);
 t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));
 fs.writeFileSync(parent+'/openssl.cnf','[req]\ndistinguished_name=dn\nx509_extensions=ca\nprompt=no\n[dn]\nCN=MetaIdentityQA\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid:always\n');
 cp.execFileSync('/usr/bin/openssl',['req','-config',parent+'/openssl.cnf','-x509','-newkey','ed25519','-nodes','-keyout',parent+'/test-ca.key','-out',parent+'/test-ca.crt','-days','1'],{stdio:'ignore'});
 fs.chmodSync(parent+'/test-ca.key',0o600);
 return {root:parent+'/material',uids,issuer:fs.readFileSync(parent+'/test-ca.crt'),parent};
}
function userRead(file,uid){
 return JSON.parse(cp.execFileSync('/usr/bin/setpriv',['--reuid',String(uid),'--regid',String(uid===1000?1000:998),'--clear-groups',process.execPath,'-e',
  "try { require('node:fs').readFileSync(process.argv[1]); console.log(JSON.stringify({read:true})); } catch(e) { console.log(JSON.stringify({read:false,code:e.code})); }",file],{encoding:'utf8',cwd:'/',env:{PATH:'/usr/bin:/bin'}}));
}
test('separate role and environment keys persist unchanged on a second preparation; no flags are enabled',t=>{
 const f=fixture(t),first=M.prepare(f),bytes=fs.readFileSync(f.root+'/manifest.json');
 assert.equal(first.principals.length,8);assert.equal(new Set(first.principals.map(p=>p.publicKeySha256)).size,8);
 assert.deepEqual(M.prepare(f),first);assert.deepEqual(fs.readFileSync(f.root+'/manifest.json'),bytes);
 const plan=M.topology(uids);
 for(const draft of M.drafts(f.root,plan)){
  const values=Object.fromEntries(draft.content.split('\n').filter(v=>v.includes('=')).map(v=>v.split('=')));
  const gates=Object.entries(values).filter(([k])=>k.endsWith('_ENABLED'));assert.equal(gates.length,9);assert(gates.every(([,v])=>v==='false'));
  assert.equal(Object.hasOwn(values,'META_MARKETING_BROKER_CONTROL_KEY_FILE'),draft.actor!=='dev-api');
  assert.equal(Object.hasOwn(values,'META_MARKETING_BROKER_KEY_FILE'),draft.actor!=='dev-worker');
 }
});
test('actual UIDs read only their key copies; DEV API cannot read asset control or public keys, worker cannot read API-only reader',t=>{
 const f=fixture(t),manifest=M.prepare(f);
 for(const p of manifest.principals)for(const copy of p.copies){
  assert.deepEqual(userRead(f.root+'/'+copy.file,copy.uid),{read:true});
  for(const uid of Object.values(uids).filter(v=>v!==copy.uid))assert.deepEqual(userRead(f.root+'/'+copy.file,uid),{read:false,code:'EACCES'});
 }
 for(const uid of Object.values(uids))assert.deepEqual(userRead(f.root+'/drafts/dev-api.env.pending',uid),{read:false,code:'EACCES'});
});
test('a partial installation is preserved and never regenerated',t=>{
 const f=fixture(t);fs.mkdirSync(f.root,{mode:0o700});const sentinel=crypto.randomBytes(64);fs.writeFileSync(f.root+'/started.json',sentinel,{mode:0o600});
 assert.throws(()=>M.prepare(f));assert.deepEqual(fs.readFileSync(f.root+'/started.json'),sentinel);assert.deepEqual(fs.readdirSync(f.root),['started.json']);
});
test('changed key, broad file permissions, hard links and a key symlink all reject verification',t=>{
 const f=fixture(t),manifest=M.prepare(f),copy=manifest.principals[0].copies[0],file=f.root+'/'+copy.file,original=fs.readFileSync(file);
 const foreign=crypto.generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'});fs.writeFileSync(file,foreign);
 assert.throws(()=>M.verify(f),{code:'meta_identity_private_key_changed'});fs.writeFileSync(file,original);
 fs.chmodSync(file,0o640);assert.throws(()=>M.verify(f),{code:'meta_identity_file_invalid'});fs.chmodSync(file,0o600);
 fs.linkSync(file,f.parent+'/hardlink');assert.throws(()=>M.verify(f),{code:'meta_identity_file_invalid'});fs.unlinkSync(f.parent+'/hardlink');
 fs.renameSync(file,f.parent+'/original');fs.symlinkSync(f.parent+'/original',file);assert.throws(()=>M.verify(f),{code:'meta_identity_path_invalid'});
});
test('issuer change and altered pending flags are rejected without rewriting the material',t=>{
 const f=fixture(t);M.prepare(f);const draft=f.root+'/drafts/dev-api.env.pending',before=fs.readFileSync(draft,'utf8');
 fs.writeFileSync(draft,before.replace('META_MARKETING_OAUTH_ENABLED=false','META_MARKETING_OAUTH_ENABLED=true'));
 assert.throws(()=>M.prepare(f),{code:'meta_identity_draft_changed'});assert(fs.readFileSync(draft,'utf8').includes('META_MARKETING_OAUTH_ENABLED=true'));
 fs.writeFileSync(draft,before);const other=fixture(t);assert.throws(()=>M.verify({...f,issuer:other.issuer}),{code:'meta_identity_manifest_changed'});
});
test('a root symlink and reused service UIDs are refused before creating keys',t=>{
 const f=fixture(t);fs.mkdirSync(f.parent+'/other',{mode:0o711});fs.symlinkSync(f.parent+'/other',f.root);
 assert.throws(()=>M.prepare(f),{code:'meta_identity_directory_invalid'});assert.deepEqual(fs.readdirSync(f.parent+'/other'),[]);
 assert.throws(()=>M.topology({...uids,devWorker:uids.devApi}),{code:'meta_identity_uids_invalid'});
});
