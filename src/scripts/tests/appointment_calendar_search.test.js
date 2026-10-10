'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Sequelize = require('sequelize');
const { Op } = Sequelize;
const search = require('../../lib/appointment-calendar-search');
const key = 'synthetic-only-key';
const now = Date.parse('2026-10-10T12:00:00Z');
const boundsForDay = day => ({ start: new Date(day + 'T00:00:00Z'), end: new Date(day + 'T23:59:59.999Z') });
const context = overrides => ({ actorId: 99, timeZone: 'UTC', currentDay: '2026-10-10', key, now, boundsForDay, ...overrides });
const query = overrides => search.parseAppointmentCalendarSearch({ clinica_id: '72', ...overrides });
const plan = (overrides, ctx) => search.appointmentSearchPlan(query(overrides), context(ctx));

test('one explicit clinic, civil periods and at most five cards; no patient-selection parameters', () => {
    assert.deepEqual(query(), { clinicId: 72, query: '', period: 'today', limit: 5, cursor: null });
    assert.equal(query({ query: '  Ana   Pérez ', limit: 999 }).query, 'Ana Pérez');
    assert.equal(query({ query: '7' }).query, '7');
    for (const invalid of [{ clinica_id: '72,66' }, { clinica_id: '72bad' }, { clinica_id: -1 },
        { query: ['Ana'] }, { query: 'a' }, { query: 'a'.repeat(101) }, { period: 'later' },
        { limit: '0' }, { limit: '2x' }, { cursor: {} }, { cursor: '' }]) {
        assert.throws(() => query(invalid), error => error.status === 400);
    }
});

test('Hoy contains the whole clinic civil day; Futuras/Pasadas do not split today by clock time', () => {
    for (const period of ['today', 'future', 'past']) {
        const p = plan({ period });
        const filters = search.appointmentSearchWhere(p, Op)[Op.and];
        assert.equal(filters[0].clinica_id, 72);
        if (period === 'today') {
            assert.equal(filters[1].inicio[Op.gte].toISOString(), '2026-10-10T00:00:00.000Z');
            assert.equal(filters[1].inicio[Op.lt].toISOString(), '2026-10-11T00:00:00.000Z');
        } else assert.equal(filters[1].inicio[period === 'past' ? Op.lt : Op.gte].toISOString(),
            period === 'past' ? '2026-10-10T00:00:00.000Z' : '2026-10-11T00:00:00.000Z');
        assert.equal(p.direction, period === 'past' ? 'DESC' : 'ASC');
    }
});

test('cursor binds clinic, actor, query, period and timezone; fixes clinic day over midnight', () => {
    const first = plan({ query: 'Ana' });
    const cursor = search.appointmentSearchCursor(first, { id_cita: 17, inicio: '2026-10-10T18:00:00Z' }, key);
    const next = plan({ query: 'ana', cursor }, { currentDay: '2026-10-11', now: now + 1000 });
    assert.equal(next.day, '2026-10-10');
    assert.equal(next.position.id, 17);
    const filters = search.appointmentSearchWhere(next, Op)[Op.and];
    assert.equal(filters[2][Op.or][0].inicio[Op.gt].toISOString(), '2026-10-10T18:00:00.000Z');
    assert.equal(filters[2][Op.or][1].id_cita[Op.gt], 17);
    for (const [overrides, ctx] of [[{ clinica_id: 66 }, {}], [{ query: 'Bea' }, {}], [{ period: 'past' }, {}],
        [{}, { actorId: 98 }], [{}, { timeZone: 'Europe/Madrid' }], [{}, { key: 'other' }],
        [{}, { now: now + 3600000 }]]) {
        assert.throws(() => plan({ query: 'Ana', cursor, ...overrides }, ctx), error => error.status === 400);
    }
    assert.throws(() => plan({ query: 'Ana', cursor: cursor.slice(0, -2) + 'AA' }));
    assert.throws(() => plan({ cursor: 'not.a.cursor' }));
    assert.throws(() => search.appointmentSearchCursor(first, { id_cita: 17, inicio: 'bad' }, key));
    assert.throws(() => search.appointmentSearchCursor(first, { id_cita: 17, inicio: '2026-10-10' }, ''), error => error.status === 503);
});

test('same-start keyset uses id tie-breaker in descending past lists, never OFFSET', () => {
    const first = plan({ period: 'past' });
    const cursor = search.appointmentSearchCursor(first, { id_cita: 9, inicio: '2026-10-09T18:00:00Z' }, key);
    const next = plan({ period: 'past', cursor });
    const clause = search.appointmentSearchWhere(next, Op)[Op.and][2][Op.or];
    assert(clause[0].inicio[Op.lt]);
    assert.equal(clause[1].id_cita[Op.lt], 9);
    assert.equal(next.position.start.toISOString(), '2026-10-09T18:00:00.000Z');
});

test('name tokens span nombre/apellidos and HC; percent/underscore input is literal, no raw SQL', () => {
    assert.equal(search.patientSearchWhere('', Sequelize), undefined);
    const w = search.patientSearchWhere('Ana P_%', Sequelize)[Op.and];
    assert.equal(w.length, 2);
    assert.equal(w[0][Op.or][1].numero_historia[Op.like], '%Ana%');
    assert.equal(w[1][Op.or][1].numero_historia[Op.like], '%P\\_\\%%');
    assert.equal(w[0][Op.or][0].attribute.fn, 'CONCAT_WS');
    assert.equal(w[0][Op.or][0].attribute.args[1].col, 'paciente.nombre');
    assert.equal(w[0][Op.or][0].attribute.args[2].col, 'paciente.apellidos');
});

const source = fs.readFileSync(require.resolve('../../controllers/citas.controller'), 'utf8');
function handler(overrides = {}) {
    const calls = { reads: 0, bulk: 0, protections: 0 };
    const rows = Array.from({ length: 6 }, (_, i) => ({ id_cita: i + 1, clinica_id: 72,
        paciente_id: 7, inicio: new Date('2026-10-10T10:00:00Z'), paciente: { nombre: 'QA' } }));
    const globals = { exports: {}, asyncHandler: fn => fn, Op, process: { env: { JWT_SECRET: key } },
        denyAppointmentViewAccessIfNeeded: async () => false, canUserAccessFeature: async () => true,
        buildClinicCalendarScope: async () => ({ timeZones: new Map([[72, 'UTC']]) }), DEFAULT_TIMEZONE: 'Europe/Madrid',
        formatDateLocal: () => '2026-10-10', buildCalendarRangeForTimeZone: boundsForDay,
        Paciente: {}, Instalacion: {}, Tratamiento: {}, db: { Usuario: {} }, plainCita: row => row,
        CitaPaciente: { findAll: async options => { calls.reads++; calls.options = options; return rows; } },
        attachAppointmentProgramContexts: async (_, page) => { calls.bulk++; assert.equal(page.length, 5); },
        mapCalendarCitaRow: row => row,
        protectAppointmentsForRequest: async (_, page) => { calls.protections++; assert.equal(page.length, 5); return page; },
        require: name => {
            if (name === '../lib/appointment-calendar-search') return search;
            if (name === 'sequelize') return Sequelize;
            if (name === '../services/appointmentCardIndicators.service') return { attach: async (_, page) => { calls.bulk++; assert.equal(page.length, 5); } };
            assert.fail('Unexpected dependency ' + name);
        }, ...overrides };
    const start = source.indexOf('exports.searchCalendarAppointments =');
    const end = source.indexOf('\nexports.unlinkPatientAppointments =', start);
    vm.runInNewContext(source.slice(start, end), globals);
    const response = { headers: {}, set(name, value) { this.headers[name] = value; },
        status(code) { this.code = code; return this; }, json(value) { this.body = value; } };
    return { run: (q = {}) => globals.exports.searchCalendarAppointments({ query: { clinica_id: 72, ...q }, userData: { userId: 99 } }, response), calls, response };
}

test('route queries one joined five-card page, protects identity and preserves canonical card data', async () => {
    const h = handler(); await h.run({ query: 'QA' });
    assert.equal(h.calls.reads, 1);
    assert.equal(h.calls.options.limit, 6);
    assert.equal(h.calls.options.offset, undefined);
    assert.equal(h.calls.options.where[Op.and][0].clinica_id, 72);
    assert.deepEqual(Array.from(h.calls.options.order[1]), ['id_cita', 'ASC']);
    const patient = h.calls.options.include.find(item => item.as === 'paciente');
    assert.equal(patient.required, true);
    assert(patient.where[Op.and]);
    assert(!patient.attributes.includes('telefono_movil'));
    assert.equal(h.calls.bulk, 2); assert.equal(h.calls.protections, 1);
    assert.equal(h.response.body.items.length, 5);
    assert.equal(h.response.body.has_more, true);
    assert(h.response.body.next_cursor);
    assert.equal(h.response.body.clinic_day, '2026-10-10');
    assert.equal(h.response.headers['Cache-Control'], 'private, no-store');
});

test('denied agenda or sensitive patient permission performs no identity or appointment SQL', async () => {
    for (const overrides of [{ denyAppointmentViewAccessIfNeeded: async () => true }, { canUserAccessFeature: async () => false }]) {
        const h = handler(overrides); await h.run({ query: 'QA' });
        assert.equal(h.calls.reads, 0); assert.equal(h.calls.bulk, 0); assert.equal(h.calls.protections, 0);
        if (overrides.canUserAccessFeature) assert.equal(h.response.code, 403);
    }
});

test('registered GET-only before dynamic id; never mutates lifecycle, notifications, purchases or availability', () => {
    const routes = fs.readFileSync(require.resolve('../../routes/citas.routes'), 'utf8');
    assert(routes.indexOf("router.get('/calendar-search'") < routes.indexOf("router.get('/:id'"));
    const start = source.indexOf('exports.searchCalendarAppointments =');
    const code = source.slice(start, source.indexOf('\nexports.unlinkPatientAppointments =', start));
    assert.doesNotMatch(code, /\.update\(|\.create\(|\.destroy\(|\.save\(|syncScheduled|enqueue|emitAppointment|mutateAppointmentBooking/);
});
