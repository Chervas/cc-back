'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {planEntry,validatePreservedNodeConfigs}=require('../../lib/appointment-single-notice-publication');

function source(){
  return {id:1,public_id:'TESTONLY_notice',template_key:'env_o_de_datos_de_la_cita_tras_agendar__clinic_7',
    clinic_id:7,group_id:null,version:1,name:'TESTONLY notice',published_at:'2030-01-01T00:00:00Z',
    trigger_type:'appointment_created',entry_node_id:'start',nodes:[
      {id:'start',type:'trigger/appointment_created',outputs:{on_success:'first'}},
      {id:'first',type:'action/send_whatsapp',config:{template_name:'TESTONLY_first'},outputs:{on_success:'early'}},
      {id:'early',type:'delay/wait_response',config:{listens_to_node_id:'first',timeout_duration:2,timeout_unit:'hours'},outputs:{on_response:'decision',on_timeout:'second'}},
      {id:'second',type:'action/send_whatsapp',config:{template_name:'clinicaclick_confirmacion_datos_cita_48_sin_respuesta'},outputs:{on_success:'late'}},
      {id:'late',type:'delay/wait_response',config:{listens_to_node_id:'second',timeout_duration:12,timeout_unit:'hours'},outputs:{on_response:'decision',on_timeout:null}},
      {id:'decision',type:'condition/field_check',config:{mode:'multi_branch',rules:[{id:'yes',comparison_rules:[{
        left_ref:{source:'context',path:'TESTONLY',value_type:'boolean'},operator:'equals',right_value:true}]}]},outputs:{yes:'end',on_else:'review'}},
      {id:'review',type:'action/send_system_notification',config:{title:'TESTONLY review',message:'TESTONLY message',
        assignee_type:'role',assignee_id:'admin'},outputs:{on_success:'end'}},
      {id:'end',type:'control/end',outputs:{}},
    ]};
}
const required=(node,key)=>({code:'node_config_required',message:'TESTONLY required '+key,
  details:{node_id:node.id,node_type:node.type,key}});
const generic=async nodes=>({ok:false,errors:nodes.flatMap(node=>node.type==='action/send_whatsapp'
  ?[required(node,'communication_scope')]:node.type==='condition/field_check'
    ?[required(node,'left_ref'),required(node,'operator')]:node.type==='action/send_system_notification'
      ?[required(node,'display_mode'),required(node,'alert_level')]:[])});

test('only the exact reduced graph inherits known generic omissions on unchanged published nodes',async()=>{
  const before=source(),plan=planEntry(before),snapshot=structuredClone(before),candidate=structuredClone(plan.body.nodes);
  const checked=await validatePreservedNodeConfigs(before,candidate,generic);
  assert.deepEqual(checked.errors,[]);assert.equal(checked.ok,true);assert.equal(checked.inherited_required_errors,5);
  assert.deepEqual(before,snapshot);assert.deepEqual(candidate,plan.body.nodes);
});
test('simple comparators cannot inherit missing references or operators',async()=>{
  const before=source();before.nodes.find(n=>n.id==='decision').config.mode='simple';
  const result=await validatePreservedNodeConfigs(before,planEntry(before).body.nodes,generic);
  assert.deepEqual(result.errors.map(e=>e.details.key),['left_ref','operator']);
  assert.equal(result.ok,false);
});
test('mode-specific rule errors and template-contract errors remain blocking even if already present',async()=>{
  const before=source(),nodes=planEntry(before).body.nodes;
  const invalid={code:'node_config_invalid',message:'TESTONLY invalid rule',details:{node_id:'decision',key:'rules[0].left_ref'}};
  const contract={code:'node_config_invalid',message:'TESTONLY missing template variable',details:{node_id:'first',key:'variables'}};
  const result=await validatePreservedNodeConfigs(before,nodes,async list=>({errors:[...(await generic(list)).errors,invalid,contract]}));
  assert.deepEqual(result.errors,[invalid,contract]);assert.equal(result.ok,false);
});
test('new omissions not present in the published source are never inherited',async()=>{
  const before=source(),nodes=planEntry(before).body.nodes;
  const extra=required(nodes.find(n=>n.id==='decision'),'left_ref');let calls=0;
  const result=await validatePreservedNodeConfigs(before,nodes,async()=>({errors:++calls===1?[extra]:[]}));
  assert.deepEqual(result.errors,[extra]);assert.equal(result.ok,false);
});
test('missing fields outside the explicit legacy keys remain blocking',async()=>{
  const before=source(),nodes=planEntry(before).body.nodes;
  const extra=required(nodes.find(n=>n.id==='first'),'template_id');
  const result=await validatePreservedNodeConfigs(before,nodes,async()=>({errors:[extra]}));
  assert.deepEqual(result.errors,[extra]);assert.equal(result.inherited_required_errors,0);
});
test('notification text and recipient requirements cannot be waived with presentation defaults',async()=>{
  const before=source(),nodes=planEntry(before).body.nodes,notification=nodes.find(n=>n.id==='review');
  const extras=[required(notification,'title'),required(notification,'assignee_id')];
  const result=await validatePreservedNodeConfigs(before,nodes,async list=>({errors:[...(await generic(list)).errors,...extras]}));
  assert.deepEqual(result.errors,extras);assert.equal(result.ok,false);
});
test('even a harmless-looking edit to an original node is rejected before validation',async()=>{
  const before=source(),nodes=planEntry(before).body.nodes;nodes.find(n=>n.id==='first').config.communication_scope='transactional';
  await assert.rejects(validatePreservedNodeConfigs(before,nodes,()=>assert.fail('must not validate changed graph')),
    {code:'single_notice_candidate_changed'});
});
test('other families and unpublished sources cannot use this compatibility path',async()=>{
  const before=source(),nodes=planEntry(before).body.nodes;
  await assert.rejects(validatePreservedNodeConfigs({...before,template_key:'TESTONLY_other_flow'},nodes,generic),/source_invalid/);
  await assert.rejects(validatePreservedNodeConfigs({...before,published_at:null},nodes,generic),/source_invalid/);
});
test('already-valid nodes retain ordinary validation results without a second lookup',async()=>{
  const before=source(),nodes=planEntry(before).body.nodes;let calls=0;const valid={ok:true,errors:[]};
  assert.equal(await validatePreservedNodeConfigs(before,nodes,async()=>{calls++;return valid}),valid);
  assert.equal(calls,1);
});
