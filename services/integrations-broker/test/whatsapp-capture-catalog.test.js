'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
test('capture and importer projections remain group-readable under service umask 0077',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wa-capture-mode-'));fs.chmodSync(dir,0o2750);const prior=process.umask(0o077);
 try{
  const file=path.join(dir,'capture.json');fs.writeFileSync(file,JSON.stringify({version:1,appId:'301',scopes:[]}));fs.chmodSync(file,0o640);
  const capture=require('../src/whatsapp-capture-catalog');capture.publish(file,'301',[{phoneId:'401',wabaId:'501',clinicIds:[71]}]);
  assert.equal(fs.statSync(file).mode&0o777,0o640);assert.equal(capture.read(file,'301')[0].phoneId,'401');
  const local=require('../../../src/lib/whatsappActivationCatalog'),localFile=path.join(dir,'local.json');local.write({version:1,connections:[]},localFile);
  assert.equal(fs.statSync(localFile).mode&0o777,0o640);assert.equal(local.read(localFile).connections.length,0);
 }finally{process.umask(prior);fs.rmSync(dir,{recursive:true,force:true})}
});
