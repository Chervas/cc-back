'use strict';
const crypto = require('node:crypto'), { Op, literal } = require('sequelize');
const C = require('../lib/clinical-episode-contract'), T = require('../lib/clinical-template-contract');
function createClinicalEpisodeTemplateService({ db } = {}) {
  const Template = db.ClinicalEpisodeTemplate, Version = db.ClinicalEpisodeTemplateVersion;
  async function scoped(id, clinicId, transaction, lock = false) {
    if (typeof id === 'string' && id.startsWith('builtin:')) throw C.error(409, 'clinical_template_system_immutable', 'Las plantillas de sistema se pueden personalizar como una copia independiente.');
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw C.error(404, 'clinical_template_not_found', 'Plantilla no encontrada.');
    const row = await Template.findOne({ where: { public_id: id, clinic_id: C.integer(clinicId, 'clinic_id') }, transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) });
    if (!row) throw C.error(404, 'clinical_template_not_found', 'Plantilla no encontrada.'); return row;
  }
  const serialize = (version, origin) => ({ ...version.snapshot, sha256: version.sha256, created_at: version.created_at,
    ...(origin ? { catalog_origin: { ...origin, locally_modified: Number(version.version_number) > origin.local_version } } : {}) });
  async function catalogOrigins(templateIds, clinicId, transaction) {
    if (!templateIds.length || !db.ClinicalTemplateCatalogAdoption) return new Map();
    const adoptions = await db.ClinicalTemplateCatalogAdoption.findAll({ where: { clinic_id: clinicId, local_template_id: { [Op.in]: templateIds } }, transaction });
    if (!adoptions.length) return new Map();
    const entries = await db.ClinicalTemplateCatalogEntry.findAll({ where: { id: { [Op.in]: adoptions.map(row => row.entry_id) } }, attributes: ['id', 'public_id'], transaction });
    return new Map(adoptions.map(row => [Number(row.local_template_id), { catalog_id: entries.find(entry => Number(entry.id) === Number(row.entry_id))?.public_id || null,
      source_version: Number(row.source_version), local_version: Number(row.local_version), source_sha256: row.source_sha256 }]));
  }
  async function get({ id, clinicId, version, transaction, includeCatalogOrigin = true }) {
    clinicId = C.integer(clinicId, 'clinic_id');
    if (typeof id === 'string' && id.startsWith('builtin:')) {
      // The four Word presets are catalog sources. Clinics must explicitly
      // adopt a published catalog version before using one with a patient.
      if(!T.AREAS.includes(id.slice(8)))throw C.error(404,'clinical_template_not_found','Plantilla no encontrada.');
      const item = T.builtin(id.slice(8));
      if (!item || version != null && Number(version) !== 1) throw C.error(404, 'clinical_template_not_found', 'Versión no encontrada.');
      return { item };
    }
    const row = await scoped(id, clinicId, transaction), number = version == null ? row.current_version : C.integer(version, 'version');
    const revision = await Version.findOne({ where: { template_id: row.id, version_number: number }, transaction });
    if (!revision) throw C.error(404, 'clinical_template_version_not_found', 'Versión de plantilla no encontrada.');
    const origins = includeCatalogOrigin ? await catalogOrigins([row.id], clinicId, transaction) : new Map();
    return { item: serialize(revision, origins.get(Number(row.id))) };
  }
  async function list({ clinicId, query = {} }) {
    clinicId = C.integer(clinicId, 'clinic_id'); const limit = query.limit == null ? 50 : C.integer(query.limit, 'limit');
    if (limit > 100) throw C.error(400, 'clinical_template_limit', 'Solicita como máximo 100 plantillas.');
    const cursor = C.decodeCursor(query.cursor);
    if (cursor && Number(cursor.clinic) !== clinicId) throw C.error(400, 'clinical_template_cursor', 'La página no corresponde a esta clínica.');
    // Archiving is another immutable version, not a destructive delete or a
    // schema migration. Filter before pagination so archived rows cannot hide
    // usable templates behind an empty page.
    const active = literal("NOT EXISTS (SELECT 1 FROM `ClinicalEpisodeTemplateVersions` AS `archivedRevision` WHERE `archivedRevision`.`template_id` = `ClinicalEpisodeTemplate`.`id` AND `archivedRevision`.`version_number` = `ClinicalEpisodeTemplate`.`current_version` AND JSON_UNQUOTE(JSON_EXTRACT(`archivedRevision`.`snapshot`, '$.archived')) = 'true')");
    const rows = await Template.findAll({ where: { clinic_id: clinicId, [Op.and]: [active], ...(cursor ? { id: { [Op.lt]: C.integer(cursor.id, 'cursor') } } : {}) }, order: [['id', 'DESC']], limit: limit + 1 });
    const page = rows.slice(0, limit), revisions = page.length ? await Version.findAll({ where: { [Op.or]: page.map(row => ({ template_id: row.id, version_number: row.current_version })) } }) : [];
    const origins = await catalogOrigins(page.map(row => row.id), clinicId);
    return { items: [...(!cursor ? T.builtins() : []), ...page.map(row => serialize(revisions.find(item => Number(item.template_id) === Number(row.id)), origins.get(Number(row.id))))],
      next_cursor: rows.length > limit ? C.encodeCursor({ clinic: clinicId, id: Number(page[page.length - 1].id) }) : null };
  }
  async function create({ clinicId, actorId, payload, transaction: suppliedTransaction }) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw C.error(400, 'clinical_template_invalid', 'Revisa la plantilla.');
    clinicId = C.integer(clinicId, 'clinic_id'); actorId = C.integer(actorId, 'actor_id');
    if (payload.expected_version !== 0) throw C.error(428, 'clinical_template_version_required', 'La plantilla nueva debe comenzar en la versión inicial.');
    const values = T.definition(payload), hash = C.hash(values), key = C.hash([clinicId, actorId, C.idempotencyKey(payload.idempotency_key, true)]);
    const work=async transaction => {
      const clinic = await db.Clinica.findByPk(clinicId, { attributes: ['id_clinica'], transaction, lock: transaction.LOCK.UPDATE });
      if (!clinic) throw C.error(404, 'clinic_not_found', 'Clínica no encontrada.');
      const existing = await Template.findOne({ where: { creation_key: key, clinic_id: clinicId }, transaction });
      if (existing) { if (existing.creation_hash !== hash) throw C.error(409, 'clinical_template_request_conflict', 'Esta solicitud ya se utilizó con otro contenido.'); return { ...await get({ id: existing.public_id, clinicId, version: 1, transaction }), created: false }; }
      const row = await Template.create({ public_id: crypto.randomUUID(), clinic_id: clinicId, current_version: 1, creation_key: key, creation_hash: hash, created_by: actorId, updated_by: actorId }, { transaction });
      const snapshot = { id: row.public_id, clinic_id: clinicId, version: 1, ...values, builtin: false };
      const revision = await Version.create({ template_id: row.id, version_number: 1, snapshot, sha256: C.hash(snapshot), actor_id: actorId }, { transaction });
      return { item: serialize(revision), created: true };
    };return suppliedTransaction?work(suppliedTransaction):db.sequelize.transaction(work);
  }
  async function save({ id, clinicId, actorId, payload }) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw C.error(400, 'clinical_template_invalid', 'Revisa la plantilla.');
    const expected = payload.expected_version == null ? null : C.integer(payload.expected_version, 'expected_version');
    if (!expected) throw C.error(428, 'clinical_template_version_required', 'Vuelve a cargar la plantilla antes de guardar.');
    const values = T.definition(payload); actorId = C.integer(actorId, 'actor_id');
    return db.sequelize.transaction(async transaction => {
      const row = await scoped(id, clinicId, transaction, true);
      if (Number(row.current_version) !== expected) throw C.error(409, 'clinical_template_version_conflict', 'La plantilla ha cambiado. Tu texto se conserva; revisa la última versión.');
      const current = await Version.findOne({ where: { template_id: row.id, version_number: row.current_version }, transaction });
      if (current?.snapshot?.archived === true) throw C.error(409, 'clinical_template_archived', 'Esta plantilla está retirada de la biblioteca. Puedes conservar sus episodios y crear una copia nueva.');
      const version = expected + 1, snapshot = { id: row.public_id, clinic_id: Number(row.clinic_id), version, ...values, builtin: false };
      const revision = await Version.create({ template_id: row.id, version_number: version, snapshot, sha256: C.hash(snapshot), actor_id: actorId }, { transaction });
      await row.update({ current_version: version, updated_by: actorId }, { transaction });
      const origins = await catalogOrigins([row.id], Number(row.clinic_id), transaction);
      return { item: serialize(revision, origins.get(Number(row.id))) };
    });
  }
  async function archive({ id, clinicId, actorId, payload }) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(key => !['expected_version', 'acknowledged'].includes(key))) throw C.error(400, 'clinical_template_invalid', 'Revisa la solicitud de retirada.');
    if (payload.acknowledged !== true) throw C.error(428, 'clinical_template_archive_acknowledgement_required', 'Confirma que la plantilla dejará de aparecer en la biblioteca, conservando los episodios de los pacientes.');
    const expected = payload.expected_version == null ? null : C.integer(payload.expected_version, 'expected_version');
    if (!expected) throw C.error(428, 'clinical_template_version_required', 'Vuelve a cargar la plantilla antes de retirarla.');
    actorId = C.integer(actorId, 'actor_id');
    return db.sequelize.transaction(async transaction => {
      const row = await scoped(id, clinicId, transaction, true);
      if (Number(row.current_version) !== expected) throw C.error(409, 'clinical_template_version_conflict', 'La plantilla ha cambiado. Revisa la última versión antes de retirarla.');
      const current = await Version.findOne({ where: { template_id: row.id, version_number: expected }, transaction });
      if (!current) throw C.error(404, 'clinical_template_version_not_found', 'Versión de plantilla no encontrada.');
      if (current.snapshot.archived === true) return { item: serialize(current), archived: true, replayed: true };
      const version = expected + 1, snapshot = { ...current.snapshot, version, archived: true };
      const revision = await Version.create({ template_id: row.id, version_number: version, snapshot, sha256: C.hash(snapshot), actor_id: actorId }, { transaction });
      await row.update({ current_version: version, updated_by: actorId }, { transaction });
      return { item: serialize(revision), archived: true, replayed: false };
    });
  }
  async function versions({ id, clinicId, query = {} }) {
    if (id.startsWith('builtin:')) return { items: [(await get({ id, clinicId })).item], next_cursor: null };
    const row = await scoped(id, clinicId), cursor = C.decodeCursor(query.cursor);
    if (cursor && cursor.id !== id) throw C.error(400, 'clinical_template_cursor', 'La página no corresponde a esta plantilla.');
    const rows = await Version.findAll({ where: { template_id: row.id, ...(cursor ? { version_number: { [Op.lt]: C.integer(cursor.version) } } : {}) }, order: [['version_number', 'DESC']], limit: 26 });
    const origins = await catalogOrigins([row.id], Number(row.clinic_id));
    return { items: rows.slice(0, 25).map(revision => serialize(revision, origins.get(Number(row.id)))), next_cursor: rows.length > 25 ? C.encodeCursor({ id, version: Number(rows[24].version_number) }) : null };
  }
  async function resolveReference(ref, clinicId, transaction, { allowArchivedId } = {}) {
    if (ref === null) return null;
    if (!ref || typeof ref !== 'object' || Array.isArray(ref) || typeof ref.id !== 'string' || Object.keys(ref).some(key => !['id', 'version'].includes(key))) throw C.error(400, 'clinical_template_reference_invalid', 'Selecciona una versión válida de la plantilla.');
    const version = C.integer(ref.version, 'version');
    if (ref.id.startsWith('builtin:')) return (await get({ id: ref.id, clinicId, version, transaction, includeCatalogOrigin: false })).item;
    // Use the locking read itself, not a subsequent consistent read. A create
    // transaction may already have a REPEATABLE READ snapshot from its replay
    // check while another transaction commits an archive before this lock.
    const row = await scoped(ref.id, clinicId, transaction, !!transaction);
    const options = { transaction, ...(transaction ? { lock: transaction.LOCK.SHARE } : {}) };
    const current = await Version.findOne({ where: { template_id: row.id, version_number: row.current_version }, ...options });
    if (!current) throw C.error(404, 'clinical_template_version_not_found', 'Versión de plantilla no encontrada.');
    if (current.snapshot.archived === true && allowArchivedId !== ref.id) throw C.error(409, 'clinical_template_archived', 'Esta plantilla ya no está disponible para nuevas consultas. Los episodios existentes se conservan.');
    const revision = Number(row.current_version) === version ? current : await Version.findOne({ where: { template_id: row.id, version_number: version }, ...options });
    if (!revision) throw C.error(404, 'clinical_template_version_not_found', 'Versión de plantilla no encontrada.');
    const item = serialize(revision);
    if (item.archived === true) throw C.error(409, 'clinical_template_archived', 'Usa la versión guardada en el episodio; esta revisión corresponde a la retirada de la plantilla.');
    return item;
  }
  return { list, get, create, save, archive, versions, resolveReference };
}
let service;
module.exports = { createClinicalEpisodeTemplateService, ...Object.fromEntries(['list', 'get', 'create', 'save', 'archive', 'versions', 'resolveReference'].map(method => [method, (...args) => {
  service ||= createClinicalEpisodeTemplateService({ db: require('../../models') }); return service[method](...args);
}])) };
