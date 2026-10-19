'use strict';
const assert = require('node:assert/strict');
const S = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { loadSource } = require('./fixtures/business_profile_flow_runtime.fixture');

withIsolatedCampaignMysql(async ({ sql, models: db, report }) => {
  db.sequelize = sql; db.Sequelize = S;
  for (const file of ['whatsapptemplate','jobrequest']) {
    const model = require('../../../models/' + file)(sql,S.DataTypes); db[model.name] = model; await model.sync();
  }
  await sql.getQueryInterface().addIndex('WhatsappTemplates',['waba_id','name','language'], { unique:true, name:'uniq_waba_template_language' });
  db.MarketingPatientList = sql.define('MarketingPatientList', {
    id: { type:S.DataTypes.INTEGER,primaryKey:true,autoIncrement:true }, objective_id:S.DataTypes.STRING,
    status:S.DataTypes.STRING,criteria:S.DataTypes.JSON,template_snapshot:S.DataTypes.JSON,safety_gates:S.DataTypes.JSON,
  }, { tableName:'MarketingPatientLists',timestamps:false }); await db.MarketingPatientList.sync();
  const env = { JOB_RUNTIME_NAMESPACE:'dev',RUNTIME_ROLE:'api',JOBS_AUTO_START:'false' };
  const jobs = loadSource('jobRequests.service',{ '../../models':db },env);
  let calls=0,failUnknown=false,failJob=false;
  const broker = { templateBinding:async()=>({ assetId:1 }), templates:async(_waba,_operation,input)=>{
    calls++; assert.equal(await db.WhatsappTemplate.count({where:{name:input.template.name}}),1,'Checkpoint must precede provider');
    assert((await db.JobRequest.count())>0,'Recovery job must precede provider');
    if(failUnknown) throw Object.assign(Error('synthetic outcome unknown'),{code:'outcome_unknown'});
    return {id:'TESTONLY_'+calls};
  } };
  const service = loadSource('whatsappTemplates.service',{ '../../models':db,
    './queue.service':{queues:{}},'./jobRequests.service':{...jobs,enqueueUniqueJobRequest:async(...args)=>{
      if(failJob)throw Error('TESTONLY_JOB_FAILURE'); return jobs.enqueueUniqueJobRequest(...args);
    }}, './whatsappTemplateAutomationSync.service':{},'../lib/whatsappAuthorizedBrokerClient':broker,
  },env);
  const base = { clinicId:1,wabaId:'101',targetWabaIds:['101'],createdByUserId:2,
    displayName:'TESTONLY relocation',bodyText:'Hello {{nombre_paciente}}, our new address is Test Street.',
    category:'UTILITY',language:'es',variables:[{name:'nombre_paciente',example:'TESTONLY'}] };
  const parallel = await Promise.allSettled(Array.from({length:20},(_,i)=>service.createCustomTemplateForClinic({...base,requestId:'synthetic-request-'+String(i).padStart(3,'0')})));
  assert(parallel.some(item=>item.status==='fulfilled'));
  for(const item of parallel.filter(item=>item.status==='rejected'))assert.equal(item.reason.code,'template_submission_in_progress');
  const first = await service.createCustomTemplateForClinic(base);
  assert.equal(calls,1); assert.equal(await db.WhatsappTemplate.count(),1);
  assert.equal(first.row.variables[0].name,'nombre_paciente');
  report.checks.push('Actual custom submission service, WABA GET_LOCK, local unique index and native JobRequests produce one provider call across 20 concurrent browser identities');

  const lists=[];
  for(const status of ['draft','prepared','sending'])lists.push(await db.MarketingPatientList.create({objective_id:'mass_sends',status,
    criteria:{whatsapp_template_id:first.row.id,untouched:'sender-101'},template_snapshot:{id:first.row.id},safety_gates:{approved_template:true}}));
  const replacement = await service.createCustomTemplateForClinic({...base,bodyText:'Hello {{1}}, the updated number is TESTONLY.',
    variables:[{name:'nombre_paciente',index:1,example:'TESTONLY'}],replaceTemplateId:first.row.id});
  assert.equal(replacement.row.variables[0].name,'nombre_paciente');
  await first.row.reload(); assert.equal(first.row.is_active,false); assert.equal(first.row.superseded_by_template_id,replacement.row.id);
  for(const list of lists){await list.reload(); assert.equal(list.criteria.untouched,'sender-101');
    assert.equal(list.template_snapshot.id,list.status==='sending'?first.row.id:replacement.row.id);
    assert.equal(list.safety_gates.approved_template,list.status==='sending');}
  assert.equal((await service.createCustomTemplateForClinic({...base,bodyText:'Hello {{1}}, the updated number is TESTONLY.',
    variables:[{name:'nombre_paciente',index:1,example:'TESTONLY'}],replaceTemplateId:first.row.id})).row.id,replacement.row.id);
  assert.equal(calls,2);
  report.checks.push('A replacement atomically updates only editable draft/prepared snapshots, preserves sender criteria, removes old approval and retires only the explicit predecessor; positional variables preserve their semantic name');

  failUnknown=true;
  const uncertain={...base,displayName:'TESTONLY uncertain',bodyText:'Hello {{nombre_paciente}}, synthetic pending.'};
  const unknown=await service.createCustomTemplateForClinic(uncertain);
  assert.equal(unknown.submitted,false);
  for(let i=0;i<5;i++)assert.equal((await service.createCustomTemplateForClinic({...uncertain,requestId:'different-retry-'+i})).row.id,unknown.row.id);
  assert.equal(calls,3); failUnknown=false;
  report.checks.push('Actual provider outcome_unknown and five new-form retries keep the same persisted row/name without another provider call');

  failJob=true; const before={...base,displayName:'TESTONLY job unavailable'};
  await assert.rejects(service.createCustomTemplateForClinic(before),/TESTONLY_JOB_FAILURE/);
  assert.equal(calls,3); failJob=false; await service.createCustomTemplateForClinic(before); assert.equal(calls,4);
  report.checks.push('A native recovery-job persistence failure causes zero provider calls; retry resumes exactly the not-started row after job recovery');
  const newest=await service.createCustomTemplateForClinic({...base,displayName:'TESTONLY newest',bodyText:'Hello {{nombre_paciente}}, newest version.',replaceTemplateId:replacement.row.id});
  await lists[0].update({criteria:{whatsapp_template_id:first.row.id},template_snapshot:{id:first.row.id}});
  await replacement.row.reload();
  await service._test.reconcileCustomReplacement(replacement.row,{replaceTemplateId:first.row.id,createdByUserId:2,clinicId:1});
  await lists[0].reload();assert.equal(lists[0].template_snapshot.id,first.row.id);
  assert.equal((await replacement.row.reload()).superseded_by_template_id,newest.row.id);
  report.checks.push('A delayed replacement job for a now-retired version cannot regress editable snapshots or overwrite its newer successor');
}).catch(error=>{console.error(error);process.exitCode=1;});
