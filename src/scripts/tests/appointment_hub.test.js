'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const { Op } = require('sequelize');
const { parseAppointmentHubQuery } = require('../../lib/appointment-hub-query');
const source = fs.readFileSync(require.resolve('../../controllers/citas.controller'), 'utf8');
function handler(start, end, globals) {
    const context = { exports: {}, asyncHandler: fn => fn, plainCita: row => row, formatDateTimeLocal: value => value,
        buildClinicCalendarScope: async () => ({ timeZones: new Map() }), DEFAULT_TIMEZONE: 'Europe/Madrid', canUserAccessFeature: async () => true, ...globals };
    vm.runInNewContext(source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))), context);
    return context.exports;
}
function privacyProtection(canAccess) {
    const context = {
        module: { exports: {} }, crypto: require('node:crypto'),
        canUserAccessFeature: canAccess, bookingCapabilities: () => ({ simple: false }),
        appointmentImportReview: () => null,
        require: name => {
            assert.equal(name, '../lib/appointment-care');
            return require('../../lib/appointment-care');
        },
    };
    const start = source.indexOf('function appointmentPatientPseudonym(');
    const end = source.indexOf('\nasync function assertAppointmentManageAccess(', start);
    vm.runInNewContext(source.slice(start, end) + '\nmodule.exports = protectAppointmentsForRequest;', context);
    return context.module.exports;
}
test('hub requires one explicit clinic and contact, bounds pagination and rejects malformed IDs', () => {
    for (const query of [{}, { clinica_id: '1,2', paciente_id: '1' }, { clinica_id: 1 }, { clinica_id: 1, paciente_id: '-3' }, { clinica_id: 1, paciente_id: 'x OR 1' }]) assert.throws(() => parseAppointmentHubQuery(query));
    assert.deepEqual(parseAppointmentHubQuery({ clinica_id: '82', paciente_id: 'pac_fixture', limit: 900, page: 999999, period: 'past' }),
        { clinicId: 82, patient: 'pac_fixture', leadId: null, page: 10000, limit: 30, past: true });
});
test('list scopes SQL before reading; uses limit+1 and no availability, messages or financial queries', async () => {
    let captured, protectedRows;
    const { getAppointmentHubList } = handler('exports.getAppointmentHubList =', '\nexports.getCitas =', {
        require: () => ({ parseAppointmentHubQuery }), Op,
        denyAppointmentViewAccessIfNeeded: async () => false,
        CitaPaciente: { findAll: async options => { captured = options; return [{ id_cita: 1 }, { id_cita: 2 }, { id_cita: 3 }]; } },
        Paciente: {}, LeadIntake: {}, Tratamiento: {}, Instalacion: {}, db: { Usuario: {} },
        protectAppointmentsForRequest: async (_, rows) => { protectedRows = rows; return rows; },
    });
    let body;
    await getAppointmentHubList({ query: { clinica_id: 82, paciente_id: 7, limit: 2, page: 2 } }, { json: value => body = value });
    assert.equal(captured.where.clinica_id, 82); assert.equal(captured.where.paciente_id, 7);
    assert.equal(captured.offset, 2); assert.equal(captured.limit, 3); assert(captured.where.inicio[Op.gte]);
    assert.equal(body.has_more, true); assert.equal(protectedRows.length, 2);
    assert(captured.attributes.includes('nota'));
    for (const [name, attributes] of [
        ['paciente', ['id_paciente', 'public_id', 'nombre', 'apellidos']],
        ['lead', ['id', 'nombre']],
    ]) {
        const identity = captured.include.find(item => item.as === name);
        assert.equal(identity.required, false, 'Missing identity must not remove a paginated appointment');
        assert.deepEqual(Array.from(identity.attributes), attributes, 'Hub identity must not include contact or clinical fields');
    }
});
test('hub carries patient/lead card identity and notes through the existing clinic privacy policy', async () => {
    const rows = [
        { id_cita: 1, clinica_id: 82, paciente_id: 7, inicio: '2026-10-05T07:00:00Z', fin: '2026-10-05T07:30:00Z',
            nota: 'Nota ficticia paciente', paciente: { id_paciente: 7, public_id: 'pac_fixture', nombre: 'Paciente ficticio', apellidos: 'Prueba' }, lead: null },
        { id_cita: 2, clinica_id: 82, lead_intake_id: 19, inicio: '2026-10-05T08:00:00Z', fin: '2026-10-05T08:30:00Z',
            nota: 'Nota ficticia lead', paciente: null, lead: { id: 19, nombre: 'Lead ficticio' } },
    ];
    for (const [patientSensitive, leadSensitive] of [[true, true], [false, false], [true, false], [false, true]]) {
        let reads = 0, body;
        const checks = [];
        const protect = privacyProtection(async check => {
            checks.push(check);
            assert.equal(check.actorId, 501); assert.equal(check.clinicId, 82);
            return check.featureKey === 'patients.sensitive.view' ? patientSensitive
                : check.featureKey === 'leads.sensitive.view' ? leadSensitive : false;
        });
        const { getAppointmentHubList } = handler('exports.getAppointmentHubList =', '\nexports.getCitas =', {
            require: () => ({ parseAppointmentHubQuery }), Op,
            denyAppointmentViewAccessIfNeeded: async () => false,
            CitaPaciente: { findAll: async () => { reads++; return rows; } },
            Paciente: {}, LeadIntake: {}, Tratamiento: {}, Instalacion: {}, db: {},
            protectAppointmentsForRequest: protect,
        });
        await getAppointmentHubList({ query: { clinica_id: 82, paciente_id: 7 }, userData: { userId: 501 } }, { json: value => body = value });
        assert.equal(reads, 1, 'List must not fetch individual appointment details');
        assert.equal(body.items[0].paciente.nombre, patientSensitive ? 'Paciente ficticio' : 'Paciente');
        assert.equal(body.items[0].nota, patientSensitive ? rows[0].nota : null);
        assert.equal(body.items[1].nota, patientSensitive ? rows[1].nota : null);
        assert.equal(body.items[1].lead.nombre, leadSensitive ? 'Lead ficticio' : undefined);
        assert.equal(body.has_more, false);
        assert.deepEqual(checks.map(check => check.featureKey).sort(), ['consents.view', 'leads.sensitive.view', 'patients.sensitive.view']);
        if (!patientSensitive) assert(!JSON.stringify(body).includes('Nota ficticia'), 'Notes must be redacted from hub responses');
    }
});
test('public patient aliases resolve only after clinic authorization and retain the appointment clinic filter', async () => {
    let identityQuery, appointmentQuery, body;
    const { getAppointmentHubList } = handler('exports.getAppointmentHubList =', '\nexports.getCitas =', {
        require: () => ({ parseAppointmentHubQuery }), Op,
        denyAppointmentViewAccessIfNeeded: async (_req, _res, clinicId) => { assert.equal(clinicId, 82); return false; },
        Paciente: { findOne: async query => { identityQuery = query; return { id_paciente: 7 }; } },
        CitaPaciente: { findAll: async query => { appointmentQuery = query; return []; } },
        LeadIntake: {}, Tratamiento: {}, Instalacion: {}, db: {}, protectAppointmentsForRequest: async (_, rows) => rows,
    });
    await getAppointmentHubList({ query: { clinica_id: 82, paciente_id: 'pat_fixture' } }, { json: value => body = value });
    assert.equal(identityQuery.where.public_id, 'pac_fixture');
    assert.deepEqual(Array.from(identityQuery.attributes), ['id_paciente']);
    assert.equal(appointmentQuery.where.clinica_id, 82); assert.equal(appointmentQuery.where.paciente_id, 7);
    assert.equal(body.items.length, 0);
});
test('denied clinic never queries appointments or patient identifiers', async () => {
    const { getAppointmentHubList } = handler('exports.getAppointmentHubList =', '\nexports.getCitas =', {
        require: () => ({ parseAppointmentHubQuery }), denyAppointmentViewAccessIfNeeded: async () => true,
        CitaPaciente: { findAll: () => assert.fail('SQL after denial') }, Paciente: { findOne: () => assert.fail('identity lookup after denial') },
    });
    await getAppointmentHubList({ query: { clinica_id: 83, paciente_id: 'pac_fixture' } }, {});
});
test('lead-only list never matches by telephone or opens a conversation', async () => {
    let captured;
    const { getAppointmentHubList } = handler('exports.getAppointmentHubList =', '\nexports.getCitas =', {
        require: () => ({ parseAppointmentHubQuery }), Op, denyAppointmentViewAccessIfNeeded: async () => false,
        CitaPaciente: { findAll: async options => { captured = options; return []; } },
        Paciente: {}, LeadIntake: {}, Tratamiento: {}, Instalacion: {}, db: {}, protectAppointmentsForRequest: async (_, rows) => rows,
    });
    await getAppointmentHubList({ query: { clinica_id: 82, lead_id: 19 } }, { json() {} });
    assert.equal(captured.where.lead_intake_id, 19); assert.equal(captured.where.paciente_id, undefined);
});
test('history is appointment-scoped, clinic-scoped and has sensitive-data authorization', async () => {
    const activity = require('../../services/appointmentActivity.service'); let read = false, query;
    const globals = { require: () => activity, Op,
        CitaPaciente: { findByPk: async () => ({ id_cita: 3, clinica_id: 82, paciente_id: 7 }) },
        denyAppointmentViewAccessIfNeeded: async () => false,
        appointmentPrivacyCapabilities: async () => new Map([[82, { patientSensitive: false }]]),
        db: { Usuario: {}, PatientOperationalEvent: { findAll: async q => { read = true; query = q; return []; } } },
    };
    const response = { status(value) { this.code = value; return this; }, json() {} };
    await handler('exports.getAppointmentHubActivity =', '\nexports.getCitaById =', globals).getAppointmentHubActivity({ params: { id: 3 }, query: {} }, response);
    assert.equal(response.code, 403); assert.equal(read, false);
    globals.appointmentPrivacyCapabilities = async () => new Map([[82, { patientSensitive: true }]]);
    await handler('exports.getAppointmentHubActivity =', '\nexports.getCitaById =', globals).getAppointmentHubActivity({ params: { id: 3 }, query: {} }, response);
    assert.equal(query.where.clinic_id, 82); assert.equal(query.where.patient_id, 7); assert.equal(query.where['metadata.appointment_id'], 3); assert.equal(query.limit, 31);
});
