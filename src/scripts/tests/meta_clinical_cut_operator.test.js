'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {parse}=require('../meta-clinical-cut');
const {clinicalCutFailure}=require('../../lib/clinicalCutFailure');
test('operator accepts only explicit cut/preflight with a pinned private plan and evidence path',()=>{
 const args=['preflight','--dir','/var/lib/clinicaclick-schema-recovery/meta-owned-plan','--out','/home/ubuntu/qa-evidence/owned-cut'];
 assert.equal(parse(args).action,'preflight');assert.equal(parse(['cut',...args.slice(1)]).action,'cut');
 for(const bad of [['retry',...args.slice(1)],[...args,'--force'],['cut','--dir','/tmp/plan',...args.slice(3)],['cut',...args.slice(1,3),'--out','/etc/other'],['cut',...args.slice(1,3),'--out','/home/ubuntu/qa-evidence/../other']])assert.throws(()=>parse(bad),/arguments_invalid/);
});
test('diagnostic retains mixed-case guard, SQL code and numeric assertion without raw error text',()=>{
 let error;try{assert.equal(5,0,'active_work_dueStaging');}catch(e){error=e;}
 const summary=clinicalCutFailure(error);assert.equal(summary.reason,'active_work_dueStaging');assert.equal(summary.actual,5);assert.equal(summary.expected,0);assert.equal(summary.code,'ERR_ASSERTION');
 const secret=Object.assign(Error('SELECT secret FICTITIOUS_PRIVATE_TOKEN from patient WHERE name=FICTITIOUS_PERSON'),{code:'ER_LOCK_WAIT_TIMEOUT',errno:1205,sqlState:'HY000'});
 const safe=clinicalCutFailure(secret);assert.equal(safe.code,'ER_LOCK_WAIT_TIMEOUT');assert.equal(safe.errno,1205);assert(!JSON.stringify(safe).includes('FICTITIOUS'));assert.equal(safe.messageDigest.length,64);
 const redis=clinicalCutFailure(Error('ERR user_script:29 clinical_cut_queue_external_control script: arbitrary_payload'));
 assert.equal(redis.reason,'clinical_cut_queue_external_control');assert(!JSON.stringify(redis).includes('arbitrary_payload'));
});
