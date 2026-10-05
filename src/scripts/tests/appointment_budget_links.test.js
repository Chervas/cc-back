'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
function load(name) {
  const resolved = require.resolve('../../services/' + name), localRequire = require('node:module').createRequire(resolved);
  const sandbox = { module:{ exports:{} }, require: id => id === '../../models' ? {} : localRequire(id) };
  vm.runInNewContext(fs.readFileSync(require.resolve('../../services/' + name), 'utf8'), sandbox);
  return sandbox.module.exports;
}
const links = load('budgetAppointmentLinks.service');
function fixture(overrides = {}) {
  const events = [], writes = [], appointment = { id_cita:42, paciente_id:11, clinica_id:72, estado:'info_confirmada', tratamiento_id:20, ...overrides.appointment };
  const budget = { id:8, public_id:'budget', patient_id:11, clinic_id:72, status:'accepted', current_version:1, ...overrides.budget };
  const transaction = { LOCK:{ UPDATE:'UPDATE' } };
  const db = {
    sequelize:{ transaction: fn => fn(transaction) },
    EconomicBudget:{ findOne:async () => budget },
    EconomicBudgetVersion:{ findOne:async () => ({ lines:[{ key:'line', treatment_id:20, quantity:1 }] }) },
    EconomicBudgetEvent:{ findAll:async ({ where }) => where.event_type ? events.filter(e => e.event_type === where.event_type) : events,
      create:async row => { writes.push(row); events.push(row); } },
    CitaPaciente:{ findByPk:async () => appointment, findAll:async () => [appointment] },
    AppointmentClinicalReport:{ findOne:async () => overrides.report || null, findAll:async () => overrides.report ? [{ appointment_id:42 }] : [] },
  };
  return { service:links.createService({ db }), events, writes, appointment, budget,
    args:{ publicId:'budget', appointmentId:42, lineKey:'line', expectedVersion:1, actorId:4 } };
}
test('links an existing appointment idempotently, preserving clinical and payment state', async () => {
  const f=fixture(), before=JSON.stringify(f.appointment);
  assert.equal((await f.service.link(f.args)).replayed,false);
  assert.equal((await f.service.link(f.args)).replayed,true);
  assert.equal(f.writes.length,1); assert.equal(JSON.stringify(f.appointment),before);
  assert.equal(f.writes[0].metadata.no_payment_or_clinical_effect,true);
});
test('patient and clinic scope are checked, including numeric identifiers', async () => {
  for (const appointment of [{ paciente_id:12 }, { clinica_id:73 }]) {
    const f=fixture({ appointment }); await assert.rejects(f.service.link(f.args),{ code:'budget_appointment_scope' }); assert.equal(f.writes.length,0);
  }
});
test('rejects stale budget, wrong treatment, cancelled appointment and unaccepted concepts', async () => {
  for (const [overrides,args,code] of [
    [{},{ expectedVersion:2 },'budget_version_changed'],
    [{ appointment:{ tratamiento_id:21 } },{},'budget_appointment_treatment'],
    [{ appointment:{ estado:'cancelada' } },{},'budget_appointment_treatment'],
    [{ budget:{ status:'partially_accepted' } },{},'budget_appointment_treatment'],
  ]) { const f=fixture(overrides); await assert.rejects(f.service.link({ ...f.args,...args }),{ code }); assert.equal(f.writes.length,0); }
});
test('performed association requires a final report or a legacy completed appointment, never just arrival', async () => {
  const f=fixture({ appointment:{ arrived_at:new Date(), care_started_at:new Date() } });
  await assert.rejects(f.service.link({ ...f.args,association:'performed' }),{ code:'budget_appointment_not_completed' });
  const ready=fixture({ report:{ id:3,status:'final' }, appointment:{ care_started_at:new Date() } });
  await ready.service.link({ ...ready.args,association:'performed' }); assert.equal(ready.appointment.estado,'info_confirmada');
  const plan=await ready.service.plan('budget'); assert.equal(plan.appointments[0].performed,true);
});
test('a competing budget or a full concept cannot double-book the same entitlement', async () => {
  const f=fixture(); f.events.push({ event_type:'appointment_linked', budget_id:9, metadata:{ appointment_id:42, line_key:'other', budget_version:1 } });
  await assert.rejects(f.service.link(f.args),{ code:'budget_appointment_already_linked' });
});
const payment = load('appointmentPaymentSummary.service');
test('pending payment subtracts confirmed budget allocations and applied wallet, not voided receipts or deposits', () => {
  const paid=[{ status:'confirmed', application:{ allocations:[{ target_type:'budget',amount:30 },{ target_type:'wallet',amount:50 }] } },
    { status:'voided',application:{ allocations:[{ target_type:'budget',amount:80 }] } }];
  assert.equal(payment.pendingAmount({ accepted_amount:100 },paid,[{ status:'confirmed',amount:-20 },{ status:'confirmed',amount:60 }]),50);
});
const branding=load('clinicBranding.service');
test('explicit clinic logo wins; Google fallback is local and never persisted', async () => {
  let reads=0;
  const deps={ resolveEffectiveLocations:async () => { reads++; return { locations:[{ raw_payload:{ mediaItems:[{ category:'LOGO', googleUrl:'https://example.test/logo.png' }] } }] }; } };
  assert.equal((await branding.resolveClinicAvatar({ id_clinica:72,url_avatar:'https://example.test/custom.png' },deps)).source,'clinic'); assert.equal(reads,0);
  const clinic={ id_clinica:72,url_avatar:null };
  assert.equal((await branding.resolveClinicAvatar(clinic,deps)).url,'https://example.test/logo.png'); assert.equal(clinic.url_avatar,null);
  assert.equal(branding.googleLogo([{ raw_payload:{ mediaItems:[{ category:'LOGO',googleUrl:'javascript:bad' }] } }]),null);
});
test('payment indicators are scoped to the real patient and disappear when there is no unpaid budget', async () => {
  const rows=[{ id_cita:42, paciente_id:11, clinica_id:72 },{ id_cita:43, paciente_id:12, clinica_id:72 }];
  const models={ EconomicBudgetEvent:{ findAll:async () => [{ budget_id:8,metadata:{ appointment_id:42,budget_version:1 } },{ budget_id:8,metadata:{ appointment_id:43,budget_version:1 } }] },
    PatientVoucher:{ findAll:async () => [] }, EconomicBudget:{ findAll:async () => [{ id:8,public_id:'budget',current_version:1,patient_id:11,clinic_id:72,accepted_amount:100 }] },
    EconomicPayment:{ findAll:async () => [] }, PatientWalletEntry:{ findAll:async () => [] } };
  await payment.attach(rows,models); assert.equal(rows[0].payment_summary.pending,100); assert.equal(rows[0].payment_summary.status,'pending'); assert.equal(rows[1].payment_summary,undefined);
});
test('correcting arrival to confirmed is audited and does not erase clinical work', async () => {
  const service=load('appointmentCare.service'), events=[];
  const models={ AppointmentCareEvent:{ create:async row => events.push(row) },PatientOperationalEvent:{ create:async row => events.push(row) } };
  const cita={ id_cita:42,clinica_id:72,paciente_id:11,estado:'info_confirmada',inicio:'2026-10-01T09:00:00Z',care_schedule_start:'2026-10-01T09:00:00Z',arrived_at:'2026-10-01T09:01:00Z' };
  const patch=await service.confirmedCorrection({ cita,nextStatus:'recordatorio_confirmado',actorId:4,transaction:{},models });
  assert.equal(patch.arrived_at,null); assert.equal(events[0].action,'arrival_corrected');
  cita.care_started_at='2026-10-01T09:02:00Z';
  await assert.rejects(service.confirmedCorrection({ cita,nextStatus:'info_confirmada',models }),{ code:'care_already_started' });
  assert.equal(events.length,2);
});
