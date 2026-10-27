'use strict';

// Presence eligibility only. Appointment identities, resource keys, occupancy,
// clinical snapshots and user permissions are never rewritten here.
const crypto = require('node:crypto');
const { resolveClinicTimezone } = require('../lib/availability-calendar');
const FIELD = 'shared_schedule_source_id';
const MAX_MEMBERS = 31;
const MAX_ROWS = 1000;
const SHIFT_FIELDS = ['dia_semana', 'activo', 'hora_inicio', 'hora_fin', 'rrule', 'fecha_inicio_vigencia', 'fecha_fin_vigencia', 'created_at', 'updated_at'];
const EXCEPTION_FIELDS = ['fecha', 'cancelado', 'hora_inicio_override', 'hora_fin_override', 'creado_por', 'created_at', 'updated_at'];
const plain = row => row == null ? row : JSON.parse(JSON.stringify(row.toJSON ? row.toJSON() : row));
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const positive = value => (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
  || (typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)));
const active = value => value === true || value === 1;
const error = (suffix, message, status = 409) => Object.assign(Error(message), { code: 'personal_schedule_sharing_' + suffix, status, statusCode: status });
const need = (ok, suffix, message, status) => { if (!ok) throw error(suffix, message, status); };
const sourceId = row => row?.[FIELD] == null ? null : Number(row[FIELD]);
const clinic = row => row.clinica || row.Clinica || {};
const clinicId = row => Number(row.clinica_id);
const groupId = row => Number(clinic(row).grupoClinicaId ?? row.grupo_clinica_id);
const timezone = row => resolveClinicTimezone(clinic(row));
const name = row => String(clinic(row).nombre_clinica || row.nombre_clinica || '');
const selected = (row, fields) => Object.fromEntries(fields.filter(field => Object.hasOwn(row, field)).map(field => [field, row[field]]));

function sameSharedSchedule(a, b) {
  return positive(sourceId(a)) && sourceId(a) === sourceId(b) && positive(a?.doctor_id)
    && Number(a.doctor_id) === Number(b?.doctor_id);
}
function graph(rows) {
  const byId = new Map(rows.map(row => [Number(row.id), row]));
  need(byId.size === rows.length && new Set(rows.map(row => `${row.doctor_id}:${row.clinica_id}`)).size === rows.length
    && rows.every(row => positive(row.id) && positive(row.doctor_id) && positive(row.clinica_id)),
    'invalid', 'La relación del calendario compartido no es válida.');
  const groups = new Map();
  for (const row of rows) {
    if (sourceId(row) == null) continue;
    const source = byId.get(sourceId(row));
    need(positive(sourceId(row)) && source && Number(source.doctor_id) === Number(row.doctor_id)
      && sourceId(source) === Number(source.id), 'invalid', 'El calendario compartido contiene una fuente inválida o encadenada.');
    const members = groups.get(Number(source.id)) || []; members.push(row); groups.set(Number(source.id), members);
  }
  for (const members of groups.values()) {
    need(members.length >= 2 && members.length <= MAX_MEMBERS && members.every(row => active(row.activo)),
      'invalid', 'El calendario compartido requiere entre dos y treinta y una pertenencias activas.');
    need(positive(groupId(members[0])) && members.every(row => groupId(row) === groupId(members[0]) && timezone(row) === timezone(members[0])),
      'invalid', 'Las clínicas de un calendario compartido deben pertenecer al mismo grupo y zona horaria.');
  }
  return { byId, groups, source: row => sourceId(row) == null ? row : byId.get(sourceId(row)),
    members: row => sourceId(row) == null ? [row] : groups.get(sourceId(row)) };
}
function groupDto(source, members, revision) {
  const ordered = [...members].sort((a, b) => clinicId(a) - clinicId(b));
  return { source_clinica_id: clinicId(source), source_doctor_clinica_id: Number(source.id),
    clinic_ids: ordered.map(clinicId), clinic_names: ordered.map(name), ...(revision == null ? {} : { revision: String(revision) }) };
}
function projectRows(rows, allRows, revision) {
  const network = graph(allRows);
  return rows.map(raw => {
    const value = plain(raw), original = network.byId.get(Number(value.id));
    need(value[FIELD] === null || original, 'changed', 'La pertenencia del calendario ya no existe.');
    const row = { ...value, ...(value[FIELD] === undefined && original ? { [FIELD]: sourceId(original), doctor_id: value.doctor_id ?? original.doctor_id } : {}) };
    if (sourceId(row) == null) return row;
    need(original && sourceId(original) === sourceId(row) && Number(original.doctor_id) === Number(row.doctor_id),
      'changed', 'El calendario compartido ha cambiado. Actualiza la vista.');
    const source = network.source(original);
    return { ...row, horarios: plain(source.horarios || []), shared_schedule: groupDto(source, network.members(original), revision) };
  });
}
function includes(db) {
  return [{ model: db.Clinica, as: 'clinica', attributes: ['id_clinica', 'nombre_clinica', 'grupoClinicaId', 'configuracion'] },
    { model: db.DoctorHorario, as: 'horarios', include: [{ model: db.DoctorHorarioExcepcion, as: 'excepciones' }] }];
}
async function loadRows({ db, doctorIds, transaction, lock = false }) {
  if (lock) {
    // The outer calendar mutation already holds doctor/resource + revision
    // locks. A FOR UPDATE on the association join would also acquire Clinic X
    // after Doctor X, reversing the booking writer's Clinic -> Doctor order.
    const locked = await db.DoctorClinica.findAll({ where: { doctor_id: { [db.Sequelize.Op.in]: doctorIds } },
      attributes: ['id'], order: [['id', 'ASC']], limit: MAX_ROWS + 1, transaction,
      lock: transaction.LOCK.UPDATE, skipSharedScheduleProjection: true });
    need(locked.length <= MAX_ROWS, 'review_required', 'Hay demasiadas pertenencias para revisar este cambio.');
  }
  const query = { where: { doctor_id: { [db.Sequelize.Op.in]: doctorIds } }, include: includes(db),
    order: [['id', 'ASC']], limit: MAX_ROWS + 1, transaction, skipSharedScheduleProjection: true };
  const rows = await db.DoctorClinica.findAll(query);
  need(rows.length <= MAX_ROWS, 'review_required', 'Hay demasiadas pertenencias para revisar este cambio.');
  const values = rows.map(plain);
  need(values.every(row => doctorIds.includes(Number(row.doctor_id))), 'invalid', 'El calendario contiene otro profesional.');
  need(values.reduce((n, row) => n + (row.horarios || []).length, 0) <= 4000
    && values.reduce((n, row) => n + (row.horarios || []).reduce((sum, item) => sum + (item.excepciones || []).length, 0), 0) <= 8000,
  'review_required', 'El calendario contiene demasiados patrones o excepciones para revisar el cambio.');
  return values;
}
async function revisionOf(db, doctorId, transaction, lock = false) {
  need(db.PersonalCalendarRevision, 'unavailable', 'La versión durable del calendario no está disponible.');
  const row = await db.PersonalCalendarRevision.findByPk(doctorId, { transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}), skipSharedScheduleProjection: true });
  return String(row?.revision ?? '0');
}
async function context({ db, doctorId, transaction, lock = false }) {
  need(positive(doctorId), 'request_invalid', 'Revisa el profesional.', 400);
  const rows = await loadRows({ db, doctorIds: [Number(doctorId)], transaction, lock });
  return { rows, ...graph(rows), revision: await revisionOf(db, Number(doctorId), transaction, lock) };
}
async function projectDoctorClinicas({ db, rows, transaction = null }) {
  if (!rows?.length) return [];
  const candidates = rows.filter(row => row?.[FIELD] !== null);
  if (!candidates.length) return rows.map(plain);
  let doctorIds = [...new Set(candidates.map(row => Number(row.doctor_id)))];
  if (!doctorIds.every(positive)) {
    need(candidates.every(row => positive(row.id)), 'invalid', 'No se puede resolver la pertenencia del calendario.');
    const metadata = await db.DoctorClinica.findAll({ where: { id: { [db.Sequelize.Op.in]: candidates.map(row => Number(row.id)) } },
      attributes: ['id', 'doctor_id', FIELD], limit: MAX_ROWS + 1, transaction, skipSharedScheduleProjection: true });
    need(metadata.length === candidates.length, 'invalid', 'Alguna pertenencia ya no existe.');
    doctorIds = [...new Set(metadata.map(row => Number(row.doctor_id)))];
  }
  need(doctorIds.every(positive) && doctorIds.length <= MAX_ROWS, 'review_required', 'Revisa los profesionales del calendario.');
  const loaded = await loadRows({ db, doctorIds, transaction });
  // Standalone inputs may belong to other doctors not needing a source lookup.
  return projectRows(rows, loaded);
}
async function resolveEffectiveDoctorClinica({ db, doctorId, clinicId: target, transaction = null }) {
  const ctx = await context({ db, doctorId, transaction });
  const dc = ctx.rows.find(row => clinicId(row) === Number(target));
  need(dc, 'not_found', 'La pertenencia del profesional no existe.', 404);
  return { dc, source: ctx.source(dc), memberRows: ctx.members(dc), clinicIds: ctx.members(dc).map(clinicId).sort((a, b) => a - b), revision: ctx.revision };
}
function stateFrom(ctx, doctorId) {
  return { doctor_id: Number(doctorId), revision: ctx.revision,
    clinicas: ctx.rows.map(row => ({ clinica_id: clinicId(row), nombre_clinica: name(row), active: active(row.activo),
      recibe_citas: active(row.recibe_citas), group_id: groupId(row) || null, timezone: timezone(row),
      shared_schedule_source_id: sourceId(row), horarios_count: (ctx.source(row).horarios || []).length })),
    groups: [...ctx.groups].map(([id, members]) => groupDto(ctx.byId.get(id), members, ctx.revision)) };
}
async function getScheduleSharing(options) { return stateFrom(await context(options), options.doctorId); }
function normalizeInput(input) {
  need(input && ['link', 'unlink'].includes(input.operation) && positive(input.source_clinica_id)
    && Array.isArray(input.clinic_ids) && input.clinic_ids.length > 0 && input.clinic_ids.length <= MAX_MEMBERS
    && input.clinic_ids.every(positive) && new Set(input.clinic_ids.map(Number)).size === input.clinic_ids.length,
  'request_invalid', 'Selecciona explícitamente las clínicas y la fuente.', 400);
  need(typeof input.expected_revision === 'string' && /^(0|[1-9]\d*)$/.test(input.expected_revision)
    && BigInt(input.expected_revision) <= 18446744073709551615n, 'request_invalid', 'Revisa la versión del calendario.', 400);
  if (input.operation === 'link') need(input.same_site_confirmed === true, 'same_site_required', 'Confirma que las clínicas comparten la misma sede.', 422);
  return { operation: input.operation, source_clinica_id: Number(input.source_clinica_id), clinic_ids: input.clinic_ids.map(Number).sort((a, b) => a - b),
    expected_revision: input.expected_revision, same_site_confirmed: input.operation === 'link' };
}
const calendarSignature = rows => digest((rows || []).map(row => ({ ...selected(row, SHIFT_FIELDS.filter(field => !['created_at', 'updated_at'].includes(field))),
  excepciones: (row.excepciones || []).map(exception => selected(exception, ['fecha', 'cancelado', 'hora_inicio_override', 'hora_fin_override']))
    .sort((a, b) => digest(a).localeCompare(digest(b))) })).sort((a, b) => digest(a).localeCompare(digest(b))));
async function makePlan({ db, doctorId, input, checkAll, transaction, lock = false }) {
  const normalized = normalizeInput(input), ctx = await context({ db, doctorId, transaction, lock });
  need(ctx.revision === normalized.expected_revision, 'revision_conflict', 'La disponibilidad ha cambiado. Vuelve a revisar el vínculo.');
  const selectedRows = normalized.clinic_ids.map(id => ctx.rows.find(row => clinicId(row) === id));
  const selectedSource = ctx.rows.find(row => clinicId(row) === normalized.source_clinica_id);
  need(selectedSource && selectedRows.every(Boolean), 'not_found', 'Alguna clínica no pertenece al profesional.', 404);
  let affected, source, members;
  if (normalized.operation === 'link') {
    need(selectedRows.length >= 2 && selectedRows.some(row => Number(row.id) === Number(selectedSource.id)), 'request_invalid', 'Incluye la fuente y al menos dos clínicas.', 400);
    need(selectedRows.every(row => active(row.activo)), 'inactive', 'Todas las pertenencias deben estar activas.', 422);
    need(positive(groupId(selectedSource)) && selectedRows.every(row => groupId(row) === groupId(selectedSource)), 'group_mismatch', 'Las clínicas deben pertenecer al mismo grupo.', 422);
    need(selectedRows.every(row => timezone(row) === timezone(selectedSource)), 'timezone_mismatch', 'Las clínicas deben utilizar la misma zona horaria.', 422);
    for (const row of selectedRows) need(ctx.members(row).every(member => normalized.clinic_ids.includes(clinicId(member))),
      'partial_group', 'Incluye todo el calendario existente o desvincula primero las clínicas que salen.');
    source = ctx.source(selectedSource); members = selectedRows; affected = selectedRows;
  } else {
    need(sourceId(selectedSource) === Number(selectedSource.id) && ctx.groups.has(Number(selectedSource.id)), 'not_shared', 'La fuente ya no pertenece a ese calendario compartido.');
    members = ctx.members(selectedSource); affected = members; source = selectedSource;
    need(selectedRows.every(row => sourceId(row) === Number(source.id)), 'request_invalid', 'Sólo puedes desvincular miembros del calendario seleccionado.', 400);
  }
  const affectedIds = affected.map(clinicId).sort((a, b) => a - b);
  need(typeof checkAll === 'function' && await checkAll({ doctorId: Number(doctorId), clinicIds: affectedIds, transaction }) === true,
    'forbidden', 'Necesitas permiso para gestionar los horarios de todas las clínicas afectadas.', 403);
  const sourceSchedules = source.horarios || [];
  const blockDefinitions = db.DoctorBloqueo ? await db.DoctorBloqueo.findAll({ where: { doctor_id: Number(doctorId) },
    include: db.DoctorBloqueoExcepcion ? [{ model: db.DoctorBloqueoExcepcion, as: 'excepciones' }] : [],
    order: [['id', 'ASC']], limit: 4001, transaction }) : [];
  need(blockDefinitions.length <= 4000, 'review_required', 'Hay demasiados bloqueos para revisar el vínculo de una vez.');
  const blockScopes = require('../lib/personal-block-scope').createPersonalBlockScopes(ctx.rows);
  const affectedBlocks = blockDefinitions.filter(block => {
    const scope = blockScopes.metadata(block);
    return scope.scope !== 'global' && scope.effective_clinic_ids.some(id => affectedIds.includes(id));
  });
  let previewBytes = 1024;
  const details = { revision: ctx.revision, operation: normalized.operation, source_clinica_id: normalized.source_clinica_id,
    source_doctor_clinica_id: Number(selectedSource.id), clinic_ids: normalized.clinic_ids, affected_clinic_ids: affectedIds,
    personal_blocks: { policy: 'current_linked_group', unlink_behavior: 'anchor_only',
      count: affectedBlocks.length, definitions: affectedBlocks.map(block => ({ id: Number(block.id),
        canonical_clinica_id: block.clinica_id == null ? null : Number(block.clinica_id),
        fecha_inicio: block.fecha_inicio, fecha_fin: block.fecha_fin, recurrente: block.recurrente,
        recurrente_hasta: block.recurrente_hasta || null,
        exceptions: (block.excepciones || []).map(row => ({ fecha: row.fecha, cancelado: row.cancelado })) })) },
    differences: affected.map(row => {
      const current = ctx.source(row).horarios || [];
      const difference = { clinica_id: clinicId(row), nombre_clinica: name(row), source_count: sourceSchedules.length, current_count: current.length,
        has_differences: normalized.operation === 'link' && calendarSignature(current) !== calendarSignature(sourceSchedules),
        source_horarios: sourceSchedules.map(item => ({ ...selected(item, SHIFT_FIELDS),
          excepciones: (item.excepciones || []).map(exception => selected(exception, EXCEPTION_FIELDS)) })),
        current_horarios: current.map(item => ({ ...selected(item, SHIFT_FIELDS),
          excepciones: (item.excepciones || []).map(exception => selected(exception, EXCEPTION_FIELDS)) })),
        summary: normalized.operation === 'unlink' ? 'Se conserva una copia completa del calendario efectivo y sus excepciones.'
          : 'Se utilizará el calendario efectivo de la fuente; el horario propio anterior queda archivado.' };
      previewBytes += Buffer.byteLength(JSON.stringify(difference)) + 1;
      need(previewBytes <= 1024 * 1024, 'review_required', 'La vista previa es demasiado grande. Revisa el vínculo por partes.');
      return difference;
    }) };
  details.preview_hash = digest({ doctor_id: Number(doctorId), input: normalized, rows: ctx.rows,
    blocks: plain(blockDefinitions), details });
  need(Buffer.byteLength(JSON.stringify(details)) <= 1024 * 1024, 'review_required', 'La vista previa es demasiado grande. Revisa el vínculo por partes.');
  return { details, ctx, input: normalized, selectedSource, source, sourceSchedules, members, selectedRows };
}
async function previewScheduleSharing(options) { return (await makePlan(options)).details; }
async function replaceCalendar({ db, target, schedules, transaction }) {
  // Always materialize from the effective source before touching its rows.
  const frozen = plain(schedules);
  const existing = await db.DoctorHorario.findAll({ where: { doctor_clinica_id: Number(target.id) }, attributes: ['id'], transaction,
    lock: transaction.LOCK.UPDATE, skipSharedScheduleProjection: true });
  const ids = existing.map(row => Number(row.id));
  if (ids.length) {
    await db.DoctorHorarioExcepcion.destroy({ where: { doctor_horario_id: { [db.Sequelize.Op.in]: ids } }, transaction });
    await db.DoctorHorario.destroy({ where: { doctor_clinica_id: Number(target.id) }, transaction });
  }
  for (const row of frozen) {
    const created = await db.DoctorHorario.create({ ...selected(row, SHIFT_FIELDS), doctor_clinica_id: Number(target.id) }, { transaction, silent: true });
    const exceptions = (row.excepciones || []).map(exception => ({ ...selected(exception, EXCEPTION_FIELDS), doctor_horario_id: Number(created.id) }));
    if (exceptions.length) await db.DoctorHorarioExcepcion.bulkCreate(exceptions, { transaction, silent: true });
  }
}
async function updateSource(db, row, source, transaction) {
  if (sourceId(row) === source) return;
  const result = await db.DoctorClinica.update({ [FIELD]: source }, { where: { id: Number(row.id), doctor_id: Number(row.doctor_id), [FIELD]: sourceId(row) }, transaction });
  need(Number(Array.isArray(result) ? result[0] : result) === 1, 'changed', 'El vínculo cambió durante la operación.');
}
async function applyScheduleSharing(options) {
  const { db, transaction, input } = options;
  need(transaction?.options?.isolationLevel === 'READ COMMITTED' && transaction.LOCK?.UPDATE,
    'transaction_required', 'El vínculo debe guardarse dentro de la transacción protegida de disponibilidad.');
  need(typeof input?.preview_hash === 'string' && /^[a-f0-9]{64}$/.test(input.preview_hash), 'preview_required', 'Revisa la vista previa antes de guardar.');
  const plan = await makePlan({ ...options, lock: true });
  need(input.preview_hash === plan.details.preview_hash, 'preview_changed', 'El calendario cambió después de la vista previa. Revísalo de nuevo.');
  if (plan.input.operation === 'link') {
    if (Number(plan.selectedSource.id) !== Number(plan.source.id)) await replaceCalendar({ db, target: plan.selectedSource, schedules: plan.sourceSchedules, transaction });
    for (const row of plan.selectedRows) await updateSource(db, row, Number(plan.selectedSource.id), transaction);
  } else {
    const removed = new Set(plan.selectedRows.map(row => Number(row.id)));
    // Materialize first, then rewire. The source schedules are frozen in plan.
    for (const row of plan.selectedRows) if (Number(row.id) !== Number(plan.source.id)) await replaceCalendar({ db, target: row, schedules: plan.sourceSchedules, transaction });
    const remaining = plan.members.filter(row => !removed.has(Number(row.id)));
    if (remaining.length && removed.has(Number(plan.source.id))) {
      const next = [...remaining].sort((a, b) => Number(a.id) - Number(b.id))[0];
      await replaceCalendar({ db, target: next, schedules: plan.sourceSchedules, transaction });
      for (const row of remaining) await updateSource(db, row, remaining.length > 1 ? Number(next.id) : null, transaction);
    } else if (remaining.length === 1) await updateSource(db, remaining[0], null, transaction);
    for (const row of plan.selectedRows) await updateSource(db, row, null, transaction);
  }
  return { ...(await getScheduleSharing({ db, doctorId: options.doctorId, transaction })), preview: plan.details };
}

module.exports = { FIELD, MAX_MEMBERS, sameSharedSchedule, projectDoctorClinicas, resolveEffectiveDoctorClinica,
  getScheduleSharing, previewScheduleSharing, applyScheduleSharing, calendarSignature };
