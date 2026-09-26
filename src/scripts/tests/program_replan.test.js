'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { schedulingState, planRevision, resumeInfo, resumeSessions, resumeInput, assertRevision, createSeriesContext, assertSeriesContext } = require('../../lib/program-replan');
const { bookingRequest } = require('../../lib/program-booking');
const { hash } = require('../../lib/cliniccloud-import/adapter');
const { publishProgramBookings } = require('../../services/programBookingRealtime.service');
const now = new Date('2030-01-02T00:00:00Z');
function plan() { return { snapshot: { sha256: 'a'.repeat(64) }, voucher: { id: 1, clinic_id: 2, patient_id: 3 }, budget: { id: 4 }, timeZone: 'Europe/Madrid',
  sessions: ['completed','missed','reserved'].map((scheduling_status, position) => ({ key: 's'+position, label: 'Cita '+position, position, scheduling_status,
    record: { id: position+1, session_key: 's'+position, voucher_id: 1 },
    appointment: { id_cita: position+10, estado: ['completada','no_asistio','pendiente'][position], inicio: new Date('2030-01-03T10:00:00Z'), fin: new Date('2030-01-03T10:30:00Z'), import_metadata: { automation_policy: 'hold' } },
    start_at: '2030-01-03T10:00:00Z', end_at: '2030-01-03T10:30:00Z' })) }; }
test('attendance states distinguish missed, completed and cancelled without inventing consumption', () => {
  assert.equal(schedulingState(null, { estado:'no_asistio' }), 'missed');
  assert.equal(schedulingState(null, { estado:'completada' }), 'completed');
  assert.equal(schedulingState({consumption_movement_id:1},{estado:'no_asistio'}), 'completed');
  assert.equal(schedulingState(null,{estado:'cancelada'}),'pending');
});
test('resume keeps completed sessions fixed and blocks ambiguous past attendance, order and live notifications', () => {
  const p=plan(); assert.equal(resumeInfo(p,now).existing_reservations_count,1);
  assert.deepEqual(resumeSessions(p,'s1',now).map(s=>s.key),['s1','s2']);
  assert.throws(()=>resumeSessions(p,'s0',now),{code:'program_resume_changed'});
  assert.match(resumeInfo(p,new Date('2030-01-04')).blocked_reason,/asistió/);
  p.sessions[2].scheduling_status='completed'; assert.match(resumeInfo(p,now).blocked_reason,/orden clínico/);
  p.sessions[2].scheduling_status='reserved'; p.sessions[2].appointment.import_metadata={}; assert.match(resumeInfo(p,now).blocked_reason,/comunicaciones/);
});
test('revision includes actual ORM dates, status, patient, balance and notes, with stable key order', () => {
  const p=plan(), revision=planRevision(p); assertRevision(structuredClone(p),revision);
  for(const change of [q=>q.sessions[2].appointment.inicio=new Date('2030-01-03T11:00:00Z'),q=>q.voucher.patient_id++,q=>q.voucher.available_units=0,q=>q.sessions[2].appointment.estado='cancelada',q=>q.sessions[2].appointment.nota='changed']) {
    const q=structuredClone(p);change(q);assert.throws(()=>assertRevision(q,revision),{code:'program_resume_changed'});
  }
});
test('ordinary idempotency hash remains backward compatible; resume mode is explicit and hash-bound', () => {
  const p={request_key:'test-normal-booking',snapshot_sha256:'a'.repeat(64),sessions:[{key:'s1',start_at:'2030-01-03T10:00:00Z'}]};
  const old=bookingRequest(p); assert.equal(old.request_sha256,hash({snapshot_sha256:old.snapshot_sha256,sessions:old.sessions}));
  const resumed=bookingRequest({...p,mode:'resume',replan_from_key:'s1',expected_plan_revision:'b'.repeat(64)}); assert.notEqual(resumed.request_sha256,old.request_sha256);
  assert.equal(resumeInput({}),null);
  for(const value of [{mode:'resume'},{mode:'force',replan_from_key:'s1',expected_plan_revision:'b'.repeat(64)},{replan_from_key:'s1'}]) assert.throws(()=>resumeInput(value),{code:'program_resume_request_invalid'});
});
test('batch capability cannot be forged or reused for another transaction, date, patient or appointment', () => {
  const p=plan(), transaction={}, selected=[p.sessions[2]], token=createSeriesContext({transaction,plan:p,selected,series:[]});
  const args={transaction,session:selected[0].record,existing:selected[0].appointment,values:{voucher_id:1,clinica_id:2,paciente_id:3,inicio:selected[0].start_at,fin:selected[0].end_at}};
  assert.deepEqual(assertSeriesContext(token,args).series,[]);
  assert.throws(()=>assertSeriesContext({},args),/context_invalid/);
  for(const bad of [{...args,transaction:{}},{...args,existing:null},{...args,values:{...args.values,paciente_id:9}},{...args,values:{...args.values,inicio:'2030-01-03T12:00:00Z'}}]) assert.throws(()=>assertSeriesContext(token,bad),/context_invalid/);
});
test('committed program receipt emits canonical scoped events only; replay emits nothing',async()=>{
  const events=[], Op={in:Symbol('in')}; const db={Sequelize:{Op},CitaPaciente:{findAll:async options=>{
    assert.equal(options.where.clinica_id,2); return [{id_cita:10,clinica_id:2,paciente_id:3,estado:'pendiente'},{id_cita:11,clinica_id:2,paciente_id:3,estado:'reprogramada'}];
  }}};
  const io={to:room=>({emit:(name,payload)=>events.push({room,name,payload})})};
  const result={sessions:[{appointment_id:10,action:'created'},{appointment_id:11,action:'rescheduled'}]};
  await publishProgramBookings({db,io,result,clinicId:2});assert.deepEqual(events.map(e=>e.name),['appointment:created','appointment:updated']);
  assert(events.every(e=>e.room==='clinic:2'&&!('import_metadata' in e.payload)));
  await publishProgramBookings({db,io,result:{...result,replayed:true},clinicId:2});assert.equal(events.length,2);
});
