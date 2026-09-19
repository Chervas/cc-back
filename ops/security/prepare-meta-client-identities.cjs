#!/usr/bin/env node
'use strict';
// Local first installation only. No AWS, DB, runtime environment, flags, or grants.
// A partial or altered installation is inspected, never regenerated automatically.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const ROOT='/etc/clinicaclick-meta-clients-v1';
const fail=code=>{throw Object.assign(Error(code),{code});};
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const FLAGS=['BROKER','ACCESS_CHECK','REVOCATION','REVOCATION_WORKER','OAUTH','OAUTH_WORKER','OAUTH_DISCOVERY','ENROLLMENT','ENROLLMENT_WORKER'];
function topology(uids){
 if(!uids||Object.keys(uids).sort().join(',')!=='devApi,devWorker,staging'||Object.values(uids).some(v=>!Number.isSafeInteger(v)||v<1)||new Set(Object.values(uids)).size!==3)fail('meta_identity_uids_invalid');
 const actors=[{name:'dev-api',environment:'dev',uid:uids.devApi,roles:['reader','oauth-gateway','oauth-control']},
  {name:'dev-worker',environment:'dev',uid:uids.devWorker,roles:['oauth-gateway','oauth-control','asset-control']},
  {name:'staging',environment:'staging',uid:uids.staging,roles:['reader','oauth-gateway','oauth-control','asset-control']}];
 const principals=[];
 for(const environment of ['dev','staging'])for(const role of ['reader','oauth-gateway','oauth-control','asset-control']){
  const id=role==='reader'?`${environment}:meta-marketing`:role==='asset-control'?`control:${environment}:meta-marketing`:`${role==='oauth-gateway'?'gateway':'control'}:${environment}:meta-marketing-oauth`;
  principals.push({environment,role,id,keyId:`meta-${environment}-${role}-v1`,copies:actors.filter(a=>a.environment===environment&&a.roles.includes(role)).map(a=>({actor:a.name,uid:a.uid,file:a.name+'/'+role+'.pem'}))});
 }
 return {actors,principals};
}
function privateRead(file,uid){
 let fd;
 try{
  if(fs.realpathSync(file)!==file)fail('meta_identity_path_invalid');
  fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const s=fs.fstatSync(fd);
  if(!s.isFile()||s.uid!==uid||(s.mode&0o777)!==0o600||s.nlink!==1||s.size<1||s.size>65536)fail('meta_identity_file_invalid');
  return fs.readFileSync(fd);
 }finally{if(fd!==undefined)fs.closeSync(fd);}
}
function sync(dir){const fd=fs.openSync(dir,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function write(file,bytes,uid){
 const fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
 try{fs.writeFileSync(fd,bytes);fs.fchownSync(fd,uid,-1);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 sync(path.dirname(file));
}
function issuerIdentity(issuer){
 const c=new crypto.X509Certificate(issuer);
 if(!c.ca||new Date(c.validFrom)>new Date()||new Date(c.validTo)<=new Date())fail('meta_identity_issuer_invalid');
 return {pemSha256:sha(issuer),certificateSha256:sha(c.raw),validTo:c.validTo};
}
function directory(file,mode){
 const s=fs.lstatSync(file);
 if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o777)!==mode||fs.realpathSync(file)!==file)fail('meta_identity_directory_invalid');
}
function drafts(root,plan){
 return plan.actors.map(actor=>{
  const environment=actor.environment,origin='https://13.39.100.55:'+(environment==='dev'?8453:8454),audience='broker:meta-marketing:'+environment;
  const values=Object.fromEntries(FLAGS.map(flag=>['META_MARKETING_'+flag+'_ENABLED','false']));
  for(const prefix of ['META_MARKETING_BROKER','META_MARKETING_OAUTH_BROKER'])Object.assign(values,{[prefix+'_ORIGIN']:origin,[prefix+'_AUDIENCE']:audience,[prefix+'_CA_FILE']:root+'/'+actor.name+'/issuer.crt'});
  for(const role of actor.roles){const p=plan.principals.find(p=>p.environment===environment&&p.role===role);
   const prefix=role==='reader'?'META_MARKETING_BROKER':role==='asset-control'?'META_MARKETING_BROKER_CONTROL':role==='oauth-gateway'?'META_MARKETING_OAUTH_BROKER':'META_MARKETING_OAUTH_BROKER_CONTROL';
   values[prefix+'_KEY_ID']=p.keyId;values[prefix+'_KEY_FILE']=root+'/'+actor.name+'/'+role+'.pem';
  }
  return {actor:actor.name,file:actor.name+'.env.pending',content:'# Prepared only. Not a runtime EnvironmentFile. All Meta gates remain OFF.\n'+Object.entries(values).map(([k,v])=>k+'='+v).join('\n')+'\n'};
 });
}
function verify({root,uids,issuer}){
 directory(root,0o711);directory(root+'/drafts',0o700);
 const plan=topology(uids),manifest=JSON.parse(privateRead(root+'/manifest.json',process.getuid())),expectedIssuer=issuerIdentity(issuer);
 if(manifest.version!==1||manifest.kind!=='meta_client_identities_prepared'||manifest.runtimeConfigured!==false||manifest.awsPrincipalsInstalled!==false
  ||JSON.stringify(manifest.uids)!==JSON.stringify(uids)||JSON.stringify(manifest.issuer)!==JSON.stringify(expectedIssuer))fail('meta_identity_manifest_changed');
 if(!Array.isArray(manifest.principals)||manifest.principals.length!==8)fail('meta_identity_manifest_invalid');
 const fingerprints=[];
 for(const expected of plan.principals){
  const actual=manifest.principals.find(p=>p.id===expected.id);
  if(!actual||Object.keys(actual).sort().join(',')!=='copies,environment,id,keyId,publicKey,publicKeySha256,role'||!['environment','role','id','keyId','copies'].every(k=>JSON.stringify(actual[k])===JSON.stringify(expected[k])))fail('meta_identity_principal_changed');
  const pub=crypto.createPublicKey(actual.publicKey);
  if(pub.asymmetricKeyType!=='ed25519'||sha(pub.export({type:'spki',format:'der'}))!==actual.publicKeySha256)fail('meta_identity_public_key_invalid');
  fingerprints.push(actual.publicKeySha256);
  for(const copy of actual.copies){
   const bytes=privateRead(root+'/'+copy.file,copy.uid);
   try{const key=crypto.createPrivateKey(bytes),message=crypto.randomBytes(32);
    if(key.asymmetricKeyType!=='ed25519'||!crypto.verify(null,message,pub,crypto.sign(null,message,key)))fail('meta_identity_private_key_changed');
   }finally{bytes.fill(0);}
  }
 }
 if(new Set(fingerprints).size!==8)fail('meta_identity_key_reuse');
 for(const actor of plan.actors){directory(root+'/'+actor.name,0o711);const ca=privateRead(root+'/'+actor.name+'/issuer.crt',actor.uid);if(sha(ca)!==expectedIssuer.pemSha256)fail('meta_identity_ca_changed');
  const expectedFiles=[...actor.roles.map(r=>r+'.pem'),'issuer.crt'].sort();if(JSON.stringify(fs.readdirSync(root+'/'+actor.name).sort())!==JSON.stringify(expectedFiles))fail('meta_identity_extra_private_file');
 }
 for(const d of drafts(root,plan))if(privateRead(root+'/drafts/'+d.file,process.getuid()).toString()!==d.content)fail('meta_identity_draft_changed');
 return manifest;
}
function prepare({root,uids,issuer}){
 const plan=topology(uids),ca=issuerIdentity(issuer);
 let exists=false;try{fs.lstatSync(root);exists=true;}catch(error){if(error.code!=='ENOENT')throw error;}
 if(exists)return verify({root,uids,issuer});
 fs.mkdirSync(root,{mode:0o700});sync(path.dirname(root));
 write(root+'/started.json',JSON.stringify({at:new Date().toISOString(),uids,kind:'meta_identity_preparation_started'})+'\n',process.getuid());
 fs.mkdirSync(root+'/drafts',{mode:0o700});
 for(const actor of plan.actors){fs.mkdirSync(root+'/'+actor.name,{mode:0o711});fs.chmodSync(root+'/'+actor.name,0o711);write(root+'/'+actor.name+'/issuer.crt',issuer,actor.uid);}
 const principals=[];
 for(const p of plan.principals){
  const keys=crypto.generateKeyPairSync('ed25519'),privateBytes=Buffer.from(keys.privateKey.export({type:'pkcs8',format:'pem'}));
  try{for(const copy of p.copies)write(root+'/'+copy.file,privateBytes,copy.uid);}finally{privateBytes.fill(0);}
  principals.push({...p,publicKey:keys.publicKey.export({type:'spki',format:'pem'}),publicKeySha256:sha(keys.publicKey.export({type:'spki',format:'der'}))});
 }
 for(const d of drafts(root,plan))write(root+'/drafts/'+d.file,d.content,process.getuid());
 const manifest={version:1,kind:'meta_client_identities_prepared',at:new Date().toISOString(),uids,issuer:ca,runtimeConfigured:false,awsPrincipalsInstalled:false,principals};
 write(root+'/manifest.json',JSON.stringify(manifest,null,2)+'\n',process.getuid());fs.chmodSync(root,0o711);sync(root);
 return verify({root,uids,issuer});
}
function main(argv){
 if(process.getuid()!==0||argv.length!==1||!['prepare','verify'].includes(argv[0]))fail('meta_identity_root_action_required');
 const uid=name=>Number(cp.execFileSync('id',['-u',name],{encoding:'utf8'}).trim());
 const uids={devApi:uid('clinicaclick-dev'),devWorker:uid('clinicaclick-dev-security'),staging:uid('ubuntu')};
 if(JSON.stringify(uids)!=='{"devApi":998,"devWorker":996,"staging":1000}')fail('meta_identity_runtime_uid_changed');
 const cfg=JSON.parse(privateRead('/etc/clinicaclick-server-certificates/config.json',0));
 const issuer=fs.readFileSync(cfg.authority.certificateFile);
 if(issuerIdentity(issuer).certificateSha256!==cfg.authority.certificateSha256)fail('meta_identity_ca_pin_changed');
 const report=(argv[0]==='prepare'?prepare:verify)({root:ROOT,uids,issuer});
 console.log(JSON.stringify({status:report.kind,root:ROOT,principals:report.principals.map(p=>({id:p.id,keyId:p.keyId,publicKeySha256:p.publicKeySha256,copies:p.copies})),runtimeConfigured:false,awsPrincipalsInstalled:false}));
}
if(require.main===module)try{main(process.argv.slice(2));}catch(error){console.error(JSON.stringify({status:'meta_identity_failed_inspect_before_retry',code:/^meta_identity_[a-z_]+$/.test(error.code||'')?error.code:'meta_identity_operation_failed'}));process.exitCode=1;}
module.exports={topology,privateRead,issuerIdentity,prepare,verify,drafts};
