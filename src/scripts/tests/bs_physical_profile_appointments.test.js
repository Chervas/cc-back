'use strict';

// Synthetic fixtures only. No DB/network/env/application bootstrap or PHI.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { hash, norm } = require('../../lib/cliniccloud-import/adapter');
const contract = require('../../lib/cliniccloud-import/bs-physical-profile-appointment-plan');
const executor = require('../../lib/cliniccloud-import/bs-physical-profile-appointment-apply');
const { occupancyForSolution } = require('../../lib/booking-profile-solver');
const { sharedPreparationRecipe } = require('../../lib/bs-operational-recipes');
const { createBackup } = require('../bs-physical-profile-appointments');
// Test-only isolated modules: synthetic IDs use a synthetic digest. Production
// has no injection parameter, environment override, or alternative approval pin.
function isolatedTestModule(filename, rewrite = source => source, dependencies = {}) {
    const instance = new Module(filename, module); instance.filename = filename;
    instance.paths = Module._nodeModulePaths(path.dirname(filename));
    const originalRequire = instance.require.bind(instance);
    instance.require = name => Object.hasOwn(dependencies, name) ? dependencies[name] : originalRequire(name);
    instance._compile(rewrite(fs.readFileSync(filename, 'utf8')), filename); return instance.exports;
}
const jointContract = isolatedTestModule(require.resolve('../../lib/cliniccloud-import/bs-physical-profile-appointment-plan'), source => {
    const matches = source.match(/^const APPROVED_JOINT_PAIR_SHA256 = '[a-f0-9]{64}';$/gm);
    assert.equal(matches?.length, 1);
    return source.replace(matches[0], `const APPROVED_JOINT_PAIR_SHA256 = '${hash([1001, 1002])}';`);
});
const jointExecutor = isolatedTestModule(require.resolve('../../lib/cliniccloud-import/bs-physical-profile-appointment-apply'), source => source,
    { './bs-physical-profile-appointment-plan': jointContract });
const copy = value => JSON.parse(JSON.stringify(value));
const NOW = new Date('2026-10-10T12:00:00Z'), START = '2026-10-13T07:30:00.000Z', END = '2026-10-13T08:00:00.000Z';
const policy3 = { mode: 'start_end', start_minutes: 5, start_window_minutes: 10, end_minutes: 5, end_window_minutes: 10 };
function seal(snapshot) { const { snapshot_sha256, ...body } = snapshot; return { ...body, snapshot_sha256: hash(body) }; }
function fixture({ manual = false, oldUnit = 11, roomId = 82, note = 'PRESO', concept = 'PRESOTERAPIA CORPORAL 1 SESIÓN' } = {}) {
    const phase = { key: 'appointment', label: '', duration_minutes: 30, installation_ids: [roomId],
        professionals: { mode: 'any', ids: [221], preferred_id: 221 }, equipment_requirements: [{ equipment_ids: [oldUnit] }] };
    if (oldUnit !== 10) phase.staff_attention = [policy3];
    const actual = { key: 'appointment', label: '', start_at: START, end_at: END, installation_id: roomId, doctor_ids: [221], staff_time_scope: 'phase',
        equipment: [{ id: oldUnit, name: 'Synthetic machine', turnaround_minutes: 0 }],
        ...(oldUnit !== 10 ? { staff_attention: [policy3], staff_intervals: [{ kind: 'start', start_at: START, end_at: '2026-10-13T07:35:00.000Z' },
            { kind: 'end', start_at: '2026-10-13T07:50:00.000Z', end_at: '2026-10-13T07:55:00.000Z' }] } : {}) };
    const row = { id_cita: 1001, clinica_id: 72, paciente_id: 2001, doctor_id: 221, instalacion_id: roomId,
        tratamiento_id: manual ? null : oldUnit === 11 ? 623 : 611, titulo: 'Synthetic unchanged title', nota: note, estado: 'pendiente',
        tipo_cita: 'primera_con_trat', source_system: manual ? null : 'cliniccloud', source_reference: manual ? null : 'delta:synthetic',
        created_by: manual ? 1 : null, created_at: '2026-10-08 12:00:00', updated_at: '2026-10-08 12:00:00',
        inicio: '2026-10-13 07:30:00', fin: '2026-10-13 08:00:00', care_legacy_attendance: 0,
        import_metadata: manual ? null : { source_account: 'cliniccloud-5880', source_contact_id: '999', source_appointment_id: '12345',
            cliniccloud_reconciliation: { automation_policy: 'hold' }, notification_suppression: { same_day: true, day_before: true, appointment_details: true },
            cliniccloud_delta: { source: { source_contact_id: '999', start_local: '2026-10-13T09:30:00', end_local: '2026-10-13T10:00:00',
                agenda_key: norm('synthetic source room'), service_key: norm(concept) } }, booking: { version: 1,
                    profile: { version: oldUnit === 10 ? 2 : 3, phases: [phase] }, phases: [actual] } } };
    const solution = manual ? { phases: [{ ...actual, equipment: undefined, staff_attention: undefined, staff_intervals: undefined }] } : { phases: [actual] };
    const occupancies = occupancyForSolution(solution, new Map([[roomId, `installation:${roomId}`]])).map((r, index) => ({ ...r,
        id: index + 1, appointment_id: 1001, start_at: r.start_at.replace('T', ' ').replace('.000Z', ''), end_at: r.end_at.replace('T', ' ').replace('.000Z', ''),
        created_at: '2026-10-08 12:00:00', updated_at: '2026-10-08 12:00:00' }));
    const recipes = [[1948, 5, [81, 85]], [1949, 5, [85]], [1957, 11, [82]], [1964, 14, [87]], [1965, 14, [87]]].map(([id, unit, rooms]) => ({
        id_tratamiento: id, clinica_id: 72, activo: 1, clinical_config: { booking_profile: sharedPreparationRecipe({ phases: [{ ...phase,
            installation_ids: rooms, equipment_requirements: [{ equipment_ids: [unit] }], staff_attention: undefined }] }, { continuousAfterPreparation: unit === 14 }) } }));
    const snapshot = seal({ version: 'bs-piedad-appointment-snapshot/2', target: 'crm', database: 'synthetic_crm', captured_at: NOW.toISOString(),
        scope: { group_id: 29, clinic_ids: [72], doctor_ids: [221], source_systems: ['cliniccloud', null, ''], future_only: true,
            manual_created_since: '2026-10-03 12:00:00', client_note_priority_authorized_on: '2026-10-10' },
        clinics: [{ id_clinica: 66, grupoClinicaId: 29 }, { id_clinica: 72, grupoClinicaId: 29, configuracion: { timezone: 'Europe/Madrid' } }],
        targets: [copy(row)], appointments: [copy(row)], occupancies, care_events: [], historical_counts: [{ total: 3 }], treatments: recipes,
        engines: ['CitasPacientes', 'AppointmentBookingOccupancies', 'AppointmentBookingResources', 'AppointmentCareEvents'].map(TABLE_NAME => ({ TABLE_NAME, ENGINE: 'InnoDB' })), triggers: [],
        resources: { professionals: [{ id: 119, doctor_id: 221, clinica_id: 72, activo: 1, recibe_citas: 1 }],
            doctor_hours: [{ id: 1, doctor_clinica_id: 119, dia_semana: 2, activo: 1, hora_inicio: '09:00', hora_fin: '20:00' }],
            doctor_hour_exceptions: [], doctor_blocks: [], doctor_block_exceptions: [], physical_aliases: [],
            installations: [81, 82, 85, 87].map(id => ({ id, clinica_id: 72, activo: 1, profesionales_permitidos: [221] })),
            clinic_hours: [{ clinica_id: 72, dia_semana: 2, activo: 1, hora_inicio: '09:00', hora_fin: '20:00' }],
            room_hours: [81, 82, 85, 87].map(instalacion_id => ({ instalacion_id, dia_semana: 2, activo: 1, hora_inicio: '09:00', hora_fin: '20:00' })), room_blocks: [],
            equipment: [{ id: 5, status: 'available', mobility: 'mobile', name: 'EMShape', turnaround_minutes: 0 },
                { id: 11, status: 'available', mobility: 'fixed', home_installation_id: 82, name: 'Presotherapy', turnaround_minutes: 0 },
                { id: 14, status: 'available', mobility: 'fixed', home_installation_id: 87, name: 'INDIBA', turnaround_minutes: 0 }],
            equipment_memberships: [5, 11, 14].map(equipment_id => ({ equipment_id, clinic_id: 72 })),
            equipment_room_policies: [81, 85, 87].map(installation_id => ({ installation_id, mode: 'selected', equipment_ids: [5] })) } });
    const source = { id: 12345, start: '2026-10-13T09:30:00', end: '2026-10-13T10:00:00', extendedProps: { idContacto: 999,
        agenda: 'synthetic source room', servicio_nombre: concept, detalles: note } };
    return { snapshot, calendarSource: { data: { captures: [{ response: [source] }] } },
        historySource: { data: { source_account: 'cliniccloud-5880', full_history: true, results: [{ id: 999, status: 200,
            data: [{ idCita: 12345, idContacto: 999, conceptos: [{ asunto: concept }] }] }] } }, sourceFileHashes: contract.SOURCE_FILES };
}
function fakeStore(inputs) {
    let snapshot = copy(inputs.snapshot), nextId = 5000, checkpoint;
    const calls = [];
    return { calls, get snapshot() { return snapshot; },
        async acquireExecutionLock() { calls.push('executor_lock'); }, async releaseExecutionLock() { calls.push('executor_unlock'); },
        async begin(readOnly) { calls.push(readOnly ? 'begin_read_only' : 'begin_write'); checkpoint = copy(snapshot); },
        async lockResources() { calls.push('booking_resource_locks'); }, async readSnapshot() { return copy(snapshot); },
        async automationCounters() { return { FlowExecutionsV2: { total: 0, max_id: null } }; },
        async write(plan, direction, before, rollbackState) {
            calls.push('write');
            const ids = new Set(plan.operations.map(op => op.appointment_id));
            snapshot.appointments = snapshot.appointments.map(row => ids.has(row.id_cita) ? copy(plan.operations.find(op => op.appointment_id === row.id_cita)[direction === 'forward' ? 'after' : 'before']) : row);
            if (direction === 'rollback') snapshot.occupancies = [...snapshot.occupancies.filter(row => !ids.has(row.appointment_id)), ...copy(rollbackState.occupancies)];
            else for (const op of plan.operations) {
                snapshot.occupancies = snapshot.occupancies.filter(row => row.appointment_id !== op.appointment_id
                    || row.resource_kind !== 'doctor' && (!op.equipment_correction || row.resource_kind !== 'equipment'));
                snapshot.occupancies.push(...op.after_occupancies.filter(row => row.resource_kind === 'doctor' || op.equipment_correction && row.resource_kind === 'equipment')
                    .map(row => ({ ...copy(row), id: nextId++, appointment_id: op.appointment_id, created_at: '2026-10-10 12:00:00', updated_at: '2026-10-10 12:00:00',
                        start_at: row.start_at.replace('T', ' ').replace('.000Z', ''), end_at: row.end_at.replace('T', ' ').replace('.000Z', '') })));
            }
            snapshot = seal(snapshot);
        }, async commit() { calls.push('commit'); }, async rollback() { calls.push('rollback'); snapshot = checkpoint; },
    };
}
function journal() { return { entries: [], async reload() {}, async append(entry) { this.entries.push(copy(entry)); } }; }
function authorization(plan, snapshot, direction = 'forward') {
    const backup = createBackup(plan, snapshot, NOW), backupFileSha256 = hash(backup);
    return { backup, backupFileSha256, approval: { version: executor.APPROVAL_VERSION, target: 'crm', group_id: 29, clinic_ids: [72], doctor_ids: [221],
        direction, created_at: NOW.toISOString(), expires_at: new Date(NOW.getTime() + 60000).toISOString(), operator_identity: 'Synthetic operator',
        plan_sha256: plan.plan_sha256, appointment_ids: plan.operations.map(op => op.appointment_id).sort((a, b) => a - b),
        backup_file_sha256: backupFileSha256, field_whitelist: contract.FIELD_WHITELIST, preserve_all_appointment_fields_and_updated_at: true,
        preserve_room_and_unchanged_equipment_occupancies: true, allow_exact_listed_ems_machine_corrections: true, no_messages_jobs_events_or_financial_writes: true } };
}
function pairFixture() {
    const first = fixture(), second = fixture({ oldUnit: 5, roomId: 85, note: 'EMS', concept: 'EMSHAPE CORPORAL' });
    for (const [inputs, id, patient, contact, sourceId, occupancyOffset] of [[first, 1001, 2001, 999, 12345, 0], [second, 1002, 2002, 998, 12346, 100]]) {
        for (const row of [...inputs.snapshot.targets, ...inputs.snapshot.appointments]) {
            row.id_cita = id; row.paciente_id = patient; row.import_metadata.source_contact_id = String(contact);
            row.import_metadata.source_appointment_id = String(sourceId); row.import_metadata.cliniccloud_delta.source.source_contact_id = String(contact);
        }
        for (const row of inputs.snapshot.occupancies) { row.appointment_id = id; row.id += occupancyOffset; }
        const raw = inputs.calendarSource.data.captures[0].response[0]; raw.id = sourceId; raw.extendedProps.idContacto = contact;
        const history = inputs.historySource.data.results[0]; history.id = contact; history.data[0].idCita = sourceId; history.data[0].idContacto = contact;
    }
    first.snapshot.targets.push(...second.snapshot.targets); first.snapshot.appointments.push(...second.snapshot.appointments);
    first.snapshot.occupancies.push(...second.snapshot.occupancies); first.snapshot = seal(first.snapshot);
    first.calendarSource.data.captures[0].response.push(...second.calendarSource.data.captures[0].response);
    first.historySource.data.results.push(...second.historySource.data.results);
    return first;
}
test('PRESO uses approved1957 policy, never rewrites623/history/time/state or input', () => {
    const inputs = fixture(), original = hash(inputs), plan = contract.buildPiedadAppointmentPlan(inputs), op = plan.operations[0];
    assert.equal(hash(inputs), original); assert.equal(plan.summary.ready, 1); assert.equal(op.policy_recipe_id, 1957);
    assert.equal(op.after.tratamiento_id, 623); assert.equal(op.after.titulo, op.before.titulo); assert.equal(op.after.updated_at, op.before.updated_at);
    assert.equal(op.after.inicio, op.before.inicio); assert.equal(op.after.estado, op.before.estado);
    assert.deepEqual(op.after_physical_occupancy_signature, op.physical_occupancy_signature);
    assert.equal(op.after.import_metadata.booking.profile.version, 4); assert.equal(op.released_doctor_minutes, 5);
});
test('explicit note authorization resolves EMS despite CYCLONE title and unit10, with room/time preserved', () => {
    const plan = contract.buildPiedadAppointmentPlan(fixture({ oldUnit: 10, roomId: 85, note: 'EMS', concept: 'CYCLONE CORPORAL 1 SESIÓN' }));
    assert.equal(plan.summary.ready, 1); const op = plan.operations[0];
    assert.deepEqual([op.before.tratamiento_id, op.after.tratamiento_id], [611, 611]); assert.equal(op.equipment_correction.old_equipment_id, 10);
    assert.equal(op.after.import_metadata.booking.phases[0].equipment[0].id, 5);
    assert.ok(op.resource_keys.includes('equipment:10')); assert.ok(op.resource_keys.includes('equipment:5'));
    assert.equal(op.after.import_metadata.piedad_preparation_migration.source_evidence.note_priority.client_authorization_date, '2026-10-10');
});
test('manual EMS with null original metadata reserves actual unit5, preserving null in exact before state', () => {
    const inputs = fixture({ manual: true, roomId: 85, note: 'EMS' }), plan = contract.buildPiedadAppointmentPlan(inputs), op = plan.operations[0];
    assert.equal(plan.summary.ready, 1); assert.equal(op.before.import_metadata, null); assert.equal(op.after.tratamiento_id, null);
    assert.equal(op.equipment_correction.old_equipment_id, null); assert.equal(op.after.import_metadata.booking.phases[0].equipment[0].id, 5);
    assert.deepEqual(op.before_occupancies.filter(r => r.resource_kind === 'installation').map(r => r.resource_key), ['installation:85']);
});
test('ambiguous/negated notes, inactive units, recurrent room blocks and already-started care fail closed', () => {
    for (const note of ['NO EMS', 'EMS + PRESO']) assert.equal(contract.buildPiedadAppointmentPlan(fixture({ manual: true, roomId: 85, note })).summary.ready, 0);
    const variants = [inputs => inputs.snapshot.resources.equipment.find(r => r.id === 11).status = 'maintenance',
        inputs => inputs.snapshot.resources.room_blocks.push({ id: 1, instalacion_id: 82, recurrente: 'weekly', fecha_inicio: '2026-01-01 00:00:00', fecha_fin: '2026-01-01 01:00:00' }),
        inputs => inputs.snapshot.targets[0].care_started_at = '2026-10-10 11:00:00'];
    for (const mutate of variants) { const inputs = fixture(); mutate(inputs); inputs.snapshot = seal(inputs.snapshot); assert.equal(contract.buildPiedadAppointmentPlan(inputs).summary.ready, 0); }
});
test('two individually prepared corrections cannot invent simultaneous capacity of one EMShape unit', () => {
    const inputs = fixture({ manual: true, roomId: 85, note: 'EMS' }), plan = contract.buildPiedadAppointmentPlan(inputs), first = plan.operations[0], second = copy(first);
    second.appointment_id = 1002; second.before.id_cita = 1002; second.after.id_cita = 1002; second.after.paciente_id = 2002;
    second.after.instalacion_id = 81; second.after.import_metadata.booking.profile.phases[0].installation_ids = [81];
    const phase = second.after.import_metadata.booking.phases[0]; phase.installation_id = 81;
    phase.staff_intervals = [{ kind: 'start', start_at: '2026-10-13T07:35:00.000Z', end_at: '2026-10-13T07:40:00.000Z' }];
    second.after_occupancies = occupancyForSolution({ phases: [phase] }, new Map([[81, 'installation:81']]));
    const snapshot = copy(inputs.snapshot); snapshot.appointments.push(copy(second.before));
    assert.throws(() => contract.assertFinalCapacity(snapshot, [first, second]), /FINAL_BATCH_PHYSICAL_COLLISION/);
});
test('late competing newunit5 booking and newly installed trigger invalidate CAS before writes', () => {
    const inputs = fixture({ manual: true, roomId: 85, note: 'EMS' }), plan = contract.buildPiedadAppointmentPlan(inputs), snapshot = copy(inputs.snapshot);
    snapshot.appointments.push({ ...copy(snapshot.appointments[0]), id_cita: 9001, doctor_id: 999, paciente_id: 9001 });
    snapshot.occupancies.push({ id: 9001, appointment_id: 9001, resource_kind: 'equipment', resource_key: 'equipment:5', start_at: START, end_at: END });
    assert.throws(() => executor.assessBatch({ plan, snapshot, direction: 'forward', now: NOW }), /COMPETING_RESERVATION_DRIFT/);
    const triggered = copy(inputs.snapshot); triggered.triggers.push({ TRIGGER_NAME: 'new_trigger' });
    assert.throws(() => executor.assessBatch({ plan, snapshot: triggered, direction: 'forward', now: NOW }), /LIVE_TRANSACTIONAL/);
});
test('default dry-run starts only read-only transaction and never acquires locks/writes/enqueues', async () => {
    const inputs = fixture(), plan = contract.buildPiedadAppointmentPlan(inputs), store = fakeStore(inputs);
    const result = await executor.executePiedadAppointmentMigration({ plan, inputs, store, now: NOW });
    assert.equal(result.written, 0); assert.equal(result.would_write, 1); assert.deepEqual(store.calls, ['begin_read_only', 'rollback']);
});
test('forward, idempotent rerun and exact rollback preserve appointment timestamp/null metadata without hooks/messages', async () => {
    const inputs = fixture({ manual: true, roomId: 85, note: 'EMS' }), plan = contract.buildPiedadAppointmentPlan(inputs), store = fakeStore(inputs), log = journal();
    const auth = authorization(plan, inputs.snapshot);
    const result = await executor.executePiedadAppointmentMigration({ plan, inputs, store, journal: log, ...auth, dryRun: false, now: NOW });
    assert.equal(result.written, 1); assert.equal(result.messages_dispatched, 0); assert.equal(store.snapshot.appointments[0].updated_at, inputs.snapshot.appointments[0].updated_at);
    const repeated = await executor.executePiedadAppointmentMigration({ plan, inputs, store, journal: log, ...auth, dryRun: false, now: NOW });
    assert.equal(repeated.decision, 'already_committed_no_write');
    const rolled = await executor.executePiedadAppointmentMigration({ plan, inputs, store, journal: log, ...auth,
        approval: { ...auth.approval, direction: 'rollback' }, direction: 'rollback', dryRun: false, now: NOW });
    assert.equal(rolled.written, 1); assert.equal(store.snapshot.appointments[0].import_metadata, null);
    assert.deepEqual(store.snapshot.occupancies, inputs.snapshot.occupancies); assert.equal(log.entries.filter(e => e.stage === 'committed').length, 2);
});
test('later human edit prevents rollback; fresh approval binds exact appointment IDs', async () => {
    const inputs = fixture(), plan = contract.buildPiedadAppointmentPlan(inputs), store = fakeStore(inputs), log = journal(), auth = authorization(plan, inputs.snapshot);
    await executor.executePiedadAppointmentMigration({ plan, inputs, store, journal: log, ...auth, dryRun: false, now: NOW });
    store.snapshot.appointments[0].nota = 'A later human edit';
    await assert.rejects(executor.executePiedadAppointmentMigration({ plan, inputs, store, journal: log, ...auth,
        approval: { ...auth.approval, direction: 'rollback' }, direction: 'rollback', dryRun: false, now: NOW }), /CAS_DRIFT/);
    assert.throws(() => executor.verifyAuthorization({ plan, ...auth, approval: { ...auth.approval, appointment_ids: [9999] }, direction: 'forward', now: NOW }), /FRESH_SCOPED/);
});
test('raw writer updates metadata only with explicit timestamp preservation and installation rows never deleted', async () => {
    const inputs = fixture({ manual: true, roomId: 85, note: 'EMS' }), plan = contract.buildPiedadAppointmentPlan(inputs), queries = [];
    const store = executor.createPiedadAppointmentStore({ async query(sql, params) { queries.push(sql);
        return [{ affectedRows: sql.startsWith('DELETE') ? params.at(-1).length : 1 }]; } });
    await store.write(plan, 'forward', executor.batchState(inputs.snapshot, plan));
    assert.ok(queries.some(sql => /SET import_metadata=\?,updated_at=updated_at/.test(sql)));
    assert.ok(queries.filter(sql => /^DELETE/.test(sql)).every(sql => /resource_kind='doctor'|resource_kind='equipment'/.test(sql)));
    assert.ok(queries.every(sql => !/Notifications|FlowExecutions|JobRequests|AppointmentVisitCommunications/.test(sql)));
});
test('approved joint pair stages two distinct five-minute preparations, preserving original source/before/snapshot', () => {
    const inputs = pairFixture(), original = hash(inputs), oldPlan = contract.buildPiedadAppointmentPlan(inputs);
    assert.equal(oldPlan.operations.length, 0); assert.ok(oldPlan.records.every(row => row.reason === 'preparation_origin_unverified'));
    assert.equal(Object.hasOwn(oldPlan, 'approved_joint_preparation_pair'), false);
    const plan = jointContract.buildPiedadAppointmentPlan({ ...inputs, approvedJointPair: [1001, 1002] });
    assert.equal(hash(inputs), original); assert.equal(plan.operations.length, 2);
    assert.deepEqual(plan.operations.map(op => op.appointment_id), [1001, 1002]);
    const [first, second] = plan.operations;
    assert.equal(first.after.import_metadata.booking.phases[0].staff_intervals[0].start_at, START);
    assert.equal(second.after.import_metadata.booking.phases[0].staff_intervals[0].start_at, '2026-10-13T07:35:00.000Z');
    for (const op of plan.operations) {
        assert.deepEqual(op.before, inputs.snapshot.appointments.find(row => row.id_cita === op.appointment_id));
        assert.equal(op.after.import_metadata.piedad_preparation_migration.snapshot_sha256, inputs.snapshot.snapshot_sha256);
        assert.equal(op.after.import_metadata.piedad_preparation_migration.joint_preparation_proof.original_snapshot_sha256, inputs.snapshot.snapshot_sha256);
        assert.deepEqual(op.after_physical_occupancy_signature, op.physical_occupancy_signature); assert.equal(op.equipment_correction, null);
    }
    contract.assertFinalCapacity(inputs.snapshot, plan.operations);
    assert.deepEqual(contract.buildPiedadAppointmentPlan(inputs), oldPlan);
    for (const value of [[1001, 99999], [1002, 1001], [1001, 1001], ['1001', 1002], [1001, 1002, 1003], [0, 1002], [Number.MAX_SAFE_INTEGER + 1, 1002]])
        assert.throws(() => jointContract.buildPiedadAppointmentPlan({ ...inputs, approvedJointPair: value }), /ONLY_EXACT_APPROVED_JOINT_PAIR/);
    assert.throws(() => contract.normalizeApprovedJointPair([1001, 1002]), /ONLY_EXACT_APPROVED_JOINT_PAIR/);
});
test('joint pair source/identity and patient checks run against original rows before any doctor context is masked', () => {
    const sourceDrift = pairFixture(); sourceDrift.calendarSource.data.captures[0].response[1].start = '2026-10-13T09:35:00';
    const changed = jointContract.buildPiedadAppointmentPlan({ ...sourceDrift, approvedJointPair: [1001, 1002] });
    assert.equal(changed.operations.length, 0); assert.equal(changed.records[1].reason, 'original_visit_geometry_or_identity_changed');
    const samePatient = pairFixture(); samePatient.snapshot.targets[1].paciente_id = 2001; samePatient.snapshot.appointments[1].paciente_id = 2001;
    samePatient.snapshot = seal(samePatient.snapshot);
    assert.equal(jointContract.buildPiedadAppointmentPlan({ ...samePatient, approvedJointPair: [1001, 1002] }).operations.length, 0);
    const third = pairFixture(), row = { ...copy(third.snapshot.appointments[0]), id_cita: 9001, paciente_id: 9001, instalacion_id: 81 };
    third.snapshot.appointments.push(row); third.snapshot.occupancies.push({ id: 9001, appointment_id: 9001, doctor_id: 221,
        resource_kind: 'doctor', resource_key: 'doctor:221', start_at: START, end_at: END }); third.snapshot = seal(third.snapshot);
    assert.equal(jointContract.buildPiedadAppointmentPlan({ ...third, approvedJointPair: [1001, 1002] }).operations.length, 0);
    const physical = pairFixture(); physical.snapshot.appointments.push({ ...copy(physical.snapshot.appointments[0]), id_cita: 9002, doctor_id: 999, paciente_id: 9002 });
    physical.snapshot.occupancies.push({ id: 9002, appointment_id: 9002, resource_kind: 'equipment', resource_key: 'equipment:11', start_at: START, end_at: END });
    physical.snapshot = seal(physical.snapshot);
    const physicalPlan = jointContract.buildPiedadAppointmentPlan({ ...physical, approvedJointPair: [1001, 1002] });
    assert.equal(physicalPlan.operations.length, 0); assert.equal(physicalPlan.records[0].reason, 'existing_physical_room_or_machine_collision');
});
test('joint pair forward, exact rollback and reapply exclude only their own planned competition changes', async () => {
    const inputs = { ...pairFixture(), approvedJointPair: [1001, 1002] }, plan = jointContract.buildPiedadAppointmentPlan(inputs);
    const store = fakeStore(inputs), log = journal(), auth = authorization(plan, inputs.snapshot);
    const first = await jointExecutor.executePiedadAppointmentMigration({ plan, inputs, store, journal: log, ...auth, dryRun: false, now: NOW });
    assert.equal(first.written, 2);
    const rollback = await jointExecutor.executePiedadAppointmentMigration({ plan, inputs, store, journal: log, ...auth,
        approval: { ...auth.approval, direction: 'rollback' }, direction: 'rollback', dryRun: false, now: NOW });
    assert.equal(rollback.written, 2); assert.deepEqual(store.snapshot.appointments, inputs.snapshot.appointments);
    assert.deepEqual(store.snapshot.occupancies, inputs.snapshot.occupancies);
    const reapplied = await jointExecutor.executePiedadAppointmentMigration({ plan, inputs, store, journal: log, ...auth, dryRun: false, now: NOW });
    assert.equal(reapplied.written, 2); assert.equal(reapplied.messages_dispatched, 0);
});
test('indeterminate commit is recovered from exact stored after-state without repeating clinical writes or old journal hash fields', async () => {
    const inputs = fixture(), plan = contract.buildPiedadAppointmentPlan(inputs), store = fakeStore(inputs), log = journal(), auth = authorization(plan, inputs.snapshot);
    const commit = store.commit, rollback = store.rollback; let committed = false;
    store.commit = async () => { await commit(); committed = true; throw Error('Synthetic disconnected commit response'); };
    store.rollback = async () => { if (!committed) await rollback(); };
    await assert.rejects(executor.executePiedadAppointmentMigration({ plan, inputs, store, journal: log, ...auth, dryRun: false, now: NOW }), /INDETERMINATE_COMMIT_REQUIRES_RECOVERY/);
    const unfinished = log.entries.at(-1); unfinished.entry_sha256 = 'previous-entry'; unfinished.sequence = 2;
    unfinished.previous_entry_sha256 = 'previous-link'; unfinished.journal_at = NOW.toISOString();
    const writes = store.calls.filter(call => call === 'write').length;
    const recovered = await executor.recoverPiedadAppointmentMigration({ plan, inputs, store, journal: log, ...auth,
        approval: { ...auth.approval, recover_indeterminate_commit: true }, now: NOW });
    assert.equal(recovered.clinical_writes, 0); assert.equal(recovered.outcomes[0].stage, 'committed');
    assert.equal(store.calls.filter(call => call === 'write').length, writes);
    for (const key of ['entry_sha256', 'sequence', 'previous_entry_sha256', 'journal_at']) assert.equal(Object.hasOwn(log.entries.at(-1), key), false);
});
