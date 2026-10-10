'use strict';

// Operator-only, SELECT-only evidence capture. No ORM, application, workers,
// booking commands, message queues or patient exports are bootstrapped.
const { hash } = require('./adapter');
const { QUERIES } = require('./catalog-preflight');
const VERSION = 'bs-piedad-appointment-snapshot/2';
const fail = code => { throw Error(code); };
const LIMIT = 5000;
async function rows(connection, sql, parameters = []) {
    const [result] = await connection.query(sql, parameters);
    if (!Array.isArray(result) || result.length >= LIMIT) fail('BS_APPOINTMENT_SNAPSHOT_SCOPE_LIMIT');
    return result;
}
async function capturePiedadAppointmentSnapshot(connection, { now = new Date(), transactionAlreadyOpen = false } = {}) {
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) fail('BS_APPOINTMENT_SNAPSHOT_CLOCK_INVALID');
    const capturedAt = now.toISOString(), cutoff = capturedAt.slice(0, 19).replace('T', ' ');
    if (typeof transactionAlreadyOpen !== 'boolean') fail('BS_APPOINTMENT_SNAPSHOT_TRANSACTION_INVALID');
    if (!transactionAlreadyOpen) await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    try {
        const database = (await rows(connection, 'SELECT DATABASE() AS name'))[0]?.name;
        const clinics = await rows(connection, 'SELECT id_clinica,grupoClinicaId,equipment_booking_enabled,configuracion FROM Clinicas WHERE id_clinica IN (66,72) ORDER BY id_clinica');
        if (clinics.length !== 2 || clinics.some(row => Number(row.grupoClinicaId) !== 29)) fail('BS_APPOINTMENT_CLINIC_SCOPE_CHANGED');
        const manualCutoff = new Date(now.getTime() - 7 * 86400000).toISOString().slice(0, 19).replace('T', ' ');
        const targets = await rows(connection, "SELECT * FROM CitasPacientes WHERE doctor_id=221 AND clinica_id IN (66,72) AND inicio>? AND (source_system='cliniccloud' OR ((source_system IS NULL OR source_system='') AND created_at>=? AND nota REGEXP '(^|[^[:alnum:]_])(EMS|EMMS)([^[:alnum:]_]|$)')) ORDER BY inicio,id_cita LIMIT 5000", [cutoff, manualCutoff]);
        const historical_counts = await rows(connection, "SELECT clinica_id,estado,COUNT(*) AS total,SUM(care_started_at IS NOT NULL OR care_completed_at IS NOT NULL OR care_legacy_attendance=1) AS assisted FROM CitasPacientes WHERE doctor_id=221 AND clinica_id IN (66,72) AND source_system='cliniccloud' AND inicio<=? GROUP BY clinica_id,estado ORDER BY clinica_id,estado", [cutoff]);
        const maxEnd = targets.reduce((end, row) => row.fin > end ? row.fin : end, cutoff);
        // Physical turnaround is bounded at120 minutes by the operational
        // contract. Include both preceding buffers and subsequent occupancies.
        const windowStart = new Date(now.getTime() - 120 * 60000).toISOString().slice(0, 19).replace('T', ' ');
        const windowEnd = new Date(Date.parse(maxEnd.replace(' ', 'T') + 'Z') + 120 * 60000).toISOString().slice(0, 19).replace('T', ' ');
        const patientIds = [...new Set(targets.map(row => Number(row.paciente_id)).filter(Boolean))];
        const appointments = await rows(connection, "SELECT c.* FROM CitasPacientes c WHERE c.fin>? AND c.inicio<=? AND (c.doctor_id=221 OR c.paciente_id IN (?) OR c.instalacion_id IN (81,82,85,87) OR EXISTS (SELECT 1 FROM AppointmentBookingOccupancies o WHERE o.appointment_id=c.id_cita AND o.resource_key IN ('doctor:221','equipment:5','equipment:10','equipment:11','equipment:14','installation:81','installation:82','installation:85','installation:87'))) ORDER BY c.id_cita LIMIT 5000", [windowStart, windowEnd, patientIds.length ? patientIds : [0]]);
        const ids = appointments.map(row => Number(row.id_cita));
        const occupancies = await rows(connection, 'SELECT * FROM AppointmentBookingOccupancies WHERE appointment_id IN (?) ORDER BY appointment_id,id LIMIT 5000', [ids.length ? ids : [0]]);
        const care_events = await rows(connection, 'SELECT * FROM AppointmentCareEvents WHERE appointment_id IN (?) ORDER BY appointment_id,id LIMIT 5000', [targets.length ? targets.map(row => Number(row.id_cita)) : [0]]);
        const resources = {};
        for (const key of ['installations', 'physical_aliases', 'equipment', 'equipment_memberships', 'equipment_room_policies']) resources[key] = await rows(connection, QUERIES[key]);
        resources.professionals = await rows(connection, 'SELECT * FROM DoctorClinicas WHERE doctor_id=221 ORDER BY id LIMIT 5000');
        resources.doctor_hours = await rows(connection, 'SELECT h.* FROM DoctorHorarios h INNER JOIN DoctorClinicas dc ON dc.id=h.doctor_clinica_id WHERE dc.doctor_id=221 ORDER BY h.id LIMIT 5000');
        resources.doctor_hour_exceptions = await rows(connection, 'SELECT e.* FROM DoctorHorarioExcepciones e INNER JOIN DoctorHorarios h ON h.id=e.doctor_horario_id INNER JOIN DoctorClinicas dc ON dc.id=h.doctor_clinica_id WHERE dc.doctor_id=221 ORDER BY e.id LIMIT 5000');
        resources.doctor_blocks = await rows(connection, 'SELECT * FROM DoctorBloqueos WHERE doctor_id=221 ORDER BY id LIMIT 5000');
        resources.doctor_block_exceptions = await rows(connection, 'SELECT e.* FROM DoctorBloqueoExcepciones e INNER JOIN DoctorBloqueos b ON b.id=e.doctor_bloqueo_id WHERE b.doctor_id=221 ORDER BY e.id LIMIT 5000');
        resources.clinic_hours = await rows(connection, 'SELECT * FROM ClinicaHorarios WHERE clinica_id IN (66,72) ORDER BY id LIMIT 5000');
        resources.room_hours = await rows(connection, 'SELECT h.* FROM InstalacionHorarios h INNER JOIN Instalaciones i ON i.id=h.instalacion_id WHERE i.clinica_id IN (66,72) ORDER BY h.id LIMIT 5000');
        resources.room_blocks = await rows(connection, 'SELECT b.* FROM InstalacionBloqueos b INNER JOIN Instalaciones i ON i.id=b.instalacion_id WHERE i.clinica_id IN (66,72) ORDER BY b.id LIMIT 5000');
        const treatments = await rows(connection, 'SELECT * FROM Tratamientos WHERE id_tratamiento IN (1948,1949,1957,1964,1965,2180,611,623) OR id_tratamiento IN (?) ORDER BY id_tratamiento LIMIT 5000', [targets.map(row => Number(row.tratamiento_id)).filter(Boolean).length ? targets.map(row => Number(row.tratamiento_id)).filter(Boolean) : [0]]);
        const anchors = await rows(connection, "SELECT * FROM AppointmentBookingResources WHERE resource_key IN ('doctor:221','equipment:5','equipment:11','equipment:14','installation:81','installation:82','installation:85','installation:87') OR resource_key IN (?) ORDER BY resource_key LIMIT 5000", [patientIds.length ? patientIds.map(id => `patient:${id}`) : ['patient:0']]);
        const tables = ['CitasPacientes', 'AppointmentBookingOccupancies', 'AppointmentBookingResources', 'AppointmentCareEvents'];
        const engines = await rows(connection, 'SELECT TABLE_NAME,ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (?) ORDER BY TABLE_NAME', [tables]);
        const triggers = await rows(connection, 'SELECT TRIGGER_NAME,EVENT_OBJECT_TABLE FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE IN (?) ORDER BY EVENT_OBJECT_TABLE,TRIGGER_NAME', [tables]);
        const body = { version: VERSION, target: 'crm', database, captured_at: capturedAt, scope: { group_id: 29, clinic_ids: [72], doctor_ids: [221], source_systems: ['cliniccloud', null, ''], future_only: true,
            manual_created_since: manualCutoff, client_note_priority_authorized_on: '2026-10-10' },
            clinics, targets, historical_counts, appointments, occupancies, care_events, resources, treatments, anchors, engines, triggers };
        return { ...body, snapshot_sha256: hash(body) };
    } finally { if (!transactionAlreadyOpen) await connection.rollback(); }
}
module.exports = { VERSION, capturePiedadAppointmentSnapshot };
