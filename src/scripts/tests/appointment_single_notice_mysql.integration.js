'use strict';
const assert=require('node:assert/strict'),D=require('sequelize'),fs=require('node:fs'),vm=require('node:vm');
const {withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');
const {loadSource}=require('./fixtures/business_profile_flow_runtime.fixture');
const notice=require('../../lib/appointment-single-notice-flow');

withIsolatedCampaignMysql(async({sql,models:db,report})=>{
  require('./fixtures/security_offline_runtime.cjs');db.Sequelize=D;
  for(const file of ['automationflowtemplatev2','flowexecutionv2','flowexecutionlogv2','message','citapaciente']){
    const model=require('../../../models/'+file)(sql,D);db[model.name]=model;
  }
  db.Conversation=sql.define('Conversation',{id:{type:D.INTEGER,primaryKey:true},clinic_id:D.INTEGER,patient_id:D.INTEGER,
    lead_id:D.INTEGER,channel:D.STRING,contact_id:D.STRING,last_message_at:D.DATE,last_inbound_at:D.DATE,unread_count:D.INTEGER},{tableName:'Conversations'});
  db.FlowExecutionV2.associate(db);await sql.sync();
  await db.Conversation.create({id:1,clinic_id:1,patient_id:1,channel:'whatsapp',contact_id:'TESTONLY'});
  await db.CitaPaciente.create({id_cita:1,clinica_id:1,paciente_id:1,estado:'info_enviada',inicio:new Date('2030-01-01T12:00:00Z'),fin:new Date('2030-01-01T12:30:00Z')});
  const nodes=[
    {id:'start',type:'trigger/appointment_created',outputs:{on_success:'first'}},
    {id:'first',type:'action/send_whatsapp',config:{template_name:'TESTONLY_first'},outputs:{on_success:'early'}},
    {id:'early',type:'delay/wait_response',config:{listens_to_node_id:'first',timeout_duration:2,timeout_unit:'hours'},outputs:{on_response:'ai_early',on_timeout:'second'}},
    {id:'second',type:'action/send_whatsapp',config:{template_name:'clinicaclick_confirmacion_datos_cita_48_sin_respuesta_v1'},outputs:{on_success:'late'}},
    {id:'late',type:'delay/wait_response',config:{listens_to_node_id:'second',timeout_duration:12,timeout_unit:'hours'},outputs:{on_response:'ai_late',on_timeout:null}},
    ...['early','late'].map(key=>({id:'ai_'+key,type:'condition/ai_analysis',config:{instruction:'TESTONLY existing independent inference',
      context_sources:[{key:'last_response',path:'{{last_response}}'}],output_fields:[{name:'ready',type:'boolean'}]},outputs:{on_success:'end'}})),
    {id:'end',type:'control/end',outputs:{}}
  ];
  const values={public_id:'TESTONLY_notice',template_key:'env_o_de_datos_de_la_cita_tras_agendar__clinic_1',version:1,
    name:'TESTONLY single notice',trigger_type:'appointment_created',is_active:true,clinic_id:1,entry_node_id:'start',nodes,published_at:new Date(),created_by:1};
  const old=await db.AutomationFlowTemplateV2.create(values);
  const latest=await db.AutomationFlowTemplateV2.create({...values,...notice.buildSingleNoticeFlow(values),version:2});
  const stop=require('../../lib/automation-runtime-stop');let seq=0,aiCalls=0,transportCalls=0;
  const engine=loadSource('flowEngineV2.service',{'../../models':db,'./socket.service':{getIO:()=>null},'./queue.service':{},
    './jobRequests.service':{getCurrentRuntimeNamespace:()=> 'dev'},'./marketingBulkSends.service':{normalizeWhatsappPhone:v=>v},
    './conversationPendingReply.service':{emitAutomationResponseProcessing(){}},
    './aiOrchestrator.service':{analyzeStructured:async()=>{aiCalls++;return {ready:true};}},
    './whatsapp.service':{sendMessage:async()=>{transportCalls++;throw Error('TESTONLY unexpected transport');}},
  },{JOB_RUNTIME_NAMESPACE:'dev',RUNTIME_ROLE:'api'});
  async function execution(current='early',options={}){
    const firstAt=new Date(Date.now()-3*3600000).toISOString();
    const e=await db.FlowExecutionV2.create({idempotency_key:'TESTONLY_'+ ++seq,template_version_id:old.id,created_by:1,
      clinic_id:1,trigger_type:'appointment_created',trigger_entity_type:'appointment',trigger_entity_id:1,status:'waiting',
      current_node_id:current,context:{appointment:{id:1,clinica_id:1,paciente_id:1},conversation:{id:1},outputs:{
        first:{message_id:10,conversation_id:1,message_preview:'TESTONLY first question',effective_send_at:firstAt,at:firstAt}}},
      waiting_meta:{type:'delay/wait_response',runtime_namespace:'dev',listens_to_node_id:current==='early'?'first':'second',pending_response_message_ids:[999]},
      wait_until:new Date(Date.now()-1000),...options});
    return e;
  }
  const timeout=await execution();await engine.runExecution(timeout.id,{resumeMode:'timeout'});await timeout.reload();
  assert.equal(timeout.status,'waiting',timeout.last_error);assert.equal(timeout.current_node_id,'late');
  assert.equal(timeout.waiting_meta.listens_to_node_id,'first');
  assert.equal(new Date(timeout.wait_until).getTime(),Math.floor((new Date(timeout.context.outputs.first.effective_send_at).getTime()+14*3600000)/1000)*1000);
  const response=await db.Message.create({conversation_id:1,direction:'inbound',message_type:'text',content:'TESTONLY yes',status:'delivered'});
  for(const e of [await execution('early'),await execution('late'),await execution('second')]){
    await engine.runExecution(e.id,{resumeMode:'response',responseText:'TESTONLY yes',inboundMessageId:response.id});await e.reload();
    assert.equal(e.status,'completed',e.last_error);assert.equal(e.context.last_response_context.listens_to_node_id,'first');
    assert.equal(e.context.last_prompt,'TESTONLY first question');
    assert(['early','late'].includes(e.context.last_response_context.wait_node_id));
  }
  const buffered=await execution('late');await engine.runExecution(buffered.id,{resumeMode:'timeout'});await buffered.reload();
  assert.deepEqual(buffered.waiting_meta.pending_response_message_ids,[999]);assert.equal(buffered.waiting_meta.listens_to_node_id,'first');
  assert.equal(buffered.status,'waiting');
  report.checks.push('Native engine SQL: silence follows original late-response branch without another send; early, late and queued-second replies retain first-message context; persisted response buffers survive cutover');

  for(const evidence of [{status:'delivered',metadata:{wamid:'TESTONLY_accepted'}},{status:'sending',metadata:{outcome_unknown:true}}]){
    const e=await execution('late');
    const m=await db.Message.create({conversation_id:1,direction:'outbound',message_type:'template',content:'TESTONLY second',...evidence,
      metadata:{...evidence.metadata,source:'automations_v2',execution_id:e.id,node_id:'second'}});
    await e.update({context:{...e.context,outputs:{...e.context.outputs,second:{message_id:m.id,conversation_id:1,message_preview:'TESTONLY second real question',status:'waiting'}}}});
    await engine.runExecution(e.id,{resumeMode:'response',responseText:'TESTONLY yes',inboundMessageId:response.id});await e.reload();
    assert.equal(e.status,'completed',e.last_error);assert.equal(e.context.last_response_context.listens_to_node_id,'second');
    assert.equal(e.context.last_prompt,'TESTONLY second real question');
  }
  const queued=await execution('second');
  const message=await db.Message.create({conversation_id:1,direction:'outbound',message_type:'template',content:'TESTONLY queued',status:'pending',
    metadata:{source:'automations_v2',execution_id:queued.id,node_id:'second'}});
  await assert.rejects(stop.assertMessageCanDispatch(message.id),{code:'automation_silence_followup_retired'});
  await assert.rejects(stop.prepareMessageForDispatch(message,{status:'sending'}),{code:'automation_silence_followup_retired'});
  await message.reload();assert.equal(message.status,'failed');assert.equal(message.metadata.cancellation_reason,'automation_silence_followup_retired');
  const allowed=await db.Message.create({conversation_id:1,direction:'outbound',message_type:'template',content:'TESTONLY first allowed',status:'pending',
    metadata:{source:'automations_v2',execution_id:queued.id,node_id:'first'}});
  await stop.assertMessageCanDispatch(allowed.id);
  await sql.transaction(async transaction=>{
    assert.equal(await stop.publicationActivation(latest,{preserve_activation:true,expected_published_version:2},transaction),true);
  });
  await latest.update({is_active:false});
  await sql.transaction(async transaction=>{
    assert.equal(await stop.publicationActivation(latest,{preserve_activation:true,expected_published_version:2},transaction),false);
    await assert.rejects(stop.publicationActivation(latest,{preserve_activation:true,expected_published_version:1},transaction),{code:'automation_publication_conflict',statusCode:409});
    assert.equal(await stop.publicationActivation(latest,{},transaction),true);
  });
  await latest.update({is_active:true});
  report.checks.push('Actual Message rows: accepted/unknown second outcomes retain real correlation; both final dispatch boundaries reject and cancel an unsent retired message, first send allowed; publication preserves off/on and rejects stale version');
  for(let i=0;i<120;i++){
    const e=await execution(i%2?'early':'late');
    await engine.runExecution(e.id,{resumeMode:'response',responseText:'TESTONLY yes '+i,inboundMessageId:response.id});await e.reload();
    assert.equal(e.status,'completed',e.last_error);assert.equal(e.context.last_response_context.listens_to_node_id,'first');
  }
  assert.equal(aiCalls,125);assert.equal(transportCalls,0);assert.equal((await db.CitaPaciente.findByPk(1)).estado,'info_enviada');
  report.checks.push('120 repeated native response executions on old pinned versions complete with simulated inference, zero transport calls and zero clinical mutations; prompts/model are not changed or evaluated by this fixture');

  // Real create/publish controllers and InnoDB, with provider/configuration
  // validators isolated. Graph validation is the actual native implementation.
  const controller=fs.readFileSync(require.resolve('../../controllers/automationsV2.controller'),'utf8');
  const native={};const cleanString=v=>String(v??'').trim()||null;
  const sanitizeTemplateKey=v=>String(v||'').toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'');
  const context={exports:native,console:{error(){}},structuredClone,db,Op:D.Op,AutomationFlowTemplateV2:db.AutomationFlowTemplateV2,
    Clinica:{findOne:async()=>({grupoClinicaId:99})},cleanString,sanitizeTemplateKey,buildTemplateKey:({templateKey})=>sanitizeTemplateKey(templateKey),
    parseIntOrNull:v=>Number(v)||null,parseBool:(v,fallback)=>v??fallback,
    resolveAccess:async()=>({is_admin:true,user_id:1}),hasScopeAccess:()=>true,assertCreateScopeAllowed:()=>true,
    normalizeNodesInput:()=>assert.fail('Single-notice publication must not rewrite old comparators'),
    collectUnsupportedNodeTypes:()=>[],resolveTriggerTypeForTemplate:({explicitTriggerType})=>({ok:true,trigger_type:explicitTriggerType}),
    normalizeTriggerConfigForTemplate:()=>({ok:true,trigger_config:{TESTONLY_do_not_install:true}}),
    applyTriggerConfigToNodes:()=>assert.fail('Single-notice publication must keep original trigger node'),
    resolveTriggerNode:({nodes,entryNodeId})=>nodes.find(n=>n.id===entryNodeId),isTriggerSelectionPendingConfig:()=>false,
    validateNodeConfigs:async nodes=>({errors:nodes.filter(n=>n.type==='action/send_whatsapp'&&!n.config?.communication_scope)
      .map(n=>({code:'node_config_required',message:'TESTONLY legacy communication scope',
        details:{node_id:n.id,node_type:n.type,key:'communication_scope'}}))}),
    buildValidationError:(code,message,details)=>({code,message,details}),
    findAppointmentCreatedTreatmentConflict:async()=>null,findMessageReceivedTriggerConflict:async()=>null,findAppointmentReminderTriggerConflict:async()=>null,
    loadClinicNameMapFromRows:async()=>new Map(),loadCatalogBindingMapForRows:async()=>new Map(),loadLatestActivePublishedVersionMap:async()=>new Map(),
    mapTemplateWithLifecycle:row=>displayProjection(row.toJSON()),resolveTemplateFamilyWhere:async ref=>({public_id:ref}),
    runScheduledTemplateBackfill:async row=>({skipped:!row.is_active}),
    require:name=>{if(name==='../lib/automation-runtime-stop')return stop;
      if(name==='../lib/appointment-single-notice-publication')return require('../../lib/appointment-single-notice-publication');
      if(name==='../lib/patient-mobile-verification')return require('../../lib/patient-mobile-verification');
      assert.fail('Unexpected native publication dependency '+name);},
  };
  const graphStart=controller.indexOf('function validateFlowGraph('),graphEnd=controller.indexOf('\nfunction ',graphStart+10);
  context.validateFlowGraph=vm.runInNewContext('('+controller.slice(graphStart,graphEnd)+')',context);
  for(const name of ['createTemplateDraft','publishTemplateVersion']){
    const start=controller.indexOf('exports.'+name+' ='),end=controller.indexOf('\nexports.',start+10);
    vm.runInNewContext(controller.slice(start,end),context);
  }
  const ids=Object.fromEntries(nodes.map((node,i)=>[node.id,'N'+(i+1)]));
  const validNodes=nodes.map(node=>({...node,id:ids[node.id],config:{...node.config,...(node.config?.listens_to_node_id?{listens_to_node_id:ids[node.config.listens_to_node_id]}:{})},
    outputs:Object.fromEntries(Object.entries(node.outputs).map(([key,id])=>[key,id?ids[id]:null]))}));
  const source=await db.AutomationFlowTemplateV2.create({...values,public_id:'TESTONLY_shared_ref',template_key:'env_o_de_datos_de_la_cita_tras_agendar__clinic_7',
    entry_node_id:'N1',nodes:validNodes,clinic_id:7,is_active:false,trigger_config:{TESTONLY_original:true}});
  const foreign=await db.AutomationFlowTemplateV2.create({...values,public_id:source.public_id,clinic_id:8,
    template_key:'env_o_de_datos_de_la_cita_tras_agendar__clinic_8',entry_node_id:'N1',nodes:validNodes,is_active:true});
  const publication=require('../../lib/appointment-single-notice-publication'),entry=publication.planEntry(source.toJSON());
  function displayProjection(row){
    const stored_graph_hash=publication.hash({entry_node_id:row.entry_node_id,trigger_type:row.trigger_type,nodes:row.nodes});
    return {...row,stored_graph_hash,nodes:row.nodes.map(n=>({...n,config:{...n.config,TESTONLY_display_default:true}}))};
  }
  let writes=0;
  async function request(method,url,body){
    if(method==='GET')return {data:await db.AutomationFlowTemplateV2.findAll({where:{public_id:source.public_id}}).then(rows=>rows.map(row=>displayProjection(row.toJSON())))};
    writes++;let result,status=200;
    const res={status(code){status=code;return this;},json(value){result=value;return this;}};
    if(url.endsWith('/publish'))await native.publishTemplateVersion({params:{template_ref:source.public_id,version:url.split('/').at(-2)},body},res);
    else await native.createTemplateDraft({body},res);
    assert.equal(status,url.endsWith('/publish')?200:201,JSON.stringify(result));return result;
  }
  const published=await publication.publishEntry(entry,request);assert.equal(published.is_active,false);assert.equal(published.version,2);
  await foreign.reload();assert.equal(foreign.is_active,true);
  const installed=await db.AutomationFlowTemplateV2.findOne({where:{template_key:source.template_key,version:2}});
  assert.deepEqual(installed.trigger_config,source.trigger_config);assert.equal(publication.hash(installed.nodes),publication.hash(entry.body.nodes));
  assert.equal(installed.group_id,null,'An old clinic family must not inherit its newly assigned group during versioning');
  assert.equal((await publication.publishEntry(entry,request)).skipped,true);assert.equal(writes,2);
  const tampered=structuredClone(entry.body);tampered.nodes.find(node=>node.type==='condition/ai_analysis').config.instruction='TESTONLY forbidden change';
  assert.throws(()=>publication.preservedNodes(source.toJSON(),tampered),{code:'single_notice_candidate_changed'});
  report.checks.push('Native draft/publish controllers on owned SQL preserve exact scoped family, original trigger, inactive switch, all AI/decision configs and another clinic sharing the public ref; inherited scope omissions on unchanged published nodes are allowed without defaults, rerun no-ops and altered prompt is rejected before publication');
}).catch(error=>{console.error(error);process.exitCode=1;});
