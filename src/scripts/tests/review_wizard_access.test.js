'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const drafts = require('../../services/reviewWizardDraft.service');
test('draft identity is server-owned; test destinations and arbitrary patient rows cannot be persisted', () => {
  const scope = {scope:'clinic',clinicIds:[56]};
  assert.notEqual(drafts.draftKey(1,scope),drafts.draftKey(2,scope));
  assert.notEqual(drafts.draftKey(1,scope),drafts.draftKey(1,{scope:'clinic',clinicIds:[57]}));
  assert.throws(()=>drafts.draftKey(1,{scope:'multi',clinicIds:[56,57]}));
  assert.deepEqual(drafts.cleanState({reviewSenderName:'TESTONLY',phone:'600000000',patients:[{name:'TESTONLY'}],token:'TESTONLY'}),{reviewSenderName:'TESTONLY'});
  assert.throws(()=>drafts.cleanState({reviewSenderName:'x'.repeat(200000)}));
});
function fixture({allowed=true,patientEdit=true,scope={isValid:true,scope:'clinic',clinicIds:[56]}}={}) {
  const calls=[];
  const deps={
    '../../models':{},
    '../lib/clinicScope':{resolveClinicScope:async()=>scope},
    '../lib/marketingScopeAccess':{hasMarketingClinicScopeAccess:async opts=>{calls.push(['access',opts]);return allowed;}},
    '../lib/access-policy':{assertUserCanAccessFeature:async opts=>{calls.push(['feature',opts]);if(opts.featureKey==='patients.edit'&&!patientEdit)throw Object.assign(Error('forbidden'),{status:403});}},
    '../services/reviewWizardDraft.service':{get:async()=>({success:true}),save:async opts=>{calls.push(['save',opts]);return {success:true};}},
    '../services/reviewRecipientRegistration.service':{run:async opts=>{calls.push(['run',opts]);return {success:true};}},
  };
  const sandbox={exports:{},require:name=>{assert(name in deps,name);return deps[name];},console};
  vm.runInNewContext(fs.readFileSync(require.resolve('../../controllers/reviewWizard.controller'),'utf8'),sandbox);
  async function request(name,req={}) {
    let status=200,body; const response={set(){},status(value){status=value;return this;},json(value){body=value;return this;}};
    await sandbox.exports[name]({userData:{userId:1},query:{clinic_id:56},params:{listId:'42'},body:{sha256:'a'.repeat(64),sourceSystem:'unknown'},...req},response);
    return {status,body};
  }
  return {calls,request};
}
test('unrelated clinic and unauthenticated requests never reach storage or registration',async()=>{
  const f=fixture({allowed:false});assert.equal((await f.request('applyRegistration')).status,403);assert(!f.calls.some(c=>c[0]==='run'));
  const g=fixture();assert.equal((await g.request('saveDraft',{userData:null})).status,401);assert.equal(g.calls.length,0);
});
test('registration requires patient editing separately from marketing; preview is read-only',async()=>{
  const f=fixture({patientEdit:false});assert.equal((await f.request('previewRegistration')).status,200);
  assert.equal(f.calls.find(c=>c[0]==='run')[1].apply,false);
  f.calls.length=0;assert.equal((await f.request('applyRegistration')).status,403);assert(!f.calls.some(c=>c[0]==='run'));
});
test('client actor and clinic fields cannot change the registration target; group creation is rejected',async()=>{
  const f=fixture();assert.equal((await f.request('applyRegistration',{body:{actorId:99,clinicId:99,sha256:'a'.repeat(64),sourceSystem:'unknown'}})).status,200);
  const run=f.calls.find(c=>c[0]==='run')[1];assert.equal(run.actorId,1);assert.equal(run.clinicId,56);
  const g=fixture({scope:{isValid:true,scope:'group',clinicIds:[56,57]}});assert.equal((await g.request('applyRegistration')).status,400);assert(!g.calls.some(c=>c[0]==='run'));
});
