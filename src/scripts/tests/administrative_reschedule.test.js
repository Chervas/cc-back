'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const policy=require('../../lib/appointment-reschedule-reason');
const {buildAdministrativeRescheduleFlow,STATUS_NODE}=require('../../lib/administrative-reschedule-flow');
const engine=fs.readFileSync(require.resolve('../../services/flowEngineV2.service'),'utf8');
const controller=fs.readFileSync(require.resolve('../../controllers/citas.controller'),'utf8');
function extract(source,name){const start=source.search(new RegExp(`\\n(?:async )?function ${name}\\(`));assert(start>=0,name);const rest=source.slice(start+1);const end=rest.search(/\n(?:async )?function \w+/);assert(end>0,name);return rest.slice(0,end);}
const cleanString=v=>typeof v==='string'?v.trim():null;
function sourceGraph(){
 if(process.env.ADMIN_RESCHEDULE_SOURCE)return JSON.parse(fs.readFileSync(process.env.ADMIN_RESCHEDULE_SOURCE));
 return {trigger_type:'appointment_rescheduled',entry_node_id:'N1',trigger_config:{reschedule_reasons:['patient_request','clinic_schedule']},nodes:[
  {id:'N1',type:'trigger/appointment_rescheduled',outputs:{on_success:'N70'}},
  {id:'N70',type:'condition/field_check',config:{mode:'multi_branch',branch_rules:[['patient_request','N72'],['clinic_schedule','N2']].map(([reason])=>({id:'branch_'+reason,comparison_rules:[{left_ref:{source:'trigger_data',path:'reschedule_reason',value_type:'string'},operator:'equals',right_value:reason}]}))},outputs:{branch_patient_request:'N72',branch_clinic_schedule:'N2',on_else:'N71'}},
  {id:'N72',type:'action/send_whatsapp',outputs:{on_success:null}},{id:'N2',type:'action/send_whatsapp',outputs:{on_success:null}},{id:'N71',type:'action/send_system_notification',outputs:{on_success:null}},
 ]};
}
test('extends the graph without changing existing messages, AI, waits or non-administrative branches',()=>{
 const source=sourceGraph(),before=JSON.stringify(source),next=buildAdministrativeRescheduleFlow(source);
 assert.equal(JSON.stringify(source),before);assert.equal(next.nodes.length,source.nodes.length+1);
 for(const n of source.nodes)if(n.id!=='N70')assert.deepEqual(next.nodes.find(x=>x.id===n.id),n);
 assert.deepEqual(buildAdministrativeRescheduleFlow(next),next);
 const s={cleanString,buildValidationError:(code,message,extra)=>({code,message,...extra})};vm.createContext(s);
 const c=fs.readFileSync(require.resolve('../../controllers/automationsV2.controller'),'utf8');vm.runInContext(extract(c,'validateFlowGraph'),s);
 assert.equal(s.validateFlowGraph(next).ok,true,JSON.stringify(s.validateFlowGraph(next)));
});
test('the real native condition routes all three reasons and the unknown fallback correctly',()=>{
 const graph=buildAdministrativeRescheduleFlow(sourceGraph()),origin=graph.nodes.find(n=>n.id==='N70');
 const s={cleanString,isObject:v=>v!==null&&typeof v==='object',getByPath:(v,p)=>p.split('.').reduce((a,k)=>a?.[k],v),resolveTemplateValue:v=>v,
  FIELD_CHECK_LEFT_REF_SOURCES:new Set(['trigger_data','context','node_output','manual']),FIELD_CHECK_VALUE_TYPES:new Set(['string','number','boolean']),FIELD_CHECK_OPERATOR_TYPE_COMPAT:{string:['equals','not_equals','contains']},FIELD_CHECK_LOGIC_CONNECTORS:new Set(['and','or'])};vm.createContext(s);
 for(const name of ['toBool','isFieldCheckOperatorCompatible','evaluateSimpleFieldCheckRule','normalizeFieldCheckComparisonRules','evaluateSimpleFieldChecks','normalizeFieldCheckBranchRules','evaluateMultiBranchFieldCheck'])vm.runInContext(extract(engine,name),s);
 for(const [reason,target] of [['patient_request','N72'],['clinic_schedule','N2'],['administrative_error',STATUS_NODE],['unknown','N71']]){
  const result=s.evaluateMultiBranchFieldCheck(origin.config,{trigger:{data:{reschedule_reason:reason}}});assert.equal(origin.outputs[result.next_output_key],target);
 }
 const end=graph.nodes.find(n=>n.id===STATUS_NODE);assert.equal(end.config.new_status,'info_confirmada');assert(Object.values(end.outputs).every(x=>x===null));
});
test('silent correction cannot call WhatsApp or email even if a customized graph reaches a send node',async()=>{
 const s={require:name=>{assert.equal(name,'../lib/appointment-reschedule-reason');return policy;},readOutputTarget:(n,k)=>n.outputs[k]};vm.createContext(s);
 for(const name of ['handleSendWhatsapp','handleSendEmail']){
  vm.runInContext(extract(engine,name),s);
  const result=await s[name]({outputs:{on_success:null}},{trigger:{type:'appointment_rescheduled',data:{reschedule_reason:'administrative_error'}}},{});
  assert.equal(result.output.status,'skipped_administrative_reschedule');assert.equal(result.next_node_id,null);
 }
});
test('later reminders, patient requests and ordinary clinic reschedules are not muted',()=>{
 assert.equal(policy.statusForReschedule('administrative_error','recordatorio_confirmado'),'info_confirmada');
 for(const reason of ['patient_request','clinic_schedule']){assert.equal(policy.statusForReschedule(reason,''),'reprogramada');assert.equal(policy.isSilentReschedule({trigger:{type:'appointment_rescheduled',data:{reschedule_reason:reason}}}),false);}
 assert.equal(policy.isSilentReschedule({trigger:{type:'appointment_reminder_window'},appointment:{reschedule_reason:'administrative_error'}}),false);
});
test('older templates do not treat administrative corrections as ordinary clinic changes',()=>{
 const source=fs.readFileSync(require.resolve('../../services/appointmentAutomationV2Runtime.service'),'utf8');const s={cleanString,normalizeStringArray:v=>Array.isArray(v)?v:[]};vm.createContext(s);vm.runInContext(extract(source,'isRescheduleTemplateEligible'),s);
 assert.equal(s.isRescheduleTemplateEligible({trigger_config:null},{reschedule_reason:'administrative_error'}),false);
 assert.equal(s.isRescheduleTemplateEligible({trigger_config:null},{reschedule_reason:'clinic_schedule'}),true);
 assert.equal(s.isRescheduleTemplateEligible(buildAdministrativeRescheduleFlow(sourceGraph()),{reschedule_reason:'administrative_error'}),true);
});
function httpFixture({booking=true,deny=false}={}){
 const stored={id_cita:101,clinica_id:10,paciente_id:20,estado:'info_enviada',inicio:new Date('2026-10-13T09:00Z'),fin:new Date('2026-10-13T09:30Z'),doctor_id:30,instalacion_id:40,import_metadata:{notification_suppression:{day_before:true}}};
 const calls=[],row=()=>({...stored,toJSON(){return {...stored}},async update(values){Object.assign(stored,values);return row()}});
 const runtime=Object.fromEntries(['cancelActiveExecutionsForCita','enqueueExecutionForCita','syncScheduledTriggersForCita'].map(name=>[name,async(cita,opts)=>calls.push({name,state:cita.estado,opts})]));
 const s={exports:{},console,Date,Number,String,asyncHandler:f=>f,CitaPaciente:{findByPk:async()=>row()},denyAppointmentManageAccessIfNeeded:async(req,res)=>deny?(res.status(403).json({}),true):false,
  require:name=>name==='../lib/appointment-reschedule-reason'?policy:{assertClinicalCompletion:async()=>{}},bookingCapabilities:()=>({simple:booking,multi:true}),normalizeAdditionalStaff:()=>null,additionalStaffPayload:()=>[],parseBool:Boolean,
  checkDisponibilidadCanonica:async()=>({resourceConflicts:[],legacyConflicts:[],canForce:false}),CITA_ESTADOS_VALIDOS:new Set(['pendiente','reprogramada','info_confirmada','recordatorio_confirmado']),
  mutateAppointmentBooking:async opts=>{calls.push({name:'booking',values:opts.appointmentValues});return opts.persist({values:opts.appointmentValues,existing:row(),transaction:{}})},
  db:{sequelize:{transaction:async(_,f)=>f({LOCK:{UPDATE:'UPDATE'}})}},recordAppointmentStatusChange:async x=>calls.push({name:'activity',value:x}),processAppointmentLeadMilestones:async()=>{},patientDirectionService:{handleAppointmentChange:async()=>{}},
  appointmentAutomationV2Runtime:runtime,appointmentNotificationCleanup:{markAutomationNotificationsReadForAppointment:async()=>{}},completeAppointmentAutomationReviews:async()=>{},ensureConsentPackageAndAutomation:async()=>calls.push({name:'consent_communication'}),
  Paciente:{},LeadIntake:{},Clinica:{},Instalacion:{},Tratamiento:{},attachFlowSummaryToCitas:async()=>{},attachUnreadCountsToCitas:async()=>{},consentimientosService:{attachConsentSummaryToCitas:async()=>{}},emitAppointmentSocketEvent:()=>{},protectAppointmentsForRequest:async(_,v)=>v};
 vm.createContext(s);vm.runInContext(controller.slice(controller.indexOf('exports.reagendarCita ='),controller.indexOf('exports.resolveImportedTreatment =')),s);
 return {stored,calls,async run(body){const res={code:200,status(c){this.code=c;return this},json(v){this.body=v;return this}};await s.exports.reagendarCita({params:{id:'101'},body,userData:{userId:7}},res);return res}};
}
for(const booking of [true,false])test(`real reschedule controller persists the confirmed state, reason and future scheduling (booking=${booking})`,async()=>{
 const f=httpFixture({booking}),result=await f.run({inicio:'2026-10-14T10:00Z',fin:'2026-10-14T10:30Z',reschedule_reason:'administrative_error',estado:'recordatorio_confirmado'});
 assert.equal(result.code,200);assert.equal(f.stored.estado,'info_confirmada');assert.equal(f.stored.reschedule_reason,'administrative_error');assert.equal(f.stored.inicio.toISOString(),'2026-10-14T10:00:00.000Z');
 assert.equal(f.stored.doctor_id,30);assert.equal(f.stored.instalacion_id,40);assert.deepEqual(f.stored.import_metadata,{notification_suppression:{day_before:true}});
 assert(f.calls.some(c=>c.name==='syncScheduledTriggersForCita'));assert(f.calls.some(c=>c.name==='cancelActiveExecutionsForCita'));assert(!f.calls.some(c=>c.name==='consent_communication'));
 assert.equal(f.calls.find(c=>c.name==='activity').value.metadata.reschedule_reason,'administrative_error');
});
test('unauthorized and invalid reasons cannot mutate an appointment',async()=>{
 const f=httpFixture({deny:true});assert.equal((await f.run({reschedule_reason:'administrative_error'})).code,403);assert.equal(f.stored.estado,'info_enviada');
 const g=httpFixture();assert.equal((await g.run({reschedule_reason:'unknown'})).code,400);assert.equal(g.calls.length,0);
});
for(const reason of ['patient_request','clinic_schedule',undefined])test(`ordinary reschedule keeps its notification and consent path (${reason || 'legacy default'})`,async()=>{
 const f=httpFixture(),result=await f.run({inicio:'2026-10-14T10:00Z',fin:'2026-10-14T10:30Z',...(reason?{reschedule_reason:reason}:{})});
 assert.equal(result.code,200);assert.equal(f.stored.estado,'reprogramada');assert.equal(f.stored.reschedule_reason,reason||'clinic_schedule');
 assert(f.calls.some(c=>c.name==='consent_communication'));assert(f.calls.some(c=>c.name==='enqueueExecutionForCita'));
});
