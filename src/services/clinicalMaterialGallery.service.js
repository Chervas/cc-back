'use strict';
const { Op } = require('sequelize');
const C = require('../lib/clinical-episode-contract');
const { PURPOSE_FEATURE } = require('./clinicalEpisodeMaterials.service');
const G = require('../lib/clinical-gallery-contract'), S = require('./clinicalEpisodeServiceContext.service');
const parse = G.json;
function createClinicalMaterialGalleryService({ db, canAccess = input => require('../lib/access-policy').canUserAccessFeature(input) }) {
  const reference = require('./patientClinicalReference.service').createPatientClinicalReferenceService({ db, canAccess });
  const gallery = require('./clinicalPhotoPairs.service').createService({ db, canAccess });
  async function read(input) {
    const { item: patient } = await reference.read(input), clinicId = patient.clinic_id, patientId = patient.patient_id;
    let selected;
    if (input.episodeIds !== undefined && input.episodeIds !== '') {
      if (typeof input.episodeIds !== 'string' || input.episodeIds.length > 8100) throw C.error(400, 'clinical_gallery_scope_invalid', 'Selecciona los episodios de esta consulta.');
      selected = input.episodeIds.split(',');
      if (!selected.length || selected.length > 100 || new Set(selected).size !== selected.length || selected.some(id => !/^[A-Za-z0-9_-]{1,80}$/.test(id))) throw C.error(400, 'clinical_gallery_scope_invalid', 'Selecciona como máximo 100 episodios sin repetir.');
    }
    const query = input.query || {}, scope = gallery.filterScope(query), ctx = { patientId, clinicId, actorId: Number(input.actorId) };
    const mode = query.scope || (scope.service_ref || scope.treatment_id ? 'service' : selected ? 'episodes' : 'patient');
    if (!['patient', 'service', 'episodes'].includes(mode) || mode === 'service' && !scope.service_ref && !scope.treatment_id && !selected) throw C.error(400, 'clinical_gallery_scope_invalid', 'Selecciona el ámbito de la galería.');
    const reportFields = ['id', 'public_id', 'title', 'status', 'occurred_at', 'material_refs', 'version_number', 'appointment_id', 'service_ref', 'treatment_id'];
    const rows = await db.AppointmentClinicalReport.findAll({ where: { patient_id: patientId, clinic_id: clinicId, ...(selected ? { public_id: { [Op.in]: selected } } : {}) },
      attributes: reportFields.filter(key => !db.AppointmentClinicalReport.rawAttributes || db.AppointmentClinicalReport.rawAttributes[key]), order: [['occurred_at', 'DESC'], ['id', 'DESC']], limit: 101 });
    if (selected && rows.length !== selected.length) throw C.error(404, 'clinical_gallery_episode_not_found', 'Un episodio no pertenece a este paciente y clínica.');
    const scopedRows = [];
    for (const row of rows.slice(0, 100)) if (mode !== 'service' || !scope.service_ref && !scope.treatment_id || await gallery.episodeMatches(row, scope, ctx)) scopedRows.push(row);
    const treatments = new Map();
    if (db.Tratamiento) for (const treatmentId of new Set(scopedRows.map(row => Number(row.treatment_id)).filter(Boolean))) {
      try {
        const resolved = await gallery.resolveScope({ treatment_id: treatmentId }, ctx);
        if (resolved.treatment_id) {
          const treatment = await db.Tratamiento.findByPk(treatmentId, { attributes: ['nombre'] });
          if (treatment) treatments.set(treatmentId, treatment.nombre);
        }
      } catch (error) { if (![404, 409].includes(error.statusCode || error.status)) throw error; }
    }
    const episodes = scopedRows.map(row => ({ id: row.public_id, title: row.title || 'Episodio clínico', status: row.status, occurred_at: row.occurred_at, version: Number(row.version_number),
      service_ref: S.identity(parse(row.service_ref)), service_title: parse(row.service_ref)?.title || null, service_area_key: parse(row.service_ref)?.area_key || null,
      treatment_id: row.treatment_id ? Number(row.treatment_id) : null, treatment_name: treatments.get(Number(row.treatment_id)) || null }));
    const sources = scopedRows.flatMap(row => {
      const refs = parse(row.material_refs);
      return (Array.isArray(refs) ? refs : []).filter(ref => ref?.kind === 'attachment' && typeof ref.id === 'string').map(ref => ({ ref, row }));
    });
    const ids = [...new Set(sources.map(({ ref }) => ref.id))], where = { patient_id: patientId, clinic_id: clinicId, scope_type: 'clinic', status: 'active', purpose: { [Op.in]: Object.keys(PURPOSE_FEATURE) } };
    const libraryMode = mode === 'patient' || mode === 'service' && (scope.service_ref || scope.treatment_id);
    if (mode === 'service' && libraryMode) {
      const identity = scope.service_ref ? { service_ref: S.identity(scope.service_ref) } : { treatment_id: scope.treatment_id };
      where[Op.or] = [{ public_id: { [Op.in]: ids } }, { metadata: { clinical_context: identity } }];
    } else if (!libraryMode) {
      if (!ids.length) return { items: [], episodes, next_cursor: null, truncated: false, truncated_episodes: rows.length > 100 };
      where.public_id = { [Op.in]: ids };
    }
    const classification = query.classification == null || query.classification === 'all' ? null : G.classification(query.classification), limit = query.limit == null ? 100 : C.integer(query.limit, 'limit');
    if (limit > 500) throw C.error(400, 'clinical_gallery_limit', 'Solicita como máximo quinientos archivos.');
    const token = C.hash([patientId, clinicId, mode, scope, selected || null, classification]), cursor = C.decodeCursor(query.cursor);
    if (cursor && cursor.scope !== token) throw C.error(400, 'clinical_gallery_cursor', 'La página no corresponde a esta galería.');
    let after = cursor ? C.integer(cursor.id) : null, scanned = 0, exhausted = false; const items = [], permissions = new Map();
    while (items.length < limit && scanned < 2000) {
      const assets = await db.ClinicalPrivateAsset.findAll({ where: { ...where, ...(after ? { id: { [Op.lt]: after } } : {}) }, order: [['id', 'DESC']], limit: 200 });
      if (!assets.length) { exhausted = true; break; }
      const states = await gallery.states(assets);
      for (const asset of assets) {
        after = Number(asset.id); scanned++;
        const feature = PURPOSE_FEATURE[asset.purpose], library = G.libraryItem(asset, states.get(after));
        if (!permissions.has(feature)) permissions.set(feature, await canAccess({ actorId: ctx.actorId, clinicId, featureKey: feature }));
        if (!permissions.get(feature) || library.library_status !== 'active' || classification && library.classification !== classification) continue;
        const refs = sources.filter(source => source.ref.id === asset.public_id), source = refs[0], row = source?.row;
        const origin = parse(asset.metadata)?.clinical_context || {}, service = parse(row?.service_ref) || origin.service_ref || null, treatmentId = Number(row?.treatment_id || origin.treatment_id) || null;
        items.push({ id: asset.public_id, kind: 'attachment', phase: ['before', 'after'].includes(source?.ref.phase) ? source.ref.phase : 'other',
          episode_id: row?.public_id || null, episode_title: row?.title || null, episode_version: row ? Number(row.version_number) : null, episode_status: row?.status || null, occurred_at: row?.occurred_at || null,
          episode_refs: refs.map(({ row, ref }) => ({ id: row.public_id, version: Number(row.version_number), phase: ref.phase || 'other' })),
          title: asset.original_filename || 'Archivo clínico', mime_type: asset.content_type, purpose: asset.purpose, created_at: asset.created_at, ...library,
          service_ref: S.identity(service), service_title: service?.title || null, treatment_id: treatmentId, treatment_name: treatments.get(treatmentId) || origin.treatment_name || null });
        if (items.length >= limit) break;
      }
      if (assets.length < 200 && items.length < limit) { exhausted = true; break; }
    }
    return { items, episodes, next_cursor: !exhausted && after ? C.encodeCursor({ scope: token, id: after }) : null,
      truncated: !exhausted, truncated_episodes: rows.length > 100 };

  }
  return { read };
}
let singleton;
module.exports = { createClinicalMaterialGalleryService, read: input => { singleton ||= createClinicalMaterialGalleryService({ db: require('../../models') }); return singleton.read(input); } };
