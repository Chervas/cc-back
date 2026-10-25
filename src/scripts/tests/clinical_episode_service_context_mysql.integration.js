'use strict';
const assert = require('node:assert/strict'), { DataTypes: D, Sequelize } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
withIsolatedCampaignMysql(async ({ sql, models: db, report }) => {
  db.Clinica = sql.define('Clinica', { id_clinica: { type: D.INTEGER, primaryKey: true }, configuracion: D.JSON, grupoClinicaId: D.INTEGER }, { tableName: 'Clinicas', timestamps: false });
  db.Paciente = sql.define('Paciente', { id_paciente: { type: D.INTEGER, primaryKey: true }, public_id: D.STRING, clinica_id: D.INTEGER }, { tableName: 'Pacientes', timestamps: false });
  db.PacienteClinica = sql.define('PacienteClinica', { id: { type: D.INTEGER, primaryKey: true }, paciente_id: D.INTEGER, clinica_id: D.INTEGER }, { timestamps: false });
  db.UsuarioClinica = sql.define('UsuarioClinica', { id: { type: D.INTEGER, primaryKey: true }, id_usuario: D.INTEGER, id_clinica: D.INTEGER, estado_invitacion: D.STRING, rol_clinica: D.STRING, subrol_clinica: D.STRING }, { timestamps: false });
  db.Tratamiento = sql.define('Tratamiento', { id_tratamiento: { type: D.INTEGER, primaryKey: true }, nombre: D.STRING, disciplina: D.STRING, origen: D.STRING, clinica_id: D.INTEGER,
    grupo_clinica_id: D.INTEGER, activo: D.BOOLEAN, eliminado_por_clinica: D.JSON, clinical_config: D.JSON }, { tableName: 'Tratamientos', timestamps: false });
  db.CitaPaciente = sql.define('CitaPaciente', { id_cita: { type: D.INTEGER, primaryKey: true }, clinica_id: D.INTEGER, paciente_id: D.INTEGER, doctor_id: D.INTEGER, tratamiento_id: D.INTEGER,
    voucher_id: D.BIGINT.UNSIGNED, import_metadata: D.JSON, inicio: D.DATE, fin: D.DATE, estado: D.STRING, titulo: D.STRING }, { tableName: 'CitasPacientes', timestamps: false });
  for (const file of ['appointmentclinicalreport', 'appointmentclinicalreportrevision', 'clinicalepisodeappointment', 'patientvoucher', 'economicbudget', 'economicbudgetversion', 'economicbudgetevent', 'dentalplan']) { const model = require('../../../models/' + file)(sql, D); db[model.name] = model; }
  await sql.sync(); await db.Clinica.bulkCreate([{ id_clinica: 72, configuracion: { disciplinas: ['dental', 'estetica'] }, grupoClinicaId: 5 }, { id_clinica: 73, configuracion: {} }]);
  await db.Paciente.bulkCreate([{ id_paciente: 11, public_id: 'synthetic-patient', clinica_id: 72 }, { id_paciente: 12, public_id: 'foreign-patient', clinica_id: 73 }]);
  await db.UsuarioClinica.create({ id: 1, id_usuario: 7, id_clinica: 72, estado_invitacion: 'aceptada', rol_clinica: 'personaldeclinica', subrol_clinica: 'Doctores' });
  const retained = await db.AppointmentClinicalReport.create({ public_id: 'retained-context-null', clinic_id: 72, patient_id: 11, summary: 'Texto histórico', status: 'final', version_number: 1, created_by: 7, updated_by: 7 });
  await db.AppointmentClinicalReportRevision.create({ report_id: retained.id, version_number: 1, status: 'final', change_type: 'created', actor_id: 7, snapshot: { summary: 'Snapshot exacto previo' } });
  const retainedBefore = (await db.AppointmentClinicalReport.findByPk(retained.id)).toJSON(); delete retainedBefore.service_ref; await sql.getQueryInterface().removeColumn('AppointmentClinicalReports', 'service_ref');
  const migration = require('../../../migrations/20261025090500-clinical-episode-service-context'); await migration.up(sql.getQueryInterface(), Sequelize); await migration.up(sql.getQueryInterface(), Sequelize);
  const retainedAfter = (await db.AppointmentClinicalReport.findByPk(retained.id)).toJSON(); assert.equal(retainedAfter.service_ref, null); delete retainedAfter.service_ref; assert.deepEqual(retainedAfter, retainedBefore);
  assert.deepEqual((await db.AppointmentClinicalReportRevision.findOne({ where: { report_id: retained.id } })).snapshot, { summary: 'Snapshot exacto previo' }); await assert.rejects(migration.down(), /history_preserved/);
  await db.Tratamiento.bulkCreate([{ id_tratamiento: 1, nombre: 'Consulta estética ficticia', disciplina: 'estetica', origen: 'sistema', activo: true },
    { id_tratamiento: 2, nombre: 'Consulta oculta', disciplina: 'estetica', origen: 'sistema', activo: true, eliminado_por_clinica: [72] },
    { id_tratamiento: 3, nombre: 'Consulta ajena', disciplina: 'estetica', origen: 'clinica', clinica_id: 73, activo: true },
    { id_tratamiento: 4, nombre: 'Consulta inactiva', disciplina: 'estetica', origen: 'sistema', activo: false },
    { id_tratamiento: 5, nombre: 'Consulta de grupo', disciplina: 'capilar', origen: 'grupo', grupo_clinica_id: 5, activo: true },
    { id_tratamiento: 6, nombre: 'Consulta de grupo anterior', disciplina: 'capilar', origen: 'grupo', clinica_id: 72, activo: true }]);
  const vouchers = await db.PatientVoucher.bulkCreate([{ id: 1, public_id: 'owned-voucher', clinic_id: 72, patient_id: 11, treatment_id: 1, name: 'Bono previo', status: 'expired', total_units: 5, available_units: 0, sold_amount: 999 },
    { id: 2, public_id: 'other-owned-voucher', clinic_id: 72, patient_id: 11, treatment_id: 1, name: 'Otro bono', status: 'consumed', total_units: 3, available_units: 0, sold_amount: 888 },
    { id: 3, public_id: 'foreign-voucher', clinic_id: 73, patient_id: 12, treatment_id: 1, name: 'Bono ajeno', status: 'active', total_units: 3, available_units: 3, sold_amount: 777 }]);
  const budget = await db.EconomicBudget.create({ public_id: 'owned-budget', clinic_id: 72, patient_id: 11, number: 'QA-1', status: 'partially_accepted', current_version: 1 });
  await db.EconomicBudgetVersion.create({ budget_id: budget.id, version_number: 1, lines: [{ key: 'line_a', name: 'Tratamiento aceptado', treatment_id: 1, area_code: 'estetica', unit_price: 999 }, { key: 'line_b', name: 'No aceptado', treatment_id: 1 }], totals: {}, payment_proposal: {}, design_config: {}, clinic_snapshot: {}, patient_snapshot: {} });
  await db.EconomicBudgetEvent.create({ budget_id: budget.id, version_number: 1, event_type: 'partially_accepted', to_status: 'partially_accepted', metadata: { accepted_line_keys: ['line_a'], selected_payment_mode: 'private' } });
  const plan = await db.DentalPlan.create({ public_id: 'owned-dental-plan', clinic_id: 72, patient_id: 11, version_number: 1, status: 'execution', state: { title: 'Plan dental ficticio', reservations: [{ appointment_id: 85 }] }, creation_key: 'a'.repeat(64), creation_hash: 'b'.repeat(64), created_by: 7, updated_by: 7 });
  await db.CitaPaciente.bulkCreate([81,82,83,84,85].map(id => ({ id_cita: id, clinica_id: 72, paciente_id: 11, tratamiento_id: 1, doctor_id: 7, voucher_id: id === 84 ? 3 : id === 85 ? null : 1,
    import_metadata: id === 85 ? { dental_plan: { id: plan.public_id } } : {}, inicio: '2026-10-20T10:00:00Z', fin: '2026-10-20T10:30:00Z', estado: 'pendiente', titulo: 'Cita ficticia' })));
  await db.EconomicBudgetEvent.create({ budget_id: budget.id, version_number: 1, event_type: 'appointment_linked', to_status: 'partially_accepted', metadata: { appointment_id: 82, line_key: 'line_b', budget_version: 1 } });
  await db.EconomicBudgetEvent.create({ budget_id: budget.id, version_number: 1, event_type: 'appointment_linked', to_status: 'partially_accepted', metadata: { appointment_id: 82, line_key: 'line_a', budget_version: 1 } });
  await db.CitaPaciente.bulkCreate([89,90].map(id => ({ id_cita: id, clinica_id: 72, paciente_id: 11, tratamiento_id: 1, doctor_id: 7, voucher_id: id === 89 ? 1 : 2,
    inicio: '2026-10-20T12:00:00Z', fin: '2026-10-20T12:30:00Z', estado: 'pendiente', titulo: 'Cita de visita compartida' })));
  let denied; const canAccess = async ({ featureKey }) => featureKey !== denied;
  const api = require('../../services/clinicalEpisodes.service').createClinicalEpisodeService({ db, canAccess }); const scope = { actorId: 7, clinicId: 72, patientIdentifier: 11 }; let n = 0;
  const create = payload => api.create({ ...scope, payload: { expected_version: 0, idempotency_key: 'owned-service-context-' + (++n), summary: 'Consulta sin efectos económicos', ...payload } });
  const independent = (await create({ treatment_id: 1 })).item; assert.equal(independent.treatment_id, 1); assert.equal(independent.service_ref, null); assert.equal(independent.treatment_name, 'Consulta estética ficticia');
  for (const id of [2,3,4]) await assert.rejects(create({ treatment_id: id }));
  const options = await api.treatmentOptions({ ...scope, query: { q: 'Consulta', limit: 1 } }); assert.equal(options.items[0].id, 1); assert(options.next_cursor);
  const more = await api.treatmentOptions({ ...scope, query: { q: 'Consulta', limit: 1, cursor: options.next_cursor } }); assert.equal(more.items[0].id, 5);
  const legacyGroup = await api.treatmentOptions({ ...scope, query: { q: 'Consulta', limit: 1, cursor: more.next_cursor } }); assert.equal(legacyGroup.items[0].id, 6);
  await assert.rejects(api.treatmentOptions({ ...scope, patientIdentifier: 12, query: {} }), { code: 'clinical_episode_patient_not_found' });
  denied = 'clinical.reports.manage'; await assert.rejects(api.treatmentOptions({ ...scope, query: {} }), { statusCode: 403 }); denied = undefined;
  const voucher = (await create({ service_ref: { kind: 'voucher', id: 'owned-voucher' } })).item;
  assert.deepEqual(voucher.service_ref, { kind: 'voucher', id: 'owned-voucher' }); assert.equal(voucher.service_title, 'Bono previo'); assert.equal(voucher.treatment_id, 1);
  assert.equal(voucher.service_area_key, 'estetica');
  await db.PatientVoucher.update({ name: 'Nombre posterior' }, { where: { id: vouchers[0].id } });
  const continued = (await api.save({ ...scope, id: voucher.id, payload: { expected_version: 1, service_ref: voucher.service_ref, plan: 'Seguimiento' } })).item; assert.equal(continued.service_title, 'Bono previo');
  await assert.rejects(create({ service_ref: { kind: 'voucher', id: 'foreign-voucher' } }), { code: 'clinical_service_context_not_found' });
  const accepted = (await create({ service_ref: { kind: 'budget_line', id: budget.public_id, line_key: 'line_a' } })).item; assert.equal(accepted.service_title, 'Tratamiento aceptado');
  await assert.rejects(create({ service_ref: { kind: 'budget_line', id: budget.public_id, line_key: 'line_b' } }), { code: 'clinical_service_budget_line_not_accepted' });
  const automatic = (await create({ appointment_ids: [81] })).item; assert.deepEqual(automatic.service_ref, { kind: 'voucher', id: 'owned-voucher' });
  const ambiguous = (await create({ appointment_ids: [82] })).item; assert.equal(ambiguous.service_ref, null); assert.equal(ambiguous.appointment_id, 82);
  const multiAppointment = (await create({ appointment_ids: [89,90] })).item; assert.equal(multiAppointment.service_ref, null); assert.deepEqual(multiAppointment.appointment_ids.sort(), [89,90]);
  await assert.rejects(create({ appointment_ids: [83], service_ref: { kind: 'voucher', id: 'other-owned-voucher' } }), { code: 'clinical_service_context_mismatch' });
  await assert.rejects(create({ appointment_ids: [84] }), { code: 'clinical_service_context_invalid' });
  const dental = (await create({ appointment_ids: [85] })).item; assert.deepEqual(dental.service_ref, { kind: 'dental_plan', id: 'owned-dental-plan' }); assert.equal(dental.service_area_key, 'dental');
  const snap = (await api.revisions({ ...scope, id: voucher.id })).items.at(-1).snapshot.service_ref; assert.equal(snap.title, 'Bono previo'); assert.equal(snap.sold_amount, undefined);
  assert.equal((await db.PatientVoucher.findByPk(1)).available_units, '0.00'); assert.equal(await db.EconomicBudgetEvent.count(), 3); assert.equal((await db.DentalPlan.findByPk(plan.id)).version_number, 1);
  report.checks.push('Selected nullable service-context migration runs twice, leaves prior report and immutable revision exact, does no backfill, refuses destructive rollback.');
  report.checks.push('Independent catalogue choice respects system/clinic/group, hidden/inactive treatment exclusion and scoped paginated clinical-only search; identities are patient/clinic-bound and no financial ACL or values are exposed.');
  report.checks.push('Expired/consumed voucher follow-up and accepted budget line are valid clinical origins; authoritative title snapshot survives rename, unaccepted/foreign/contradictory origins reject and revisions preserve metadata without prices or payment modes.');
  report.checks.push('Chosen appointment derives verified voucher/budget/dental origins; several valid contexts do not block documentation or choose arbitrarily, broken foreign FK rejects, canonical dental area/clinical permissions apply, no balance/budget/plan side effects.');
}).catch(error => { console.error(error); process.exitCode = 1; });
