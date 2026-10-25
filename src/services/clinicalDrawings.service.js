'use strict';
const crypto = require('node:crypto');
const { Op } = require('sequelize');
const { validateDrawingDocument, VIEWS } = require('../lib/clinical-drawing-document');
const { requireExpectedVersion, assertCurrentVersion } = require('../lib/clinical-report-version');
const contract = require('../lib/clinical-episode-contract');
const fail = (code, message, statusCode = 400) => { throw Object.assign(new Error(message), { code, statusCode }); };
const plain = row => row?.toJSON ? row.toJSON() : row;
const integer = value => { try { return contract.integer(value); } catch { return null; } };
const title = value => typeof value === 'string' && value.trim() && value.trim().length <= 180
  ? value.trim() : fail('clinical_drawing_title_invalid', 'Escribe un título de hasta 180 caracteres.');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function createService({ db, canAccess, readAsset = asset => require('./clinicalPrivateStorage.service').readClinicalPrivateAsset(asset),
  getPdfPageCount = buffer => require('./clinicalAttachmentPreview.service').getPdfPageCount(buffer), now = () => new Date() }) {
  async function context({ patientIdentifier, clinicId, actorId }, transaction = null, write = false) {
    const clinic = integer(clinicId), actor = integer(actorId);
    if (!actor) fail('unauthenticated', 'Inicia sesión para continuar.', 401);
    if (!clinic) fail('clinic_scope_required', 'Selecciona una clínica.');
    const raw = String(patientIdentifier || '');
    if (!raw || raw.length > 80) fail('clinical_drawing_patient_invalid', 'Selecciona un paciente válido.');
    const patient = await db.Paciente.findOne({ where: /^[1-9]\d*$/.test(raw) ? { id_paciente: contract.integer(raw, 'patient_id') } : { public_id: raw },
      transaction, ...(write ? { lock: transaction.LOCK.UPDATE } : {}) });
    if (!patient) fail('patient_not_found', 'Paciente no encontrado.', 404);
    const membership = Number(patient.clinica_id) === clinic || db.PacienteClinica && await db.PacienteClinica.findOne({ where: { paciente_id: patient.id_paciente, clinica_id: clinic }, transaction });
    if (!membership) fail('clinical_drawing_forbidden', 'El paciente no pertenece a esta clínica.', 403);
    for (const featureKey of ['patients.view', 'patients.sensitive.view', write ? 'clinical.reports.manage' : 'clinical.reports.view']) {
      if (!await canAccess({ actorId: actor, clinicId: clinic, featureKey })) fail('clinical_drawing_forbidden', 'No tienes permiso para acceder a este registro clínico.', 403);
    }
    return { patientId: Number(patient.id_paciente), clinicId: clinic, actorId: actor };
  }
  async function sourceAsset(publicId, ctx, transaction, imageOnly = false) {
    if (typeof publicId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(publicId)) fail('clinical_drawing_source_invalid', 'Selecciona una prueba válida.');
    const asset = await db.ClinicalPrivateAsset.findOne({ where: { public_id: publicId, patient_id: ctx.patientId,
      clinic_id: ctx.clinicId, scope_type: 'clinic', status: 'active', purpose: 'clinical_attachment' }, transaction });
    const allowed = imageOnly ? ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'] : ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (!asset || !allowed.includes(asset.content_type)) fail('clinical_drawing_source_not_found', 'La prueba no está disponible para este paciente y clínica.', 404);
    return asset;
  }
  async function validatePhotos(document, ctx, transaction) {
    const photos = [...new Set(Object.values(document.views).flatMap(view => view.photos.map(photo => photo.id)))];
    for (const id of photos) await sourceAsset(id, ctx, transaction, true);
  }
  async function validateSourceDocument(document, asset, ctx, transaction) {
    if (!asset) return;
    const current = await sourceAsset(asset.public_id, ctx, transaction);
    const keys = Object.keys(document.views);
    if (current.content_type !== 'application/pdf') {
      if (keys.some(key => key !== 'original')) fail('clinical_drawing_source_view_invalid', 'La imagen original tiene una única vista.');
      return;
    }
    if (keys.some(key => !/^page-[1-9]\d{0,2}$/.test(key))) fail('clinical_drawing_source_view_invalid', 'Selecciona la página del PDF que vas a anotar.');
    const { buffer } = await readAsset(current);
    const count = await getPdfPageCount(buffer);
    if (keys.some(key => Number(key.slice(5)) > count)) fail('clinical_drawing_source_view_invalid', 'Una de las páginas no existe en el PDF original.');
  }
  function snapshot(row) {
    const value = plain(row);
    return { id: value.public_id, clinic_id: Number(value.clinic_id), patient_id: Number(value.patient_id),
      title: value.title, template_key: value.template_key, template_version: Number(value.template_version || 1), document: value.document,
      version: Number(value.version_number), status: value.status,
      source_asset_id: value.source_asset_id || null, created_by: Number(value.created_by), updated_by: Number(value.updated_by),
      created_at: value.created_at || null, updated_at: value.updated_at || null };
  }
  async function serialize(row, transaction = null) {
    const item = snapshot(row);
    if (item.source_asset_id) {
      const asset = await db.ClinicalPrivateAsset.findByPk(item.source_asset_id, { transaction });
      if (!asset || asset.status !== 'active' || asset.scope_type !== 'clinic' || asset.purpose !== 'clinical_attachment'
        || Number(asset.patient_id) !== item.patient_id || Number(asset.clinic_id) !== item.clinic_id) {
        fail('clinical_drawing_source_not_found', 'La prueba original no está disponible.', 404);
      }
      item.source = { id: asset.public_id, title: asset.original_filename || 'Prueba del paciente', content_type: asset.content_type,
        sha256: asset.sha256, preview_path: `/api/pacientes/${item.patient_id}/clinical-attachments/${asset.public_id}/preview`,
        download_path: `/api/pacientes/${item.patient_id}/clinical-attachments/${asset.public_id}` };
    }
    delete item.source_asset_id;
    return item;
  }
  async function revision(row, actorId, changeType, transaction) {
    await db.ClinicalDrawingRevision.create({ drawing_id: row.id, version_number: row.version_number,
      snapshot: snapshot(row), actor_id: actorId, change_type: changeType }, { transaction });
  }
  async function find(publicId, ctx, transaction = null, lock = false) {
    if (typeof publicId !== 'string' || !publicId || publicId.length > 80) fail('clinical_drawing_id_invalid', 'El modelo no es válido.');
    const row = await db.ClinicalDrawing.findOne({ where: { public_id: String(publicId), clinic_id: ctx.clinicId, patient_id: ctx.patientId },
      transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) });
    if (!row) fail('clinical_drawing_not_found', 'Modelo o anotación no encontrados.', 404);
    return row;
  }
  async function list(input) {
    const ctx = await context(input), limit = input.limit === undefined ? 30 : integer(input.limit);
    if (!limit || limit > 100) fail('clinical_drawing_limit_invalid', 'Solicita como máximo 100 modelos.');
    const status = input.status || 'active';
    if (!['active', 'archived', 'all'].includes(status)) fail('clinical_drawing_status_invalid', 'El estado no es válido.');
    const asset = input.source_asset_id === undefined ? null : await sourceAsset(input.source_asset_id, ctx);
    if (asset && status !== 'active') fail('clinical_drawing_status_invalid', 'Las anotaciones de una prueba se retoman desde sus registros activos.');
    const where = { clinic_id: ctx.clinicId, patient_id: ctx.patientId, ...(status !== 'all' ? { status } : {}), ...(asset ? { source_asset_id: asset.id } : {}) };
    // Existing unfiltered cursors retain their exact scope. Source-filtered
    // pages cannot be reused for another original or broadened to the library.
    const scope = hash([ctx.clinicId, ctx.patientId, status, ...(asset ? [asset.public_id] : [])]);
    if (input.cursor) {
      const cursor = contract.decodeCursor(input.cursor);
      if (cursor.scope !== scope || !integer(cursor.id)) fail('clinical_drawing_cursor_invalid', 'La página no es válida.');
      where.id = { [Op.lt]: Number(cursor.id) };
    }
    const rows = await db.ClinicalDrawing.findAll({ where, order: [['id', 'DESC']], limit: limit + 1 });
    return { items: await Promise.all(rows.slice(0, limit).map(row => serialize(row))), next_cursor: rows.length > limit
      ? contract.encodeCursor({ scope, id: Number(rows[limit - 1].id) }) : null };
  }
  async function get(input) {
    const ctx = await context(input), row = await find(input.id, ctx);
    if (input.version !== undefined && input.version !== null && input.version !== '') {
      const version = integer(input.version);
      if (!version) fail('clinical_drawing_version_invalid', 'La versión no es válida.');
      const saved = await db.ClinicalDrawingRevision.findOne({ where: { drawing_id: row.id, version_number: version } });
      if (!saved) fail('clinical_drawing_version_not_found', 'Versión no encontrada.', 404);
      const source = saved.snapshot;
      return { item: await serialize({ ...source, public_id: source.id, version_number: source.version }), historical: version !== Number(row.version_number) };
    }
    return { item: await serialize(row), historical: false };
  }
  async function create(input) {
    if (requireExpectedVersion(input.payload) !== 0) fail('clinical_report_version_conflict', 'La nueva anotación ya tiene otra versión.', 409);
    const payload = input.payload;
    if (typeof payload.idempotency_key !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(payload.idempotency_key)) fail('clinical_drawing_idempotency_required', 'Vuelve a abrir la nueva anotación.');
    if (!Object.hasOwn(VIEWS, payload.template_key)) fail('clinical_drawing_template_invalid', 'Selecciona un modelo válido.');
    if (payload.template_version !== undefined && ![1, 2, 3].includes(payload.template_version)) fail('clinical_drawing_template_version_invalid', 'La versión del modelo anatómico no está disponible.');
    const templateVersion = payload.template_version ?? 1;
    if (payload.template_key === 'image' && templateVersion !== 1) fail('clinical_drawing_template_version_invalid', 'Las anotaciones conservan la geometría de la prueba original.');
    const document = validateDrawingDocument(payload.document, payload.template_key), normalizedTitle = title(payload.title);
    return db.sequelize.transaction(async transaction => {
      const ctx = await context(input, transaction, true);
      let asset = null;
      if (payload.template_key === 'image') {
        if (!payload.source_asset_id) fail('clinical_drawing_source_required', 'Selecciona la prueba original.');
        asset = await sourceAsset(payload.source_asset_id, ctx, transaction);
      } else if (payload.source_asset_id) fail('clinical_drawing_source_invalid', 'Un modelo anatómico no sustituye a una prueba.');
      await validatePhotos(document, ctx, transaction);
      await validateSourceDocument(document, asset, ctx, transaction);
      const creationHash = hash({ title: normalizedTitle, template_key: payload.template_key, template_version: templateVersion, source: asset?.public_id || null, document });
      const existing = await db.ClinicalDrawing.findOne({ where: { clinic_id: ctx.clinicId, patient_id: ctx.patientId, idempotency_key: payload.idempotency_key }, transaction });
      if (existing) {
        if (existing.creation_hash !== creationHash) fail('clinical_drawing_idempotency_conflict', 'Esta solicitud ya creó otro modelo. Ábrelo desde la biblioteca.', 409);
        return { item: await serialize(existing, transaction), created: false };
      }
      const row = await db.ClinicalDrawing.create({ public_id: crypto.randomUUID(), clinic_id: ctx.clinicId, patient_id: ctx.patientId,
        source_asset_id: asset?.id || null, template_key: payload.template_key, template_version: templateVersion, title: normalizedTitle, document,
        version_number: 1, status: 'active', idempotency_key: payload.idempotency_key, creation_hash: creationHash,
        created_by: ctx.actorId, updated_by: ctx.actorId }, { transaction });
      await revision(row, ctx.actorId, 'created', transaction);
      return { item: await serialize(row, transaction), created: true };
    });
  }
  async function save(input) {
    const expectedVersion = requireExpectedVersion(input.payload);
    return db.sequelize.transaction(async transaction => {
      const ctx = await context(input, transaction, true), row = await find(input.id, ctx, transaction, true);
      assertCurrentVersion(expectedVersion, row);
      const payload = input.payload, values = { updated_by: ctx.actorId, version_number: Number(row.version_number) + 1 };
      if (payload.title !== undefined) values.title = title(payload.title);
      if (payload.document !== undefined) {
        values.document = validateDrawingDocument(payload.document, row.template_key);
        await validatePhotos(values.document, ctx, transaction);
        if (row.source_asset_id) {
          const asset = await db.ClinicalPrivateAsset.findByPk(row.source_asset_id, { transaction });
          if (!asset) fail('clinical_drawing_source_not_found', 'La prueba original no está disponible.', 404);
          await validateSourceDocument(values.document, asset, ctx, transaction);
        }
      }
      if (payload.status !== undefined) {
        if (!['active', 'archived'].includes(payload.status)) fail('clinical_drawing_status_invalid', 'El estado no es válido.');
        values.status = payload.status;
      }
      if (payload.template_key !== undefined || payload.template_version !== undefined && payload.template_version !== Number(row.template_version || 1)
        || payload.source_asset_id !== undefined) fail('clinical_drawing_source_immutable', 'La prueba original y el tipo de modelo se conservan. Crea otro para cambiarlos.');
      if (row.status === 'archived' && values.status !== 'active') fail('clinical_drawing_archived', 'Restaura el modelo antes de modificarlo.', 409);
      await row.update(values, { transaction });
      await revision(row, ctx.actorId, payload.status === 'archived' ? 'archived' : payload.status === 'active' ? 'restored' : 'edited', transaction);
      return { item: await serialize(row, transaction) };
    });
  }
  async function revisions(input) {
    const ctx = await context(input), row = await find(input.id, ctx), where = { drawing_id: row.id }, limit = input.limit === undefined ? 30 : integer(input.limit);
    if (!limit || limit > 100) fail('clinical_drawing_limit_invalid', 'Solicita como máximo 100 versiones.');
    if (input.cursor) {
      const cursor = contract.decodeCursor(input.cursor);
      if (cursor.drawing !== row.public_id || !integer(cursor.version)) fail('clinical_drawing_cursor_invalid', 'La página no es válida.');
      where.version_number = { [Op.lt]: Number(cursor.version) };
    }
    const rows = await db.ClinicalDrawingRevision.findAll({ where, order: [['version_number', 'DESC']], limit: limit + 1 });
    return { items: rows.slice(0, limit).map(rev => ({ version: Number(rev.version_number), actor_id: Number(rev.actor_id), change_type: rev.change_type, created_at: rev.created_at })),
      next_cursor: rows.length > limit ? contract.encodeCursor({ drawing: row.public_id, version: Number(rows[limit - 1].version_number) }) : null };
  }
  return { list, get, create, save, revisions };
}
let singleton;
function current() {
  if (!singleton) singleton = createService({ db: require('../../models'), canAccess: require('../lib/access-policy').canUserAccessFeature });
  return singleton;
}
module.exports = { createService, current };
