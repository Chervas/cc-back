'use strict';
const crypto = require('node:crypto');
const TTL_MS = 20000;
const TABLES = {
  DoctorClinica: ['id', 'doctor_id', 'clinica_id', 'activo', 'recibe_citas', 'allow_overlap_confirmation', 'agenda_flexible', 'allow_legacy_attention_confirmation', 'rol_en_clinica', 'created_at', 'updated_at'],
  DoctorHorario: ['id', 'doctor_clinica_id', 'dia_semana', 'activo', 'hora_inicio', 'hora_fin', 'rrule', 'fecha_inicio_vigencia', 'fecha_fin_vigencia', 'created_at', 'updated_at'],
  DoctorHorarioExcepcion: ['id', 'doctor_horario_id', 'fecha', 'cancelado', 'hora_inicio_override', 'hora_fin_override', 'creado_por', 'created_at', 'updated_at'],
  DoctorBloqueo: ['id', 'doctor_id', 'clinica_id', 'fecha_inicio', 'fecha_fin', 'tipo', 'motivo', 'recurrente', 'recurrente_hasta', 'aplica_a_todas_clinicas', 'creado_por', 'created_at', 'updated_at'],
  DoctorBloqueoExcepcion: ['id', 'doctor_bloqueo_id', 'fecha', 'cancelado', 'creado_por', 'created_at', 'updated_at'],
};
function undoError(code, message, status = 409) { return Object.assign(Error(message), { code, status }); }
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const tokenHash = token => crypto.createHash('sha256').update(token).digest('hex');
const json = value => typeof value === 'string' ? JSON.parse(value) : value;
const clean = (row, fields) => {
  const plain = JSON.parse(JSON.stringify(row.toJSON ? row.toJSON() : row));
  return Object.fromEntries(fields.filter(field => Object.hasOwn(plain, field)).map(field => [field, plain[field]]));
};
async function loadSnapshot({ db, doctorIds, transaction }) {
  const { Op } = db.Sequelize;
  const snapshot = {};
  const load = async (table, where) => {
    if (!Reflect.ownKeys(where).length) return [];
    const rows = await db[table].findAll({ where, attributes: TABLES[table], order: [['id', 'ASC']], limit: 4001, transaction });
    if (rows.length > 4000) throw undoError('availability_undo_review_required', 'El cambio es demasiado grande para deshacerlo en una sola operación.');
    return rows.map(row => clean(row, TABLES[table])).sort((a, b) => Number(a.id) - Number(b.id));
  };
  snapshot.DoctorClinica = await load('DoctorClinica', { doctor_id: { [Op.in]: doctorIds } });
  const links = snapshot.DoctorClinica.map(row => row.id);
  snapshot.DoctorHorario = links.length ? await load('DoctorHorario', { doctor_clinica_id: { [Op.in]: links } }) : [];
  const schedules = snapshot.DoctorHorario.map(row => row.id);
  snapshot.DoctorHorarioExcepcion = schedules.length ? await load('DoctorHorarioExcepcion', { doctor_horario_id: { [Op.in]: schedules } }) : [];
  snapshot.DoctorBloqueo = await load('DoctorBloqueo', { doctor_id: { [Op.in]: doctorIds } });
  const blocks = snapshot.DoctorBloqueo.map(row => row.id);
  snapshot.DoctorBloqueoExcepcion = blocks.length ? await load('DoctorBloqueoExcepcion', { doctor_bloqueo_id: { [Op.in]: blocks } }) : [];
  if (Buffer.byteLength(JSON.stringify(snapshot)) > 1024 * 1024) throw undoError('availability_undo_review_required', 'El cambio es demasiado grande para deshacerlo en una sola operación.');
  return snapshot;
}
async function lockRevisions({ db, doctorIds, transaction }) {
  if (!db.PersonalCalendarRevision) return null;
  const rows = [];
  for (const doctorId of [...doctorIds].sort((a, b) => a - b)) {
    await db.PersonalCalendarRevision.findOrCreate({ where: { doctor_id: doctorId }, defaults: { revision: 0 }, transaction });
    const row = await db.PersonalCalendarRevision.findByPk(doctorId, { transaction, lock: transaction.LOCK.UPDATE });
    rows.push([doctorId, row]);
  }
  return rows;
}
async function bumpRevisions({ db, doctorIds, transaction }) {
  const rows = await lockRevisions({ db, doctorIds, transaction });
  if (!rows) return null;
  const revisions = {};
  for (const [doctorId, row] of rows) {
    const next = BigInt(String(row.revision)) + 1n;
    await row.update({ revision: next.toString() }, { transaction }); revisions[doctorId] = next.toString();
  }
  return revisions;
}
async function createReceipt({ db, doctorIds, actorId, before, after, revisions, transaction, enabled = true, now = new Date() }) {
  if (digest(before) === digest(after)) return null;
  if (!enabled && undoMayReduceAvailability(changesBetween(before, after))) return null;
  // Opportunistic bounded retention: no worker, provider or patient write.
  const expired = await db.PersonalCalendarUndoReceipt.findAll({
    where: { expires_at: { [db.Sequelize.Op.lt]: new Date(new Date(now).getTime() - 86400000) } },
    attributes: ['id'], order: [['expires_at', 'ASC']], limit: 200, transaction });
  if (expired.length) await db.PersonalCalendarUndoReceipt.destroy({
    where: { id: { [db.Sequelize.Op.in]: expired.map(row => row.id) } }, transaction });
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(new Date(now).getTime() + TTL_MS);
  await db.PersonalCalendarUndoReceipt.create({ id: crypto.randomUUID(), token_hash: tokenHash(token),
    actor_user_id: actorId, doctor_ids: doctorIds, revisions, before_state: before, after_state: after,
    post_sha256: digest(after), expires_at: expiresAt, consumed_at: null }, { transaction });
  return { token, expires_at: expiresAt.toISOString(), label: 'Cambio de disponibilidad' };
}
function changesBetween(before, after) {
  return Object.fromEntries(Object.keys(TABLES).map(table => {
    const old = new Map((before[table] || []).map(row => [Number(row.id), row]));
    const next = new Map((after[table] || []).map(row => [Number(row.id), row]));
    const changes = [...new Set([...old.keys(), ...next.keys()])].sort((a, b) => a - b)
      .filter(id => digest(old.get(id) || null) !== digest(next.get(id) || null))
      .map(id => ({ id, before: old.get(id) || null, after: next.get(id) || null }));
    return [table, changes];
  }));
}
// The legacy booking writer does not share an empty-range resource mutex.
// With that writer active, only offer inverses proved to add or keep capacity.
// Unknown metadata/overrides are deliberately classified as potentially unsafe.
function undoMayReduceAvailability(changes) {
  const rows = table => changes[table] || [];
  const same = (a, b, ignored = []) => digest(Object.fromEntries(Object.entries(a).filter(([key]) => !ignored.includes(key))))
    === digest(Object.fromEntries(Object.entries(b).filter(([key]) => !ignored.includes(key))));
  const audit = ['id', 'created_at', 'updated_at', 'creado_por'];
  for (const { before, after } of rows('DoctorClinica')) {
    if (!before) return true; // Removing a link, even a currently empty one.
    if (!after) continue;
    if (before.activo !== true && after.activo !== false) return true;
    if (!same(before, after, [...audit, 'activo'])) return true;
  }
  for (const { before, after } of rows('DoctorHorario')) {
    if (!after) continue; // Restoring a deleted pattern only adds its coverage.
    if (after.activo === false) continue;
    if (!before || before.activo !== true || after.activo !== true) return true;
    if (!same(before, after, [...audit, 'hora_inicio', 'hora_fin'])) return true;
    const hm = value => typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
    if (![before.hora_inicio, before.hora_fin, after.hora_inicio, after.hora_fin].every(hm)
      || before.hora_inicio >= before.hora_fin || after.hora_inicio >= after.hora_fin
      || before.hora_inicio > after.hora_inicio || before.hora_fin < after.hora_fin) return true;
  }
  for (const { before, after } of rows('DoctorHorarioExcepcion')) {
    const exception = before || after;
    const parent = rows('DoctorHorario').find(row => row.id === Number(exception.doctor_horario_id));
    if (parent && !parent.after) continue; // Part of a wholly restored pattern.
    if (!before) {
      if (after.cancelado === true || (after.cancelado === false && !after.hora_inicio_override && !after.hora_fin_override)) continue;
      return true;
    }
    if (!after) {
      if (before.cancelado === false && !before.hora_inicio_override && !before.hora_fin_override) continue;
      return true;
    }
    if (before.doctor_horario_id !== after.doctor_horario_id || before.fecha !== after.fecha) return true;
    if (after.cancelado === true) continue;
    if (before.cancelado !== false || after.cancelado !== false || !same(before, after, audit)) return true;
  }
  for (const { before, after } of rows('DoctorBloqueo')) {
    if (!before) continue; // Removing a newly created block only frees capacity.
    if (!after || !same(before, after, [...audit, 'motivo', 'tipo'])) return true;
  }
  for (const { before, after } of rows('DoctorBloqueoExcepcion')) {
    const exception = before || after;
    const parent = rows('DoctorBloqueo').find(row => row.id === Number(exception.doctor_bloqueo_id));
    if (parent && !parent.before) continue; // Its entire block is being removed.
    if (!before) { if (after.cancelado !== false) return true; continue; }
    if (!after) continue; // Restoring a cancellation removes blocking coverage.
    if (before.doctor_bloqueo_id !== after.doctor_bloqueo_id || before.fecha !== after.fecha) return true;
    if (before.cancelado !== true && (before.cancelado !== false || after.cancelado !== false)) return true;
  }
  return false;
}
function changedScopes(before, after, changes) {
  const scopes = [];
  const scheduleScope = (snapshot, id) => {
    const schedule = snapshot.DoctorHorario.find(row => Number(row.id) === Number(id));
    const link = schedule && snapshot.DoctorClinica.find(row => Number(row.id) === Number(schedule.doctor_clinica_id));
    if (link) scopes.push({ kind: 'horario', doctorId: Number(link.doctor_id), clinicId: Number(link.clinica_id) });
  };
  for (const table of Object.keys(TABLES)) for (const change of changes[table]) for (const side of ['before', 'after']) {
    const row = change[side], snapshot = side === 'before' ? before : after;
    if (!row) continue;
    if (table === 'DoctorClinica') scopes.push({ kind: 'horario', doctorId: Number(row.doctor_id), clinicId: Number(row.clinica_id) });
    else if (table === 'DoctorHorario') scheduleScope(snapshot, row.id);
    else if (table === 'DoctorHorarioExcepcion') scheduleScope(snapshot, row.doctor_horario_id);
    else {
      const block = table === 'DoctorBloqueo' ? row : snapshot.DoctorBloqueo.find(block => Number(block.id) === Number(row.doctor_bloqueo_id));
      if (block) scopes.push({ kind: 'bloqueo', doctorId: Number(block.doctor_id), clinicId: block.clinica_id == null ? null : Number(block.clinica_id) });
    }
  }
  return [...new Map(scopes.map(scope => [JSON.stringify(scope), scope])).values()];
}
async function restoreChanges({ db, changes, transaction }) {
  // Remove children before parents; recreate parents before children. Only the
  // actual difference is restored: unchanged clinics and rows are never written.
  for (const table of ['DoctorHorarioExcepcion', 'DoctorBloqueoExcepcion', 'DoctorHorario', 'DoctorBloqueo']) {
    const ids = changes[table].filter(change => !change.before).map(change => change.id);
    if (ids.length) await db[table].destroy({ where: { id: { [db.Sequelize.Op.in]: ids } }, transaction });
  }
  for (const table of Object.keys(TABLES)) for (const change of changes[table]) {
    if (!change.before) continue;
    const fields = { ...change.before }; delete fields.updated_at;
    if (change.after) {
      delete fields.id; delete fields.created_at;
      // Schedule creation can reactivate an existing link. Undo that activation,
      // but never rewrite receives-appointments, overlap, role or flexible flags.
      const restore = table === 'DoctorClinica' ? { activo: fields.activo } : fields;
      await db[table].update(restore, { where: { id: change.id }, transaction });
    } else await db[table].create(fields, { transaction });
  }
  // A moved row can still refer to a newly-created destination link until it
  // has been restored to its original link. Remove those destination links last.
  const removedLinks = changes.DoctorClinica.filter(change => !change.before).map(change => change.id);
  if (removedLinks.length) await db.DoctorClinica.destroy({ where: { id: { [db.Sequelize.Op.in]: removedLinks } }, transaction });
}
async function undoAvailability({ db, actorId, token, assertPermissions, validateRestored, now = () => new Date(), calendarOptions = {} }) {
  if (!Number.isSafeInteger(actorId) || actorId <= 0) throw undoError('availability_undo_forbidden', 'No tienes permiso para deshacer este cambio.', 403);
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw undoError('availability_undo_not_found', 'No se encontró el cambio que quieres deshacer.', 404);
  const where = { token_hash: tokenHash(token), actor_user_id: actorId };
  const receipt = await db.PersonalCalendarUndoReceipt.findOne({ where, attributes: ['id', 'doctor_ids'] });
  if (!receipt) throw undoError('availability_undo_not_found', 'No se encontró el cambio que quieres deshacer.', 404);
  const doctorIds = json(receipt.doctor_ids).map(Number);
  const enabled = calendarOptions.enabled ?? require('./treatmentBookingProfile.service').bookingCapabilities().simple;
  let locked, scopes;
  const result = await require('./appointmentCalendarMutation.service').withCalendarMutation({ ...calendarOptions,
    db, doctorIds, enabled, protectLegacyAppointments: true,
    mutate: async transaction => {
      locked = await db.PersonalCalendarUndoReceipt.findOne({ where, transaction, lock: transaction.LOCK.UPDATE });
      if (!locked) throw undoError('availability_undo_not_found', 'No se encontró el cambio que quieres deshacer.', 404);
      if (locked.consumed_at) throw undoError('availability_undo_consumed', 'Este cambio ya se ha deshecho.', 410);
      if (new Date(locked.expires_at) <= now()) throw undoError('availability_undo_expired', 'El tiempo para deshacer ha terminado.', 410);
      const expectedRevisions = json(locked.revisions);
      for (const doctorId of [...doctorIds].sort((a, b) => a - b)) {
        const revision = await db.PersonalCalendarRevision.findByPk(doctorId, { transaction, lock: transaction.LOCK.UPDATE });
        if (!revision || String(revision.revision) !== String(expectedRevisions[doctorId])) {
          throw undoError('availability_undo_conflict', 'La disponibilidad ha cambiado después. No se puede deshacer este cambio.');
        }
      }
      const current = await loadSnapshot({ db, doctorIds, transaction });
      if (digest(current) !== locked.post_sha256) throw undoError('availability_undo_conflict', 'La disponibilidad ha cambiado después. No se puede deshacer este cambio.');
      const before = json(locked.before_state), after = json(locked.after_state), changes = changesBetween(before, after);
      if (!enabled && undoMayReduceAvailability(changes)) throw undoError('availability_undo_legacy_unsafe',
        'No se puede deshacer este cambio de forma segura en este momento. La disponibilidad se conserva.');
      scopes = changedScopes(before, after, changes);
      if (!assertPermissions || !await assertPermissions(scopes, transaction)) {
        throw undoError('availability_undo_forbidden', 'Ya no tienes permiso para deshacer este cambio.', 403);
      }
      await restoreChanges({ db, changes, transaction });
      if (validateRestored) await validateRestored({ before, after, changes, doctorIds, transaction });
      return { undone: true, doctor_ids: doctorIds, clinica_ids: [...new Set(scopes.map(scope => scope.clinicId).filter(id => id != null))] };
    },
    onValidated: async transaction => {
      if (new Date(locked.expires_at) <= now()) throw undoError('availability_undo_expired', 'El tiempo para deshacer ha terminado.', 410);
      await locked.update({ consumed_at: now() }, { transaction });
    },
  });
  return result;
}
function sendUndoError(error, res) {
  if (!/^availability_undo_/.test(error?.code || '')) return false;
  res.status(error.status || 409).json({ code: error.code, message: error.message }); return true;
}
module.exports = { TTL_MS, TABLES, loadSnapshot, digest, lockRevisions, bumpRevisions, createReceipt, changesBetween, undoMayReduceAvailability, changedScopes,
  restoreChanges, undoAvailability, sendUndoError };
