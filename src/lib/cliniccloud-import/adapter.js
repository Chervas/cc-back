'use strict';

const crypto = require('crypto');

const ADAPTER_VERSION = 'cliniccloud-offline/1.0.0';
const TIMEZONE = 'Europe/Madrid';
const norm = (v) => String(v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().replace(/\s+/g, ' ').toUpperCase();
const clean = (v) => String(v ?? '').trim();
const hash = (v) => crypto.createHash('sha256').update(typeof v === 'string' || Buffer.isBuffer(v) ? v : stableJson(v)).digest('hex');
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((v) => stableJson(v ?? null)).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).filter((k) => value[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
function index(rows, key) {
  const result = new Map();
  for (const row of rows) { const k = key(row); if (k !== null && k !== undefined && k !== '') { if (!result.has(k)) result.set(k, []); result.get(k).push(row); } }
  return result;
}
function dateOnly(value) {
  const text = clean(value);
  const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s|$)/.exec(text);
  const ymd = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s]|$)/.exec(text);
  const parts = dmy ? [dmy[3], dmy[2].padStart(2, '0'), dmy[1].padStart(2, '0')] : ymd?.slice(1);
  if (!parts) return null;
  const iso = parts.join('-');
  const epoch = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(epoch) && new Date(epoch).toISOString().slice(0, 10) === iso ? iso : null;
}
function localDateTime(day, time) {
  const date = dateOnly(day);
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(clean(time));
  if (!date || !m || +m[1] > 23 || +m[2] > 59 || +(m[3] || 0) > 59) return null;
  return `${date}T${m[1].padStart(2, '0')}:${m[2]}:${m[3] || '00'}`;
}
const madridFormatter = new Intl.DateTimeFormat('sv-SE', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
function utcToLocal(value) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  const p = Object.fromEntries(madridFormatter.formatToParts(ms).map((part) => [part.type, part.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}
// Only Europe/Madrid is supported. Checking both real offsets rejects the DST
// gap and fold instead of silently choosing a different appointment time.
function localToUtc(value) {
  if (!value) return null;
  const pseudoUtc = Date.parse(`${value}Z`);
  if (!Number.isFinite(pseudoUtc)) return null;
  const candidates = [60, 120].map((offset) => new Date(pseudoUtc - offset * 60000).toISOString()).filter((iso) => utcToLocal(iso) === value);
  return candidates.length === 1 ? candidates[0] : null;
}
function provenance(record, fileHash, entity) {
  const rowHash = hash(record.values);
  return { file_sha256: fileHash, source_row: record.source_row, row_sha256: rowHash, row_key: `${entity}:${fileHash}:${record.source_row}:${rowHash}` };
}
const NEW_STATUSES = { PENDIENTE: 'pendiente', REALIZADA: 'completada', PAGADA: 'completada', 'ANULADA (CLINICA)': 'cancelada', 'ANULADA (CONTACTO)': 'cancelada' };
const OLD_STATUSES = { '0': 'pendiente', '1': 'completada', '3': 'completada', '-1': 'cancelada', '-2': 'cancelada' };
function normalizeContacts(records, fileHash, historical = false) {
  return records.map((record) => {
    const r = record.values;
    // Deliberate allowlist: WHATSAPP is not a patient field, consent, opt-in,
    // opt-out, blocker or consent evidence. Its original bytes stay in source.
    const names = historical ? { name: 'nombre', surname: 'apellidos', email: 'email', phone: 'tele1', national_id: 'dni', birth_date: 'fechanac' } : { name: 'NOMBRE', surname: 'APELLIDOS', email: 'EMAIL', phone: 'TELF. MOVIL', national_id: 'DNI', birth_date: 'F. NACIMIENTO' };
    return {
      source_contact_id: clean(r[historical ? 'idContacto' : 'IDCONTACTO']),
      history_number: clean(r[historical ? 'num' : 'NUM']),
      fields: Object.fromEntries(Object.entries(names).map(([key, column]) => [key, key === 'birth_date' ? dateOnly(r[column]) || '' : clean(r[column])])),
      source_state: clean(r[historical ? 'estado' : 'ESTADO']),
      provenance: provenance(record, fileHash, 'contact'),
    };
  });
}
function normalizeAppointments(records, fileHash, { historical = false, agendas = [], services = [], serviceTypes = [] } = {}) {
  const agendaById = index(agendas, (r) => clean(r.values.idAgenda));
  const serviceById = index(services, (r) => clean(r.values.idServicio));
  const typeById = index(serviceTypes, (r) => clean(r.values.idTipoServicio));
  return records.map((record) => {
    const r = record.values;
    const start = localDateTime(r[historical ? 'fechaIni' : 'FECHA'], r[historical ? 'horaIni' : 'HORA INICIO']);
    const end = localDateTime(r[historical ? 'fechaFin' : 'FECHA'], r[historical ? 'horaFin' : 'HORA FIN']);
    const service = historical ? serviceById.get(clean(r.idServicio))?.[0]?.values : null;
    const sourceState = clean(r[historical ? 'estado' : 'ESTADO']);
    const serviceType = typeById.get(clean(service?.idTipoServicio))?.[0]?.values.nombre;
    const kind = historical ? (norm(serviceType || service?.nombre) === 'BLOQUEO' ? 'block' : 'appointment') : (norm(r['TIPO SERVICIO']) === 'BLOQUEO' ? 'block' : 'appointment');
    const sourceId = historical ? clean(r.idCita) : clean(r.IDCITA);
    const result = {
      kind, source_external_id: sourceId || null,
      source_contact_id: clean(r[historical ? 'idContacto' : 'IDCONTACTO']),
      start_local: start, end_local: end, start_utc: localToUtc(start), end_utc: localToUtc(end),
      agenda_key: norm(historical ? agendaById.get(clean(r.idAgenda))?.[0]?.values.nombre : r.AGENDA),
      service_key: norm(historical ? service?.nombre : r.SERVICIOS),
      source_agenda_id: historical ? clean(r.idAgenda) : null,
      source_service_id: historical ? clean(r.idServicio) : null,
      status: (historical ? OLD_STATUSES[sourceState] : NEW_STATUSES[norm(sourceState)]) || null,
      source_state: sourceState,
      source_paid_state: !historical && norm(sourceState) === 'PAGADA',
      installation_label: historical ? null : clean(r['SALA/BOX']) || null,
      subject: clean(r[historical ? 'asunto' : 'ASUNTO']),
      details: clean(r[historical ? 'detalles' : 'DETALLES']),
      provenance: provenance(record, fileHash, kind),
    };
    result.validation_errors = [];
    if (!result.start_utc || !result.end_utc || result.start_utc >= result.end_utc) result.validation_errors.push('INVALID_OR_AMBIGUOUS_TIME');
    if (!result.status) result.validation_errors.push('UNKNOWN_SOURCE_STATE');
    if (kind === 'appointment' && !result.source_contact_id) result.validation_errors.push('MISSING_CONTACT_ID');
    if (!result.agenda_key) result.validation_errors.push('MISSING_AGENDA');
    return result;
  });
}
function normalizeAlerts(records, fileHash, contacts, historical = []) {
  const byHistory = index(contacts, (r) => r.history_number);
  const old = historical.map((record) => ({ source_external_id: clean(record.values.idAviso), source_contact_id: clean(record.values.idEntidad), body: norm(record.values.detalles), contact_due_at: localDateTime(record.values.fecha, clean(record.values.fecha).split(' ')[1] || '00:00') }));
  const oldExact = index(old, (r) => stableJson([r.source_contact_id, r.body, r.contact_due_at]));
  const oldBody = index(old, (r) => stableJson([r.source_contact_id, r.body]));
  const rows = records.map((record) => {
    const r = record.values;
    const details = clean(r.Detalles);
    const history = /^\s*(\d+)\.\s*/.exec(details)?.[1] || null;
    const isGeneral = norm(r.Tipo) === 'ALERTA GENERAL';
    const patients = !isGeneral && history ? byHistory.get(history) || [] : [];
    const contactId = patients.length === 1 ? patients[0].source_contact_id : null;
    const bracket = /\[[^\]]*\]/.exec(details);
    const body = bracket ? details.slice(bracket.index + bracket[0].length).trim() : details.replace(/^\s*\d+\.\s*/, '');
    const contactDue = localDateTime(r.Fecha, clean(r.Fecha).split(' ')[1] || '00:00');
    const status = { PROGRAMADA: 'pending', FINALIZADA: 'closed', ANULADA: 'cancelled' }[norm(r.Estado)] || null;
    const exact = oldExact.get(stableJson([contactId, norm(body), contactDue])) || [];
    const other = oldBody.get(stableJson([contactId, norm(body)])) || [];
    return {
      kind: isGeneral ? 'general_alert' : 'followup', source_external_id: exact.length === 1 ? exact[0].source_external_id : null,
      source_contact_id: contactId, history_number: history, contact_due_at: contactDue,
      target_date: null, status, details, body,
      provenance: provenance(record, fileHash, 'alert'),
      validation_errors: [!status && 'UNKNOWN_ALERT_STATE', !contactDue && 'INVALID_ALERT_DATE', !isGeneral && patients.length !== 1 && 'AMBIGUOUS_OR_MISSING_HISTORY_NUMBER', exact.length > 1 && 'AMBIGUOUS_HISTORIC_ALERT', !exact.length && other.length > 0 && 'POSSIBLE_CHANGED_ALERT_DATE'].filter(Boolean),
    };
  });
  const ids = index(rows, (r) => r.source_external_id);
  for (const row of rows) if (row.source_external_id && ids.get(row.source_external_id).length > 1) { row.validation_errors.push('AMBIGUOUS_HISTORIC_ALERT'); row.source_external_id = null; }
  return rows;
}

module.exports = { ADAPTER_VERSION, TIMEZONE, norm, clean, hash, stableJson, index, dateOnly, localDateTime, utcToLocal, localToUtc, normalizeContacts, normalizeAppointments, normalizeAlerts };
