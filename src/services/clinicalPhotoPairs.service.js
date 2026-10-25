'use strict';
const crypto = require('node:crypto'), { Op } = require('sequelize');
const C = require('../lib/clinical-episode-contract'), G = require('../lib/clinical-gallery-contract');
const S = require('./clinicalEpisodeServiceContext.service');
const { PURPOSE_FEATURE } = require('./clinicalEpisodeMaterials.service');
const IMAGES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
function createService({ db, canAccess = input => require('../lib/access-policy').canUserAccessFeature(input) } = {}) {
  const origins = S.createService({ db, canAccess });
  async function context(input, transaction, writing = false, attachment = false) {
    if (!input.actorId) throw C.error(401, 'unauthenticated', 'Inicia sesión para continuar.');
    const actorId = C.integer(input.actorId), clinicId = C.integer(input.clinicId), raw = String(input.patientIdentifier || '');
    if (!raw || raw.length > 80) throw C.error(400, 'clinical_gallery_patient_invalid', 'Selecciona un paciente válido.');
    const features = ['patients.view', 'patients.sensitive.view', attachment ? 'patients.edit' : writing ? 'clinical.reports.manage' : 'clinical.reports.view'];
    if ((await Promise.all(features.map(featureKey => canAccess({ actorId, clinicId, featureKey })))).some(value => !value)) throw C.error(403, 'clinical_gallery_forbidden', 'No tienes permiso para esta biblioteca clínica.');
    const patient = await db.Paciente.findOne({ where: /^[1-9]\d*$/.test(raw) ? { id_paciente: C.integer(raw) } : { public_id: raw },
      transaction, ...(writing ? { lock: transaction.LOCK.UPDATE } : {}) });
    if (!patient || Number(patient.clinica_id) !== clinicId && !(db.PacienteClinica && await db.PacienteClinica.findOne({ where: { paciente_id: patient.id_paciente, clinica_id: clinicId }, transaction }))) throw C.error(404, 'clinical_gallery_patient_not_found', 'Paciente no encontrado en esta clínica.');
    return { patientId: Number(patient.id_paciente), clinicId, actorId };
  }
  async function states(assets, transaction) {
    if (!assets.length || !db.ClinicalAttachmentLibraryState) return new Map();
    const rows = await db.ClinicalAttachmentLibraryState.findAll({ where: { asset_id: { [Op.in]: assets.map(asset => Number(asset.id)) } }, transaction });
    return new Map(rows.map(row => [Number(row.asset_id), row]));
  }
  async function asset(publicId, ctx, transaction, { selecting = false, imageOnly = false } = {}) {
    const row = await db.ClinicalPrivateAsset.findOne({ where: { public_id: G.id(publicId), patient_id: ctx.patientId, clinic_id: ctx.clinicId,
      scope_type: 'clinic', status: 'active', purpose: { [Op.in]: Object.keys(PURPOSE_FEATURE) } }, transaction,
      ...(transaction ? { lock: transaction.LOCK.SHARE } : {}) });
    if (!row || imageOnly && !IMAGES.includes(row.content_type)) throw C.error(404, 'clinical_gallery_asset_not_found', 'El archivo no está disponible para este paciente y clínica.');
    if (!await canAccess({ actorId: ctx.actorId, clinicId: ctx.clinicId, featureKey: PURPOSE_FEATURE[row.purpose] })) throw C.error(403, 'clinical_gallery_asset_forbidden', 'No tienes permiso para este archivo clínico.');
    if (selecting) {
      const state = db.ClinicalAttachmentLibraryState && await db.ClinicalAttachmentLibraryState.findByPk(row.id, { transaction, ...(transaction ? { lock: transaction.LOCK.SHARE } : {}) });
      if (state?.status === 'archived') throw C.error(409, 'clinical_gallery_asset_archived', 'Este archivo está oculto en la biblioteca. Selecciona otro original.');
    }
    return row;
  }
  async function resolveScope(payload, ctx, transaction) {
    const service = payload.service_ref == null ? null : S.reference(payload.service_ref);
    const values = await origins.values({ payload: { ...(service ? { service_ref: service } : {}), ...(payload.treatment_id != null ? { treatment_id: payload.treatment_id } : {}) },
      ...ctx, transaction, creating: true });
    let treatmentName = null;
    if (values.treatment_id && db.Tratamiento && db.Clinica) {
      try {
        const clinic = await db.Clinica.findByPk(ctx.clinicId, { transaction });
        const treatment = await require('./treatmentBookingProfile.service').loadScopedTreatment({ db, treatmentId: values.treatment_id, clinic, transaction });
        treatmentName = treatment.nombre || null;
      } catch (error) { if (![404, 409].includes(error.statusCode || error.status)) throw error; }
    }
    return { service_ref: values.service_ref || null, treatment_id: values.treatment_id || null, treatment_name: treatmentName };
  }
  const scopeKey = scope => C.hash(scope.service_ref ? S.identity(scope.service_ref) : scope.treatment_id ? { treatment_id: Number(scope.treatment_id) } : null);
  function scopeDto(scope) { return { service_ref: S.identity(G.json(scope.service_ref)), treatment_id: scope.treatment_id ? Number(scope.treatment_id) : null }; }
  async function episodeMatches(row, scope, ctx, transaction) {
    if (!scope.service_ref && !scope.treatment_id) return true;
    if (scope.service_ref && S.same(G.json(row.service_ref), scope.service_ref)) return true;
    if (!scope.service_ref && Number(row.treatment_id) === Number(scope.treatment_id)) return true;
    const ids = new Set(row.appointment_id ? [Number(row.appointment_id)] : []);
    if (db.ClinicalEpisodeAppointment) for (const link of await db.ClinicalEpisodeAppointment.findAll({ where: { report_id: row.id, patient_id: ctx.patientId, clinic_id: ctx.clinicId }, transaction })) ids.add(Number(link.appointment_id));
    if (!ids.size || !db.CitaPaciente) return false;
    const appointments = await db.CitaPaciente.findAll({ where: { id_cita: { [Op.in]: [...ids] }, paciente_id: ctx.patientId, clinica_id: ctx.clinicId }, transaction });
    for (const appointment of appointments) {
      if (!scope.service_ref && Number(appointment.tratamiento_id) === Number(scope.treatment_id)) return true;
      if (scope.service_ref && (await origins.candidates(appointment, { ...ctx, transaction })).some(candidate => S.same(candidate, scope.service_ref))) return true;
    }
    return false;
  }
  async function validateSide(value, ctx, scope, transaction, previous) {
    const source = await asset(value.asset_id, ctx, transaction, { selecting: !previous || value.asset_id !== previous.asset_id, imageOnly: true });
    // A title edit or a full client PATCH must not repin an existing side to
    // the source episode's latest revision. Its previously validated snapshot
    // survives later unlinking; current patient/clinic/purpose ACL still apply.
    if (previous && value.asset_id === previous.asset_id && (value.episode_id || null) === (previous.episode_id || null)) return { ...previous, internal_asset_id: Number(source.id) };
    let episode = null;
    if (value.episode_id) {
      episode = await db.AppointmentClinicalReport.findOne({ where: { public_id: value.episode_id, patient_id: ctx.patientId, clinic_id: ctx.clinicId }, transaction });
      if (!episode || !(G.json(episode.material_refs) || []).some(ref => ref.kind === 'attachment' && ref.id === value.asset_id)) throw C.error(404, 'clinical_photo_pair_episode_not_found', 'La foto no está vinculada a ese episodio de este paciente.');
      if (!await episodeMatches(episode, scope, ctx, transaction)) throw C.error(409, 'clinical_photo_pair_service_mismatch', 'La foto del episodio no corresponde al servicio elegido.');
    } else if (scope.service_ref || scope.treatment_id) {
      const origin = G.json(source.metadata)?.clinical_context;
      // Old unscoped originals can be associated explicitly. An original that
      // already has a canonical service must never be silently reassigned.
      if (origin && (origin.service_ref || origin.treatment_id)) {
        const matches = scope.service_ref ? S.same(origin.service_ref, scope.service_ref)
          : Number(origin.treatment_id) === Number(scope.treatment_id);
        if (!matches) throw C.error(409, 'clinical_photo_pair_service_mismatch', 'La foto original corresponde a otro servicio.');
      }
    }
    // Originals and episode references remain untouched. This is a separate,
    // versioned comparison, including when its source episode is already final.
    return { asset_id: source.public_id, episode_id: episode?.public_id || null, episode_version: episode ? Number(episode.version_number) : null,
      title: source.original_filename || 'Fotografía clínica', mime_type: source.content_type, internal_asset_id: Number(source.id) };
  }
  const publicSide = value => value ? Object.fromEntries(Object.entries(G.json(value)).filter(([key]) => key !== 'internal_asset_id')) : null;
  function dto(row) {
    return { id: row.public_id, patient_id: Number(row.patient_id), clinic_id: Number(row.clinic_id), title: row.title,
      scope: scopeDto(row), service_title: G.json(row.service_ref)?.title || null, before: publicSide(row.before_photo), after: publicSide(row.after_photo),
      version: Number(row.version_number), archived: row.status === 'archived', created_at: row.created_at, updated_at: row.updated_at };
  }
  async function validateRead(item, ctx, transaction) {
    for (const side of [item.before, item.after]) await asset(side.asset_id, ctx, transaction, { imageOnly: true });
    return item;
  }
  async function pair(id, ctx, transaction, lock = false) {
    const row = await db.ClinicalPhotoPair.findOne({ where: { public_id: G.id(id), patient_id: ctx.patientId, clinic_id: ctx.clinicId }, transaction,
      ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) });
    if (!row) throw C.error(404, 'clinical_photo_pair_not_found', 'Comparación no encontrada.'); return row;
  }
  function filterScope(query) {
    let ref = query.service_ref;
    if (typeof ref === 'string') { ref = G.json(ref); if (!ref) throw C.error(400, 'clinical_gallery_scope_invalid', 'Selecciona un servicio válido.'); }
    return { service_ref: ref ? S.reference(ref) : null, treatment_id: query.treatment_id != null ? C.integer(query.treatment_id, 'treatment_id') : null };
  }
  async function list(input) {
    const ctx = await context(input), query = input.query || {}, limit = query.limit == null ? 30 : C.integer(query.limit, 'limit');
    if (limit > 100) throw C.error(400, 'clinical_gallery_limit', 'Solicita como máximo cien comparaciones.');
    const status = query.status || 'active', mode = query.scope || (query.service_ref || query.treatment_id ? 'service' : 'patient'), scope = filterScope(query);
    if (!['active', 'archived', 'all'].includes(status) || !['patient', 'service'].includes(mode) || mode === 'service' && !scope.service_ref && !scope.treatment_id) throw C.error(400, 'clinical_gallery_scope_invalid', 'Selecciona un ámbito válido para las comparaciones.');
    const token = C.hash([ctx.patientId, ctx.clinicId, status, mode, mode === 'service' ? scopeKey(scope) : null]), cursor = C.decodeCursor(query.cursor);
    if (cursor && cursor.scope !== token) throw C.error(400, 'clinical_gallery_cursor', 'La página no corresponde a esta galería.');
    const where = { patient_id: ctx.patientId, clinic_id: ctx.clinicId, ...(status !== 'all' ? { status } : {}), ...(mode === 'service' ? { scope_key: scopeKey(scope) } : {}), ...(cursor ? { id: { [Op.lt]: C.integer(cursor.id) } } : {}) };
    const rows = await db.ClinicalPhotoPair.findAll({ where, order: [['id', 'DESC']], limit: limit + 1 }), items = [];
    for (const row of rows.slice(0, limit)) try { items.push(await validateRead(dto(row), ctx)); } catch (error) { if (![403, 404].includes(error.statusCode)) throw error; }
    return { items, next_cursor: rows.length > limit ? C.encodeCursor({ scope: token, id: Number(rows[limit - 1].id) }) : null };
  }
  async function get(input) {
    const ctx = await context(input), row = await pair(input.id, ctx);
    if (input.version != null && input.version !== '') {
      const saved = await db.ClinicalPhotoPairRevision.findOne({ where: { pair_id: row.id, version_number: C.integer(input.version, 'version') } });
      if (!saved) throw C.error(404, 'clinical_photo_pair_version_not_found', 'Versión no encontrada.');
      return { item: await validateRead(G.json(saved.snapshot), ctx), historical: Number(input.version) !== Number(row.version_number) };
    }
    return { item: await validateRead(dto(row), ctx), historical: false };
  }
  async function revision(row, ctx, type, transaction, commandKey = null, commandHash = null) {
    await db.ClinicalPhotoPairRevision.create({ pair_id: row.id, version_number: row.version_number, snapshot: dto(row),
      before_asset_id: row.before_asset_id, after_asset_id: row.after_asset_id,
      actor_id: ctx.actorId, change_type: type, command_key: commandKey, command_hash: commandHash }, { transaction });
  }
  async function create(input) {
    const payload = input.payload || {}, parsed = G.pairInput(payload, true), requested = { service_ref: payload.service_ref ? S.reference(payload.service_ref) : null, treatment_id: payload.treatment_id != null ? C.integer(payload.treatment_id) : null };
    const creationHash = C.hash({ title: parsed.title, ...requested, before: parsed.before, after: parsed.after });
    return db.sequelize.transaction(async transaction => {
      const ctx = await context(input, transaction, true);
      const existing = await db.ClinicalPhotoPair.findOne({ where: { patient_id: ctx.patientId, clinic_id: ctx.clinicId, idempotency_key: parsed.idempotency_key }, transaction, lock: transaction.LOCK.UPDATE });
      if (existing) {
        if (existing.creation_hash !== creationHash) throw C.error(409, 'clinical_gallery_request_conflict', 'Esta solicitud ya creó otra comparación.');
        const saved = await db.ClinicalPhotoPairRevision.findOne({ where: { pair_id: existing.id, version_number: 1 }, transaction });
        return { item: await validateRead(G.json(saved.snapshot), ctx, transaction), created: false, replayed: true };
      }
      const scope = await resolveScope(requested, ctx, transaction);
      if (parsed.before.asset_id === parsed.after.asset_id) throw C.error(400, 'clinical_photo_pair_duplicate', 'Selecciona dos fotos diferentes.');
      const before = await validateSide(parsed.before, ctx, scope, transaction), after = await validateSide(parsed.after, ctx, scope, transaction);
      const row = await db.ClinicalPhotoPair.create({ public_id: crypto.randomUUID(), patient_id: ctx.patientId, clinic_id: ctx.clinicId,
        title: parsed.title, ...scope, scope_key: scopeKey(scope), before_photo: publicSide(before), after_photo: publicSide(after), before_asset_id: before.internal_asset_id, after_asset_id: after.internal_asset_id, status: 'active', version_number: 1,
        idempotency_key: parsed.idempotency_key, creation_hash: creationHash, created_by: ctx.actorId, updated_by: ctx.actorId }, { transaction });
      await revision(row, ctx, 'created', transaction, parsed.idempotency_key, creationHash);
      return { item: dto(row), created: true, replayed: false };
    });
  }
  async function mutate(input, archive = false) {
    const payload = input.payload || {}, parsed = G.pairInput(payload), expected = G.expected(payload);
    if (archive && Object.keys(payload).some(key => !['clinic_id', 'expected_version', 'idempotency_key'].includes(key))) throw C.error(400, 'clinical_photo_pair_invalid', 'Revisa la solicitud de archivo.');
    const commandHash = C.hash({ type: archive ? 'archived' : 'updated', expected, title: parsed.title, before: parsed.before, after: parsed.after });
    return db.sequelize.transaction(async transaction => {
      const ctx = await context(input, transaction, true), row = await pair(input.id, ctx, transaction, true);
      if (parsed.idempotency_key) {
        const saved = await db.ClinicalPhotoPairRevision.findOne({ where: { pair_id: row.id, command_key: parsed.idempotency_key }, transaction, lock: transaction.LOCK.SHARE });
        if (saved) {
          if (saved.command_hash !== commandHash) throw C.error(409, 'clinical_gallery_request_conflict', 'Esta solicitud ya se utilizó para otro cambio.');
          return { item: await validateRead(G.json(saved.snapshot), ctx, transaction), replayed: true };
        }
      }
      if (Number(row.version_number) !== expected) throw C.error(409, 'clinical_gallery_version_conflict', 'La comparación ha cambiado. Revisa la versión actual antes de guardar.');
      if (row.status !== 'active') throw C.error(409, 'clinical_photo_pair_archived', 'Esta comparación está archivada. Sus versiones se conservan.');
      const scope = { service_ref: G.json(row.service_ref), treatment_id: row.treatment_id }, before = parsed.before || G.json(row.before_photo), after = parsed.after || G.json(row.after_photo);
      if (before.asset_id === after.asset_id) throw C.error(400, 'clinical_photo_pair_duplicate', 'Selecciona dos fotos diferentes.');
      const changes = archive ? { status: 'archived' } : { ...(parsed.title !== undefined ? { title: parsed.title } : {}) };
      if (!archive) for (const key of ['before', 'after']) if (parsed[key]) {
        const saved = await validateSide(parsed[key], ctx, scope, transaction, G.json(row[key + '_photo']));
        changes[key + '_photo'] = publicSide(saved); changes[key + '_asset_id'] = saved.internal_asset_id;
      }
      await validateRead(dto(row), ctx, transaction);
      await row.update({ ...changes, version_number: expected + 1, updated_by: ctx.actorId }, { transaction });
      await revision(row, ctx, archive ? 'archived' : 'updated', transaction, parsed.idempotency_key, commandHash);
      return { item: dto(row), replayed: false };
    });
  }
  async function libraryCommand(input, archive = false) {
    const payload = input.payload || {}, expected = G.expected(payload), key = C.idempotencyKey(payload.idempotency_key);
    if (Object.keys(payload).some(field => !['clinic_id', 'expected_version', 'idempotency_key', ...(archive ? [] : ['classification'])].includes(field))) throw C.error(400, 'clinical_attachment_library_invalid', 'Revisa los campos del archivo.');
    const classification = archive ? null : G.classification(payload.classification, true), commandHash = C.hash({ archive, expected, classification });
    return db.sequelize.transaction(async transaction => {
      const ctx = await context(input, transaction, true, true), source = await asset(input.id, ctx, transaction);
      if (classification === 'photo' && !IMAGES.includes(source.content_type)) throw C.error(400, 'clinical_attachment_photo_invalid', 'Sólo una imagen puede clasificarse como foto.');
      let state = await db.ClinicalAttachmentLibraryState.findByPk(source.id, { transaction, lock: transaction.LOCK.UPDATE });
      if (key) {
        const saved = await db.ClinicalAttachmentLibraryRevision.findOne({ where: { asset_id: source.id, command_key: key }, transaction, lock: transaction.LOCK.SHARE });
        if (saved) {
          if (saved.command_hash !== commandHash) throw C.error(409, 'clinical_gallery_request_conflict', 'Esta solicitud ya se utilizó para otro cambio.');
          return { item: G.json(saved.snapshot), replayed: true };
        }
      }
      const current = G.libraryItem(source, state);
      if (current.library_version !== expected) throw C.error(409, 'clinical_gallery_version_conflict', 'El archivo ha cambiado. Revisa su versión actual.');
      if (current.library_status !== 'active') throw C.error(409, 'clinical_attachment_archived', 'El archivo está oculto de la biblioteca. El original y sus referencias se conservan.');
      if (!state) {
        state = await db.ClinicalAttachmentLibraryState.create({ asset_id: source.id, clinic_id: ctx.clinicId, patient_id: ctx.patientId,
          classification: current.classification, status: current.library_status, version_number: expected, updated_by: ctx.actorId }, { transaction });
        await db.ClinicalAttachmentLibraryRevision.create({ asset_id: source.id, version_number: expected, snapshot: { id: source.public_id, ...current }, actor_id: ctx.actorId, change_type: 'baseline' }, { transaction });
      }
      await state.update({ ...(archive ? { status: 'archived' } : { classification }), version_number: expected + 1, updated_by: ctx.actorId }, { transaction });
      const item = { id: source.public_id, ...G.libraryItem(source, state) };
      await db.ClinicalAttachmentLibraryRevision.create({ asset_id: source.id, version_number: state.version_number, snapshot: item, actor_id: ctx.actorId,
        change_type: archive ? 'archived' : 'classified', command_key: key, command_hash: commandHash }, { transaction });
      return { item, replayed: false };
    });
  }
  return { context, states, asset, resolveScope, scopeKey, filterScope, episodeMatches, list, get, create,
    save: input => mutate(input), archive: input => mutate(input, true), classifyAttachment: input => libraryCommand(input), archiveAttachment: input => libraryCommand(input, true) };
}
let singleton;
module.exports = { createService, IMAGES, ...Object.fromEntries(['list', 'get', 'create', 'save', 'archive', 'classifyAttachment', 'archiveAttachment'].map(method => [method, input => {
  singleton ||= createService({ db: require('../../models') }); return singleton[method](input);
}])) };
