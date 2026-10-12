'use strict';
require('./fixtures/campaign_offline_runtime.cjs');
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {assertEvidence}=require('../confirm-reviewed-appointments-20261012');
const now=Date.parse('2026-10-12T12:00:00Z');
const candidate=()=>({appointmentId:78189,conversationId:7,clinicId:35,patientId:11,status:'recordatorio_enviado',
  start:'2026-10-13T13:30:00.000Z',end:'2026-10-13T13:45:00.000Z',updatedAt:'2026-10-12T07:00:00.000Z',
  scopeMatches:true,noticeDigest:'a',messages:[{id:1,digest:'b',type:'text'}],sameDayAppointments:[{id_cita:78189}],
  automationState:{status:'review',urgent:false}});
test('one human-reviewed response confirms silently; already-confirmed is idempotent',()=>{
 const a=candidate();assert.equal(assertEvidence(a,structuredClone(a),now),'confirm');
 assert.equal(assertEvidence(a,{...a,status:'recordatorio_confirmado'},now),'already_confirmed');
});
test('later messages, edited evidence, moved appointments and foreign scopes stop correction',()=>{
 for(const change of [c=>c.messages.push({id:2,digest:'new'}),c=>c.messages[0].digest='edited',c=>c.noticeDigest='changed',
  c=>c.start='2026-10-14T13:30:00.000Z',c=>c.updatedAt='2026-10-12T09:00:00.000Z',c=>c.scopeMatches=false,
  c=>c.patientId=12,c=>c.clinicId=72,c=>c.status='cambio_solicitado',c=>c.status='ha_acudido',
  c=>c.automationState.status='active',c=>c.automationState.urgent=true]){
  const a=candidate(),c=structuredClone(a);change(c);assert.throws(()=>assertEvidence(a,c,now));
 }
});
test('two appointments require a reaction anchored to the exact reminder; never confirm both',()=>{
 const a=candidate();a.sameDayAppointments.push({id_cita:77805});assert.throws(()=>assertEvidence(a,a,now),/multiple/);
 a.targetedReaction=true;a.messages[0]={id:1,digest:'b',type:'reaction',reactionTargetsNotice:true};
 assert.equal(assertEvidence(a,a,now),'confirm');
 assert.throws(()=>assertEvidence(a,{...a,messages:[{...a.messages[0],reactionTargetsNotice:false}]},now),/multiple/);
});
test('operator cannot enqueue sends, consents, reviews or status-event recipes',()=>{
 const source=fs.readFileSync(require.resolve('../confirm-reviewed-appointments-20261012'),'utf8');
 assert.doesNotMatch(source,/enqueueExecutionForCita|syncScheduledTriggersForCita|sendWhatsapp|sendWhatsApp|\.sendMessage\(|\.enqueue\(/);
 assert.match(source,/mutateAppointmentBooking/);assert.match(source,/recordAppointmentStatusChange/);
 assert.match(source,/isolationLevel: 'READ COMMITTED'/);
});
