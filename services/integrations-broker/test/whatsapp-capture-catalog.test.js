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
test('capture preserves historical scopes without widening or changing ownership',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wa-capture-history-'));fs.chmodSync(dir,0o750);
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'capture.json'),capture=require('../src/whatsapp-capture-catalog');
 fs.writeFileSync(file,JSON.stringify({version:1,appId:'301',scopes:[]}),{mode:0o640});
 const old={phoneId:'401',wabaId:'501',clinicIds:[71]},next={phoneId:'402',wabaId:'502',clinicIds:[71]};
 capture.publish(file,'301',[old]);capture.publish(file,'301',[next]);capture.publish(file,'301',[next]);
 assert.deepEqual(capture.read(file,'301').map(s=>s.phoneId),['401','402']);
 const snapshot=fs.readFileSync(file,'utf8');
 for(const patch of [{wabaId:'999'},{clinicIds:[72]},{clinicIds:[71,72]}]){
  assert.throws(()=>capture.publish(file,'301',[{...old,...patch}]),/scope_denied/);
  assert.equal(fs.readFileSync(file,'utf8'),snapshot);
 }
 capture.publish(file,'301',[]);assert.equal(fs.readFileSync(file,'utf8'),snapshot);
 capture.publish(file,'301',[{phoneId:'403',wabaId:'503',clinicIds:[90]}]);
 assert.deepEqual(capture.read(file,'301').map(s=>[s.phoneId,s.clinicIds]),[['401',[71]],['402',[71]],['403',[90]]]);
 assert.equal(fs.statSync(file).mode&0o777,0o640);
 assert.deepEqual(fs.readdirSync(dir),['capture.json']);
});
