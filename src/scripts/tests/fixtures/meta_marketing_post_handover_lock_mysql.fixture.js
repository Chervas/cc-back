'use strict';
// Only the enclosing owned --skip-networking fixture may invoke this probe.
// All provider transports are closed; old Flow/Enrollment/Recovery/WA bytes
// must survive baseline deadlock reproduction and the accepted guarded paths.
const assert=require('node:assert/strict'),{AsyncLocalStorage}=require('node:async_hooks'),{randomUUID,createHash}=require('node:crypto');
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const barrier=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
const bounded=async(promise,label)=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('POST_HANDOVER_TIMEOUT_'+label)),10000);})]);}finally{clearTimeout(timer);}};
module.exports=async({models,sql,now,report,initial,currentIds,baseline,untouched})=>{
  const baselineFile=process.env.META_MARKETING_OAUTH_LOCK_BASELINE;
  assert(path.isAbsolute(baselineFile)&&baselineFile.startsWith('/home/ubuntu/qa-evidence/meta-admission-lock-order-20261108/'));
  const filename=require.resolve('../../../services/metaMarketingOAuth.service'),oldModule=new Module(filename,module);
  oldModule.filename=filename;oldModule.paths=Module._nodeModulePaths(path.dirname(filename));oldModule._compile(fs.readFileSync(baselineFile,'utf8'),filename);
  const currentFactory=require('../../../services/metaMarketingOAuth.service').createService;
  const trace=report.postHandoverLockOrder={baselineSha256:createHash('sha256').update(fs.readFileSync(baselineFile)).digest('hex'),cases:[],providerRequests:0};
  const originals={transaction:sql.transaction,clinics:models.Clinica.findAll,enrollment:models.MetaMarketingEnrollmentRequest.findByPk};
  const roles=new AsyncLocalStorage(),transactions=new Map();let active;
  const options={META_MARKETING_LEADGEN_ENABLED:process.env.META_MARKETING_LEADGEN_ENABLED,META_MARKETING_BROKER_ENABLED:process.env.META_MARKETING_BROKER_ENABLED};
  process.env.META_MARKETING_LEADGEN_ENABLED='true';process.env.META_MARKETING_BROKER_ENABLED='true';
  await models.UsuarioClinica.bulkCreate([1,70,66,72].map(id_clinica=>({id_usuario:1,id_clinica,rol_clinica:'agencia',estado_invitacion:'aceptada'})));
  const sessions={verifyReference:async(reference,options)=>{assert([1,99].includes(reference.userId));assert.equal(options.requireEmail,true);assert(options.transaction);if(+reference.expiresAt<=+now())throw Object.assign(Error('auth_invalid'),{code:'auth_invalid'});}};
  const client={execute:async()=>{trace.providerRequests++;throw Error('POST_HANDOVER_PROVIDER_FORBIDDEN');}};
  const snapshot=async()=>JSON.stringify({flows:await models.MetaMarketingOAuthRequest.findAll({raw:true,order:[['flow_id','ASC']]}),
    enrollments:await models.MetaMarketingEnrollmentRequest.findAll({raw:true,order:[['enrollment_id','ASC']]}),
    recoveries:await models.MetaMarketingRecovery.findAll({raw:true,order:[['recovery_id','ASC']]}),handovers:await models.MetaMarketingBusinessHandover.findAll({raw:true,order:[['handover_id','ASC']]}),
    audits:await models.PlatformAuditEvent.findAll({attributes:['event_id','digest'],raw:true,order:[['event_id','ASC']]}),
    withdrawals:await models.MetaMarketingBrokerRevocation.findAll({raw:true,order:[['tuple_hash','ASC']]})});
  const before=await snapshot();
  sql.transaction=async function(options,work){
    const role=roles.getStore(),number=role==='human'?++active.humanTransactions:role==='competitor'?++active.competitorTransactions:0;
    const result=await originals.transaction.call(sql,options,async transaction=>{
      transactions.set(transaction.id,{role,number});return work(transaction);
    });
    if(role==='competitor'&&active.competitor==='renewal'&&number===1){active.competitorPreauthorized.resolve();await active.allowCompetitorMain.promise;}
    return result;
  };
  const observedError=error=>{const code=error?.original?.code||error?.parent?.code||error?.code;if(['ER_LOCK_DEADLOCK','ER_LOCK_WAIT_TIMEOUT'].includes(code))active.sqlErrors.push(code);throw error;};
  models.Clinica.findAll=async function(options){
    const label=transactions.get(options.transaction?.id);
    if(label?.role==='competitor'&&(active.competitor==='reader'||label.number>1))active.competitorClinic.resolve();
    let rows;try{rows=await originals.clinics.call(this,options);}catch(error){return observedError(error);}
    if(label?.role==='human'&&label.number===1){active.humanClinic.resolve();await active.releaseHuman.promise;}
    // The real reader reached BusinessSource -> old Enrollment -> Clinic. Stop
    // after acquiring that actual Clinic lock, before unrelated pair hydration.
    return label?.role==='competitor'&&active.competitor==='reader'?[]:rows;
  };
  models.MetaMarketingEnrollmentRequest.findByPk=async function(id,options){
    let row;try{row=await originals.enrollment.call(this,id,options);}catch(error){return observedError(error);}
    if(transactions.get(options.transaction?.id)?.role==='competitor'&&id===active.oldId)active.competitorOldEnrollment.resolve();return row;
  };
  try{
    for(let index=0;index<2;index++){
      const group=index===0?28:29,old=initial[index],current=await models.MetaMarketingEnrollmentRequest.findByPk(currentIds[index],{raw:true});
      const mapped=await models.ClinicMetaAsset.findAll({where:{id:JSON.parse(current.mapping_ids)},attributes:['id','assetType'],raw:true});
      const account=mapped.find(row=>row.assetType==='ad_account')?.id,page=mapped.find(row=>row.assetType==='facebook_page')?.id;
      assert(account&&page);assert.equal(old.state,'active');assert.equal(current.state,'active');
      for(const config of[{baseline:true,action:'status',competitor:'reader'},...['status','begin','cancel'].map(action=>({baseline:false,action,competitor:'reader'})),{baseline:false,action:'cancel',competitor:'renewal'}]){
        active={...config,oldId:old.enrollment_id,humanTransactions:0,competitorTransactions:0,sqlErrors:[],humanClinic:barrier(),releaseHuman:barrier(),competitorOldEnrollment:barrier(),competitorClinic:barrier(),competitorPreauthorized:barrier(),allowCompetitorMain:barrier()};
        const scenario=active,input={scopeKey:'group:'+group,actorId:1,sessionRef:randomUUID(),sessionExpiresAt:new Date(+now()+10800000)};
        const humanService=(config.baseline?oldModule.exports.createService:currentFactory)({models,sessions,client,now,enabled:()=>true,returnOrigin:'https://app.example.invalid'});
        let human,competitor;
        try{
          const compete=()=>roles.run('competitor',()=>config.competitor==='reader'
            ?sql.transaction({isolationLevel:'REPEATABLE READ'},transaction=>require('../../../services/metaMarketingLeadReader.service').forModels(models).preparePair(page,account,{transaction}))
            :require('../../../services/metaMarketingCredentialRenewal.service').createService({models,sessions,client,now,enabled:()=>true,returnOrigin:'https://app.example.invalid'}).overview({...input,actorId:99})).then(value=>({value}),error=>({error}));
          if(config.competitor==='renewal'){competitor=compete();await bounded(scenario.competitorPreauthorized.promise,'COMPETITOR_PREAUTHORIZED');}
          human=roles.run('human',()=>humanService[config.action](input,old.flow_id)).then(value=>({value}),error=>({error}));await bounded(scenario.humanClinic.promise,'HUMAN_CLINIC');
          if(config.competitor==='reader')competitor=compete();else scenario.allowCompetitorMain.resolve();
          await bounded(scenario.competitorOldEnrollment.promise,'COMPETITOR_OLD_ENROLLMENT');await bounded(scenario.competitorClinic.promise,'COMPETITOR_CLINIC');scenario.releaseHuman.resolve();
          const outcomes=await bounded(Promise.all([human,competitor]),'BOTH_SETTLED');
          if(config.baseline)assert(scenario.sqlErrors.includes('ER_LOCK_DEADLOCK'),'Original OAuth status must reproduce the actual old/new Enrollment cycle');
          else{
            assert.deepEqual(scenario.sqlErrors,[]);assert(outcomes[0].error,'The old OAuth path must remain closed after supersession');
            if(config.action==='cancel')assert.equal(outcomes[0].error.code,'meta_enrollment_not_active');
            else assert.equal(outcomes[0].error.code,'meta_recovery_changed');
            if(config.competitor==='renewal')assert.equal(outcomes[1].value.canRenew,false);
          }
          trace.cases.push({group,...config,sqlErrors:[...scenario.sqlErrors],humanTransactions:scenario.humanTransactions,humanError:outcomes[0].error?.code||null,competitorError:outcomes[1].error?.code||null});
        }finally{
          scenario.releaseHuman.resolve();scenario.allowCompetitorMain.resolve();await bounded(Promise.allSettled([human,competitor].filter(Boolean)),'CASE_CLEANUP');
        }
      }
    }
    assert.equal(await snapshot(),before,'Deadlock handling must not rewrite old superseded Flow/Enrollment/Recovery/Business history');
    assert.equal(await baseline(),untouched);assert.equal(trace.providerRequests,0);
    report.checks.push('Actual post-handover InnoDB reproduces original group28/29 OAuth status/reader deadlocks; guarded status/begin/old-flow cancel vs reader or renewal settle without late Enrollment waits, provider calls or mutations to superseded/WA history.');
  }finally{
    sql.transaction=originals.transaction;models.Clinica.findAll=originals.clinics;models.MetaMarketingEnrollmentRequest.findByPk=originals.enrollment;
    for(const[key,value]of Object.entries(options)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  }
};
