'use strict';
const crypto = require('node:crypto'), { Op } = require('sequelize');
const C = require('../lib/clinical-episode-contract'), K = require('../lib/clinical-template-catalog-contract');
const T = require('../lib/clinical-template-contract'), { parseConfiguration } = require('../lib/clinic-configuration');
function createClinicalTemplateCatalogService({ db, templates = require('./clinicalEpisodeTemplates.service') } = {}) {
  const Entry = db.ClinicalTemplateCatalogEntry, Version = db.ClinicalTemplateCatalogVersion, Adoption = db.ClinicalTemplateCatalogAdoption;
  const notFound = () => C.error(404, 'clinical_catalog_not_found', 'Plantilla del catálogo no encontrada.');
  async function entry(id, transaction, lock = false) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw notFound();
    const row = await Entry.findOne({ where: { public_id: id }, transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) });
    if (!row) throw notFound(); return row;
  }
  async function clinic(id, transaction, lock = false) {
    const row = await db.Clinica.findByPk(C.integer(id, 'clinic_id'), { transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) });
    if (!row) throw C.error(404, 'clinic_not_found', 'Clínica no encontrada.'); return row;
  }
  const applies = (snapshot, row) => {
    const configured = parseConfiguration(row.configuracion).disciplinas;
    return snapshot.all_medical_areas || Array.isArray(configured) && snapshot.medical_area_codes.some(code => configured.includes(code));
  };
  async function validateAreas(values, transaction) {
    const heads = values.medical_area_codes.length ? await db.MedicalAreaContract.findAll({ where: { code: { [Op.in]: values.medical_area_codes }, active: true }, transaction }) : [];
    if (heads.length !== values.medical_area_codes.length) throw C.error(400, 'clinical_catalog_unknown_area', 'Selecciona áreas médicas publicadas en el catálogo de la plataforma.');
    return heads.map(row => ({ code: row.code, revision_id: Number(row.revision_id) || null })).sort((a, b) => a.code.localeCompare(b.code));
  }
  async function receipts(row, clinicId, transaction) {
    if (!clinicId) return [];
    const rows = await Adoption.findAll({ where: { clinic_id: clinicId, entry_id: row.id }, order: [['source_version', 'DESC']], transaction });
    if (!rows.length) return [];
    const locals = await db.ClinicalEpisodeTemplate.findAll({ where: { clinic_id: clinicId, id: { [Op.in]: rows.map(item => item.local_template_id) } }, transaction });
    return rows.map(item => {
      const local = locals.find(value => Number(value.id) === Number(item.local_template_id));
      return { source_version: Number(item.source_version), source_sha256: item.source_sha256,
        local_template_id: local?.public_id || null, local_version: Number(item.local_version),
        current_local_version: local ? Number(local.current_version) : null,
        locally_modified: !!local && Number(local.current_version) > Number(item.local_version), adopted_at: item.created_at };
    });
  }
  async function serialize(row, revision, clinicId, transaction) {
    return { id: row.public_id, catalog_key: row.catalog_key, version: Number(revision.version_number),
      current_version: Number(row.current_version), published_version: row.published_version === null ? null : Number(row.published_version),
      ...revision.snapshot, sha256: revision.sha256, published_at: revision.published_at || null, created_at: revision.created_at,
      adoptions: await receipts(row, clinicId, transaction) };
  }
  async function get({ id, version, clinicId, admin = false, transaction }) {
    const row = await entry(id, transaction), number = version == null ? (admin ? row.current_version : row.published_version) : C.integer(version, 'version');
    if (!number) throw notFound();
    const revision = await Version.findOne({ where: { entry_id: row.id, version_number: number }, transaction });
    if (!revision || !admin && !revision.published_at) throw notFound();
    if (clinicId && !applies(revision.snapshot, await clinic(clinicId, transaction))) throw notFound();
    return { item: await serialize(row, revision, clinicId, transaction) };
  }
  async function list({ clinicId, admin = false, query = {} }) {
    const clinicRow = clinicId ? await clinic(clinicId) : null, limit = query.limit == null ? 50 : C.integer(query.limit, 'limit');
    if (limit > 100) throw C.error(400, 'clinical_catalog_limit', 'Solicita como máximo 100 plantillas.');
    if (query.medical_area_code !== undefined && (typeof query.medical_area_code !== 'string' || !/^[a-z][a-z0-9_]{0,79}$/.test(query.medical_area_code))) throw C.error(400, 'clinical_catalog_areas_invalid', 'El filtro de área médica no es válido.');
    const cursor = C.decodeCursor(query.cursor), scope = `${admin ? 'admin' : 'published'}:${clinicId || 'global'}:${query.medical_area_code || 'all'}`;
    if (cursor && cursor.scope !== scope) throw C.error(400, 'clinical_catalog_cursor', 'La página no corresponde a este catálogo.');
    const rows = await Entry.findAll({ where: { ...(!admin ? { published_version: { [Op.ne]: null } } : {}),
      ...(cursor ? { id: { [Op.lt]: C.integer(cursor.id) } } : {}) }, order: [['id', 'DESC']], limit: limit + 1 });
    const page = rows.slice(0, limit), revisions = page.length ? await Version.findAll({ where: { [Op.or]: page.map(row => ({ entry_id: row.id, version_number: admin ? row.current_version : row.published_version })) } }) : [];
    const items = [];
    for (const row of page) {
      const revision = revisions.find(item => Number(item.entry_id) === Number(row.id));
      if (!revision || !admin && !revision.published_at || clinicRow && !applies(revision.snapshot, clinicRow)) continue;
      if (query.medical_area_code && !revision.snapshot.all_medical_areas && !revision.snapshot.medical_area_codes.includes(query.medical_area_code)) continue;
      items.push(await serialize(row, revision, clinicId));
    }
    return { items, next_cursor: rows.length > limit ? C.encodeCursor({ scope, id: Number(page[page.length - 1].id) }) : null };
  }
  async function create({ actorId, payload }) {
    actorId = C.integer(actorId, 'actor_id'); const catalogKey = K.key(payload?.catalog_key), values = K.definition(payload);
    if (payload.expected_version !== 0) throw C.error(428, 'clinical_catalog_version_required', 'La plantilla nueva debe comenzar en la versión inicial.');
    if (typeof payload.publish !== 'boolean') throw C.error(400, 'clinical_catalog_publication_invalid', 'Indica si quieres guardar un borrador o publicarlo.');
    try {
      return await db.sequelize.transaction(async transaction => {
        const areaReferences = await validateAreas(values, transaction);
        const snapshot = { ...values, medical_area_references: areaReferences }, hash = C.hash(snapshot);
        const existing = await Entry.findOne({ where: { catalog_key: catalogKey }, transaction });
        if (existing) {
          const original = await Version.findOne({ where: { entry_id: existing.id, version_number: 1 }, transaction });
          if (original.sha256 !== hash || !!original.published_at !== payload.publish) throw C.error(409, 'clinical_catalog_key_conflict', 'Este identificador ya corresponde a otra plantilla.');
          return { ...await get({ id: existing.public_id, version: 1, admin: true, transaction }), created: false };
        }
        const row = await Entry.create({ public_id: crypto.randomUUID(), catalog_key: catalogKey, current_version: 1, published_version: payload.publish ? 1 : null, created_by: actorId, updated_by: actorId }, { transaction });
        const revision = await Version.create({ entry_id: row.id, version_number: 1, snapshot, sha256: hash, published_at: payload.publish ? new Date() : null, actor_id: actorId }, { transaction });
        return { item: await serialize(row, revision, null, transaction), created: true };
      });
    } catch (error) { if (error.name === 'SequelizeUniqueConstraintError') throw C.error(409, 'clinical_catalog_key_conflict', 'Este identificador ya existe. Actualiza el catálogo.'); throw error; }
  }
  async function save({ id, actorId, payload }) {
    const values = K.definition(payload), expected = payload.expected_version == null ? null : C.integer(payload.expected_version, 'expected_version');
    if (!expected) throw C.error(428, 'clinical_catalog_version_required', 'Actualiza el catálogo antes de guardar.');
    if (typeof payload.publish !== 'boolean') throw C.error(400, 'clinical_catalog_publication_invalid', 'Indica si quieres guardar un borrador o publicarlo.');
    actorId = C.integer(actorId, 'actor_id');
    return db.sequelize.transaction(async transaction => {
      const row = await entry(id, transaction, true);
      if (Number(row.current_version) !== expected) throw C.error(409, 'clinical_catalog_version_conflict', 'Otra persona ha actualizado esta plantilla. Conserva tu edición y vuelve a revisar la versión.');
      const snapshot = { ...values, medical_area_references: await validateAreas(values, transaction) }, number = expected + 1;
      const revision = await Version.create({ entry_id: row.id, version_number: number, snapshot, sha256: C.hash(snapshot), published_at: payload.publish ? new Date() : null, actor_id: actorId }, { transaction });
      await row.update({ current_version: number, ...(payload.publish ? { published_version: number } : {}), updated_by: actorId }, { transaction });
      return { item: await serialize(row, revision, null, transaction) };
    });
  }
  async function versions({ id, query = {} }) {
    const row = await entry(id), cursor = C.decodeCursor(query.cursor);
    if (cursor && cursor.id !== id) throw C.error(400, 'clinical_catalog_cursor', 'La página no corresponde a esta plantilla.');
    const rows = await Version.findAll({ where: { entry_id: row.id, ...(cursor ? { version_number: { [Op.lt]: C.integer(cursor.version) } } : {}) }, order: [['version_number', 'DESC']], limit: 26 });
    return { items: await Promise.all(rows.slice(0, 25).map(revision => serialize(row, revision))), next_cursor: rows.length > 25 ? C.encodeCursor({ id, version: Number(rows[24].version_number) }) : null };
  }
  async function adopt({ id, clinicId, actorId, payload, transaction: suppliedTransaction }) {
    clinicId = C.integer(clinicId, 'clinic_id'); actorId = C.integer(actorId, 'actor_id');
    if (payload?.acknowledged !== true) throw C.error(428, 'clinical_catalog_acknowledgement_required', 'Confirma que añadirás una copia independiente para esta clínica.');
    const number = C.integer(payload.source_version, 'source_version');
    const work = async transaction => {
      // Clinic lock also serializes adoption with clinic edits and template creation.
      const clinicRow = await clinic(clinicId, transaction, true), row = await entry(id, transaction);
      const revision = await Version.findOne({ where: { entry_id: row.id, version_number: number }, transaction });
      if (!revision?.published_at) throw notFound();
      const existing = await Adoption.findOne({ where: { clinic_id: clinicId, source_version_id: revision.id }, transaction });
      if (existing) return { item: await serialize(row, revision, clinicId, transaction), created: false };
      if (!applies(revision.snapshot, clinicRow)) throw C.error(409, 'clinical_catalog_area_not_enabled', 'Esta plantilla no corresponde a las áreas médicas guardadas en la clínica.');
      const created = await templates.create({ clinicId, actorId, transaction, payload: { ...revision.snapshot.definition, expected_version: 0,
        idempotency_key: `catalog:${row.public_id}:${number}` } });
      const local = await db.ClinicalEpisodeTemplate.findOne({ where: { public_id: created.item.id, clinic_id: clinicId }, transaction });
      if (!local) throw C.error(409, 'clinical_catalog_local_copy_missing', 'No se pudo verificar la copia de esta clínica.');
      await Adoption.create({ clinic_id: clinicId, entry_id: row.id, source_version_id: revision.id, source_version: number,
        source_sha256: revision.sha256, local_template_id: local.id, local_version: created.item.version, actor_id: actorId }, { transaction });
      return { item: await serialize(row, revision, clinicId, transaction), created: true };
    };
    return suppliedTransaction ? work(suppliedTransaction) : db.sequelize.transaction(work);
  }
  async function adoptSelections({ clinicId, actorId, selections, transaction }) {
    const selected = K.selections(selections), items = [];
    if (selected.length && !transaction) throw C.error(400, 'clinical_catalog_transaction_required', 'La adopción del alta debe formar parte de la creación de la clínica.');
    for (const item of [...selected].sort((a, b) => a.id.localeCompare(b.id) || a.version - b.version)) {
      items.push(await adopt({ id: item.id, clinicId, actorId, transaction, payload: { source_version: item.version, acknowledged: true } }));
    }
    return { items };
  }
  async function presets() {
    return { items: T.FORM_PRESET_KEYS.map(key => {
      const raw = T.builtin(key), definition = T.definition(raw);
      return { catalog_key: `bs-medical-${key}`, definition, kind: key === 'initial-general' ? 'initial' : 'standard',
        all_medical_areas: key === 'initial-general', medical_area_codes: key === 'initial-general' ? [] : [key === 'hair' ? 'capilar' : 'estetica'] };
    }) };
  }
  return { list, get, create, save, versions, adopt, adoptSelections, presets };
}
let service;
module.exports = { createClinicalTemplateCatalogService, ...Object.fromEntries(['list', 'get', 'create', 'save', 'versions', 'adopt', 'adoptSelections', 'presets'].map(method => [method, (...args) => {
  service ||= createClinicalTemplateCatalogService({ db: require('../../models') }); return service[method](...args);
}])) };
