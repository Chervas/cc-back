'use strict';
// Public ownership metadata only. The inbox UID cannot read onboarding state
// or its vault definitions. The writer publishes this before subscribing Meta.
const fs=require('node:fs'),path=require('node:path');const {randomUUID}=require('node:crypto');
const {fail}=require('./errors');const E=require('./whatsapp-onboarding-contract');const S=require('./whatsapp-inbox-scopes');
function validate(v,appId){
  if(!E.exact(v,['version','appId','scopes'])||v.version!==1||v.appId!==appId||!E.id(appId)||!Array.isArray(v.scopes))fail('scope_denied');
  return v.scopes.length?S.validateScopes(v.scopes):[];
}
function read(filename,appId){
  const s=fs.statSync(filename);
  if(!s.isFile()||s.mode&0o037||s.size>1048576||fs.realpathSync(filename)!==filename)fail('invalid_request');
  return validate(JSON.parse(fs.readFileSync(filename,'utf8')),appId);
}
function publish(filename,appId,scopes){
  const incoming=validate({version:1,appId,scopes},appId),before=read(filename,appId);
  // Capture is an append-only ownership catalogue, not the active send grant
  // registry. A superseded activation disappears from the reader, but replies
  // for its already-published identity must remain attributable. Never change
  // an existing phone's WABA or clinical ownership while retaining that history.
  const merged=new Map(before.map(scope=>[scope.phoneId,scope]));
  for(const scope of incoming){
    const old=merged.get(scope.phoneId);
    if(old&&JSON.stringify(old)!==JSON.stringify(scope))fail('scope_denied');
    merged.set(scope.phoneId,scope);
  }
  const value={version:1,appId,scopes:[...merged.values()]};value.scopes=validate(value,appId);
  const dir=path.dirname(filename),s=fs.statSync(dir);if(!s.isDirectory()||s.mode&0o027||fs.realpathSync(dir)!==dir)fail('invalid_request');
  const temp=filename+'.'+randomUUID();let fd;
  try{fd=fs.openSync(temp,'wx',0o640);fs.fchmodSync(fd,0o640);fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);fs.closeSync(fd);fd=null;
    fs.renameSync(temp,filename);const d=fs.openSync(dir,'r');try{fs.fsyncSync(d)}finally{fs.closeSync(d)}}
  finally{if(fd!==null&&fd!==undefined)fs.closeSync(fd);if(fs.existsSync(temp))fs.unlinkSync(temp);}
}
module.exports={validate,read,publish};
