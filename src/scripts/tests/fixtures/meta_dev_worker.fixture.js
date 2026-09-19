'use strict';
const assert=require('node:assert/strict'),{DataTypes}=require('sequelize');
const {startSecurityLoops,createMetaPollers}=require('../../dev-security-worker');
const C=require('../../../services/metaMarketingEnrollment.contract');
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {resolve,promise};};
async function until(check,label){const end=Date.now()+10000;while(!await check()){assert(Date.now()<end,label);await new Promise(r=>setTimeout(r,10));}}
module.exports=async({models,sql,service,enrollment,api,id,latest,report,commands,setBeforeWire,closeEnrollment})=>{
  models.JobRequest=require('../../../../models/jobrequest')(sql,DataTypes);await models.JobRequest.sync();
  const jobs=await models.JobRequest.bulkCreate(['dev','staging'].map(namespace=>({type:'fictitious_clinical_job',priority:'critical',payload:{__runtime_namespace:namespace}})));
  const entered=deferred(),released=deferred(),beats={email:0,audit:0,reconcile:0},errors=[];
  const env={META_MARKETING_OAUTH_WORKER_ENABLED:'true',META_MARKETING_ENROLLMENT_WORKER_ENABLED:'true'};
  const meta=createMetaPollers({env,load:id=>{
    if(id==='../services/metaMarketingOAuth.service')return service;
    if(id==='../services/metaMarketingEnrollment.service')return enrollment;
    assert.fail('disabled revocation lane must not import its module');
  }});
  let loops;
  const start=()=>startSecurityLoops({meta,onError:name=>errors.push(name),
    email:async()=>{beats.email++;},audit:async()=>{beats.audit++;},reconcile:async()=>{beats.reconcile++;},
    wait:(_ms,signal)=>require('node:timers/promises').setTimeout(15,undefined,{signal})});
  const stop=async()=>{loops.stop();await loops.done;loops=null;};
  try{
    assert.equal((await enrollment.run({closing:()=>true})).skipped,true);
    assert.equal((await service.run({closing:()=>true})).skipped,true);assert.equal(commands.length,0);
    setBeforeWire(async command=>{if(command.operation===C.E.OPERATIONS.prepare){entered.resolve();await released.promise;}});
    loops=start();let seen=false;entered.promise.then(()=>{seen=true;});await until(()=>seen,'Meta prepare must run through the DEV lane');
    await until(()=>Object.values(beats).every(n=>n>=4),'Other security lanes must continue while Meta is unresolved');
    assert.equal((await latest()).state,'prepare_pending');assert((await latest()).prepare_sent_at);
    loops.stop();let drained=false;loops.done.then(()=>{drained=true;});await new Promise(r=>setImmediate(r));assert.equal(drained,false);
    released.resolve();await loops.done;loops=null;setBeforeWire(null);
    assert.equal((await latest()).state,'prepared');assert.equal(commands.filter(c=>c.operation===C.E.OPERATIONS.prepare).length,1);
    report.checks.push('DEV Meta lane claims real SQL work and persists its delivery marker; slow HTTPS preparation does not hold other lanes; stop drains and stores the receipt once');
    const prepared=await latest();await api('POST','/'+id+'/confirmation',{selectionDigest:prepared.selection_digest});
    loops=start();await until(async()=>(await latest()).state==='active','Recreated DEV loops must finish confirmed activation');await stop();
    assert.equal(await models.ClinicMetaAsset.count({where:{isActive:true}}),2);assert.equal(commands.filter(c=>c.operation===C.E.OPERATIONS.activate).length,1);
    closeEnrollment();await api('DELETE','/'+id);await models.AuthSession.update({state:'revoked'},{where:{user_id:91002}});
    loops=start();await until(async()=>{const row=await latest();const flow=await models.MetaMarketingOAuthRequest.findByPk(row.flow_id);return row.state==='revoked'&&flow.state==='cancelled';},'DEV lanes must finish withdrawal and OAuth cancellation after logout');await stop();
    assert.equal(await models.ClinicMetaAsset.count({where:{isActive:true}}),0);assert.equal(await models.MetaMarketingEnrollmentClaim.count(),3);
    for(const job of jobs)assert.equal((await job.reload()).status,'pending');assert.deepEqual(errors,[]);
    report.checks.push('Restarted DEV lanes complete human-confirmed activation, then withdrawal and source OAuth cancellation after gate closure/logout; clinical DEV and staging jobs remain pending');
    report.devMetaWorker={beats,errors,prepareCalls:1,activationCalls:1,retainedClaims:3,clinicalJobsUntouched:2,realProvider:false,publicMfaAcceptance:false};
  }finally{setBeforeWire(null);released.resolve();if(loops)await stop();}
};
