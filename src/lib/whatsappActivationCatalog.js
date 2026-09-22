'use strict';
// Non-secret runtime projection. Written by the authenticated gateway after
// the SQL receipt commits; read by the public sender and dedicated importer.
const fs=require('node:fs');const {randomUUID}=require('node:crypto');
// Keep the importer projection independent of broker/provider dependencies.
const E={exact:(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k)),
  uuid:v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v),
  id:v=>typeof v==='string'&&/^[1-9][0-9]{0,29}$/.test(v)};
const A={positive:n=>Number.isSafeInteger(n)&&n>0&&n<=2147483647,connectionRef:id=>'whatsapp-live-'+id};
const FILE='/var/lib/clinicaclick-whatsapp-catalog/connections.json';
const fail=()=>{throw Object.assign(Error('whatsapp_activation_catalog_invalid'),{code:'whatsapp_activation_catalog_invalid'});};
function validate(value){
  if(!E.exact(value,['version','connections'])||value.version!==1||!Array.isArray(value.connections)||value.connections.length>1000)fail();
  const keys=['authorizationId','connectionRef','assetId','phoneId','wabaId','scopeType','scopeId','clinicIds','sendEnabled','messageNotBefore'];
  const ids=new Set(),phones=new Set(),assets=new Set();
  for(const c of value.connections){
    if(!E.exact(c,keys)||!E.uuid(c.authorizationId)||c.connectionRef!==A.connectionRef(c.authorizationId)||!A.positive(c.assetId)
      ||!E.id(c.phoneId)||!E.id(c.wabaId)||!['clinic','group'].includes(c.scopeType)||!A.positive(c.scopeId)
      ||!Array.isArray(c.clinicIds)||!c.clinicIds.length||c.clinicIds.length>1000||c.clinicIds.some((n,i,a)=>!A.positive(n)||i&&a[i-1]>=n)
      ||c.scopeType==='clinic'&&(c.clinicIds.length!==1||c.clinicIds[0]!==c.scopeId)||typeof c.sendEnabled!=='boolean'
      ||typeof c.messageNotBefore!=='string'||!Number.isFinite(Date.parse(c.messageNotBefore))||new Date(c.messageNotBefore).toISOString()!==c.messageNotBefore
      ||ids.has(c.authorizationId)||phones.has(c.phoneId)||assets.has(c.assetId))fail();
    ids.add(c.authorizationId);phones.add(c.phoneId);assets.add(c.assetId);
  }
  return value;
}
function read(filename=FILE){
  if(!fs.existsSync(filename))return {version:1,connections:[]};
  const stat=fs.statSync(filename),dir=fs.statSync(require('node:path').dirname(filename));
  if(fs.realpathSync(filename)!==filename||!stat.isFile()||stat.mode&0o037||dir.mode&0o027||stat.size>1048576)fail();
  return validate(JSON.parse(fs.readFileSync(filename,'utf8')));
}
function write(value,filename=FILE){
  validate(value);const dir=require('node:path').dirname(filename),stat=fs.statSync(dir);
  if(!stat.isDirectory()||stat.mode&0o027||fs.realpathSync(dir)!==dir)fail();
  const temp=filename+'.'+randomUUID();let fd;
  try{fd=fs.openSync(temp,'wx',0o640);fs.fchmodSync(fd,0o640);fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);fs.closeSync(fd);fd=null;
    fs.renameSync(temp,filename);const d=fs.openSync(dir,'r');try{fs.fsyncSync(d)}finally{fs.closeSync(d)}}
  finally{if(fd!==null&&fd!==undefined)fs.closeSync(fd);if(fs.existsSync(temp))fs.unlinkSync(temp);}
}
function sendBindings(value){return validate(value).connections.flatMap(c=>c.clinicIds.map(clinicId=>({connectionRef:c.connectionRef,
  authorizationId:c.authorizationId,assetId:c.assetId,phoneId:c.phoneId,wabaId:c.wabaId,clinicId,revision:1,
  sendEnabled:c.sendEnabled,messageNotBefore:c.messageNotBefore})));}
function scopes(value){return validate(value).connections.map(c=>({assetId:c.assetId,phoneId:c.phoneId,wabaId:c.wabaId,clinicIds:[...c.clinicIds]}));}
module.exports={FILE,validate,read,write,sendBindings,scopes};
