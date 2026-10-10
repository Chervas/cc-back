'use strict';

const crypto = require('node:crypto');
const MAX_PAGE_SIZE = 5;
const CURSOR_LIFETIME_MS = 60 * 60 * 1000;
const DOMAIN = 'clinicaclick-appointment-calendar-search-v1\0';

function fail(message = 'La búsqueda o su página no es válida.', status = 400) {
    const error = new Error(message);
    error.status = status;
    error.code = 'appointment_search_invalid';
    throw error;
}

function positive(value) {
    return /^\d+$/.test(String(value ?? '')) && Number.isSafeInteger(Number(value)) && Number(value) > 0;
}

function parseAppointmentCalendarSearch(raw = {}) {
    if (typeof raw.clinica_id !== 'string' && typeof raw.clinica_id !== 'number') fail();
    const ids = String(raw.clinica_id).split(',');
    if (!ids.length || ids.length > 20 || ids.some(id => !positive(id))) fail('Indica un ámbito de clínicas válido.');
    const clinicIds = [...new Set(ids.map(Number))].sort((a, b) => a - b);
    if (raw.query != null && typeof raw.query !== 'string') fail();
    const query = String(raw.query || '').normalize('NFC').trim().replace(/\s+/g, ' ');
    if (query.length > 100 || /[\x00-\x1f\x7f]/.test(query)) fail();
    if (query && [...query].length < 2 && !/^\d+$/.test(query)) fail('Escribe al menos dos letras o un número de historia.');
    const period = raw.period == null ? 'today' : raw.period;
    if (!['today', 'future', 'past'].includes(period)) fail();
    if (raw.limit != null && !positive(raw.limit)) fail();
    if (raw.cursor != null && (typeof raw.cursor !== 'string' || raw.cursor.length > 2000 || !raw.cursor)) fail();
    return { clinicId: clinicIds.length === 1 ? clinicIds[0] : null,
        ...(clinicIds.length > 1 ? { clinicIds } : {}), query, period,
        limit: Math.min(Number(raw.limit || MAX_PAGE_SIZE), MAX_PAGE_SIZE), cursor: raw.cursor || null };
}

function validDay(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(value + 'T00:00:00Z');
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const queryDigest = query => crypto.createHash('sha256').update(query.toLocaleLowerCase('es')).digest('hex');
function sign(payload, key) {
    if (typeof key !== 'string' || !key) fail('No se puede paginar la búsqueda en este momento.', 503);
    return crypto.createHmac('sha256', key).update(DOMAIN).update(payload).digest('base64url');
}

function decodeCursor(token, key) {
    const parts = token.split('.');
    if (parts.length !== 2 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) fail();
    const expected = Buffer.from(sign(parts[0], key));
    const provided = Buffer.from(parts[1]);
    if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) fail();
    try { return JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); }
    catch { fail(); }
}

// The clinic's civil day is pinned across pages, including a midnight change.
// A cursor is not an authorization grant: the route rechecks both permissions
// before every query and ties this token to the requesting actor and scope.
function appointmentSearchPlan(q, { actorId, timeZone, currentDay, clinics, key, now = Date.now(), boundsForDay }) {
    if (q.clinicIds) return groupSearchPlan(q, { actorId, clinics, key, now, boundsForDay });
    if (!positive(actorId) || !validDay(currentDay) || typeof boundsForDay !== 'function') fail();
    let day = currentDay;
    let position = null;
    let expiresAt = now + CURSOR_LIFETIME_MS;
    if (q.cursor) {
        const c = decodeCursor(q.cursor, key);
        if (c.v !== 1 || c.c !== q.clinicId || c.a !== Number(actorId) || c.p !== q.period
            || c.q !== queryDigest(q.query) || c.z !== timeZone || !validDay(c.d)
            || !positive(c.id) || !Number.isSafeInteger(c.t) || c.t < 0
            || !Number.isSafeInteger(c.e) || c.e <= now || c.e > now + CURSOR_LIFETIME_MS) fail();
        day = c.d;
        position = { start: new Date(c.t), id: c.id };
        expiresAt = c.e;
    }
    const bounds = boundsForDay(day, timeZone);
    if (!bounds || !Number.isFinite(bounds.start?.getTime()) || !Number.isFinite(bounds.end?.getTime())) fail();
    return { ...q, day, timeZone, actorId: Number(actorId), expiresAt, position,
        startOfDay: bounds.start, nextDay: new Date(bounds.end.getTime() + 1),
        direction: q.period === 'past' ? 'DESC' : 'ASC' };
}

function appointmentSearchCursor(plan, row, key) {
    const start = new Date(row.inicio).getTime();
    if (!Number.isFinite(start) || !positive(row.id_cita)) fail();
    const scope = plan.clinics ? { v: 2, c: plan.clinicIds, z: zoneDigest(plan.clinics), d: plan.clinics.map(clinic => clinic.clinic_day) }
        : { v: 1, c: plan.clinicId, z: plan.timeZone, d: plan.day };
    const payload = Buffer.from(JSON.stringify({ ...scope, a: plan.actorId, p: plan.period,
        q: queryDigest(plan.query), t: start,
        id: Number(row.id_cita), e: plan.expiresAt })).toString('base64url');
    return payload + '.' + sign(payload, key);
}

function appointmentSearchWhere(plan, Op) {
    if (plan.clinics) {
        const branches = plan.clinics.map(clinic => appointmentSearchWhere({ ...plan, clinics: null,
            clinicId: clinic.clinic_id, startOfDay: clinic.startOfDay, nextDay: clinic.nextDay, position: null }, Op));
        const filters = [{ [Op.or]: branches }];
        if (plan.position) {
            const cmp = plan.direction === 'DESC' ? Op.lt : Op.gt;
            filters.push({ [Op.or]: [{ inicio: { [cmp]: plan.position.start } },
                { inicio: plan.position.start, id_cita: { [cmp]: plan.position.id } }] });
        }
        return { [Op.and]: filters };
    }
    const day = plan.period === 'today' ? { inicio: { [Op.gte]: plan.startOfDay, [Op.lt]: plan.nextDay } }
        : { inicio: { [plan.period === 'past' ? Op.lt : Op.gte]: plan.period === 'past' ? plan.startOfDay : plan.nextDay } };
    const filters = [{ clinica_id: plan.clinicId }, day];
    if (plan.position) {
        const cmp = plan.direction === 'DESC' ? Op.lt : Op.gt;
        filters.push({ [Op.or]: [{ inicio: { [cmp]: plan.position.start } },
            { inicio: plan.position.start, id_cita: { [cmp]: plan.position.id } }] });
    }
    return { [Op.and]: filters };
}

const zoneDigest = clinics => crypto.createHash('sha256')
    .update(JSON.stringify(clinics.map(clinic => [clinic.clinic_id, clinic.time_zone]))).digest('hex');

function groupSearchPlan(q, { actorId, clinics, key, now, boundsForDay }) {
    if (!positive(actorId) || !Array.isArray(clinics) || clinics.length !== q.clinicIds.length
        || typeof boundsForDay !== 'function' || clinics.some((clinic, index) => clinic.clinic_id !== q.clinicIds[index]
            || !validDay(clinic.clinic_day) || typeof clinic.time_zone !== 'string')) fail();
    let days = clinics.map(clinic => clinic.clinic_day), position = null, expiresAt = now + CURSOR_LIFETIME_MS;
    if (q.cursor) {
        const c = decodeCursor(q.cursor, key);
        if (c.v !== 2 || JSON.stringify(c.c) !== JSON.stringify(q.clinicIds) || c.a !== Number(actorId)
            || c.p !== q.period || c.q !== queryDigest(q.query) || c.z !== zoneDigest(clinics)
            || !Array.isArray(c.d) || c.d.length !== clinics.length || c.d.some(day => !validDay(day))
            || !positive(c.id) || !Number.isSafeInteger(c.t) || c.t < 0
            || !Number.isSafeInteger(c.e) || c.e <= now || c.e > now + CURSOR_LIFETIME_MS) fail();
        days = c.d; position = { start: new Date(c.t), id: c.id }; expiresAt = c.e;
    }
    const scoped = clinics.map((clinic, index) => {
        const bounds = boundsForDay(days[index], clinic.time_zone);
        if (!bounds || !Number.isFinite(bounds.start?.getTime()) || !Number.isFinite(bounds.end?.getTime())) fail();
        return { ...clinic, clinic_day: days[index], startOfDay: bounds.start, nextDay: new Date(bounds.end.getTime() + 1) };
    });
    return { ...q, clinics: scoped, day: scoped[0].clinic_day, timeZone: scoped[0].time_zone,
        actorId: Number(actorId), expiresAt, position, direction: q.period === 'past' ? 'DESC' : 'ASC' };
}

// Bound LIKE patterns, never SQL fragments. Treat wildcard input literally.
function patientSearchWhere(query, Sequelize) {
    if (!query) return undefined;
    const { Op, fn, col, where } = Sequelize;
    const fullName = fn('CONCAT_WS', ' ', col('paciente.nombre'), col('paciente.apellidos'));
    return { [Op.and]: query.split(' ').map(token => {
        const pattern = '%' + token.replace(/[\\%_]/g, value => '\\' + value) + '%';
        return { [Op.or]: [where(fullName, { [Op.like]: pattern }), { numero_historia: { [Op.like]: pattern } }] };
    }) };
}

module.exports = { parseAppointmentCalendarSearch, appointmentSearchPlan, appointmentSearchCursor,
    appointmentSearchWhere, patientSearchWhere, MAX_PAGE_SIZE };
