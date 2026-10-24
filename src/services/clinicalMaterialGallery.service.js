'use strict';
const { Op } = require('sequelize');
const C = require('../lib/clinical-episode-contract');
const { PURPOSE_FEATURE } = require('./clinicalEpisodeMaterials.service');
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
function createClinicalMaterialGalleryService({ db, canAccess = input => require('../lib/access-policy').canUserAccessFeature(input) }) {
  const reference = require('./patientClinicalReference.service').createPatientClinicalReferenceService({ db, canAccess });
  async function read(input) {
    const { item: patient } = await reference.read(input), clinicId = patient.clinic_id, patientId = patient.patient_id;
    let selected;
    if (input.episodeIds !== undefined && input.episodeIds !== '') {
      if (typeof input.episodeIds !== 'string' || input.episodeIds.length > 8100) throw C.error(400, 'clinical_gallery_scope_invalid', 'Selecciona los episodios de esta consulta.');
      selected = input.episodeIds.split(',');
      if (!selected.length || selected.length > 100 || new Set(selected).size !== selected.length || selected.some(id => !/^[A-Za-z0-9_-]{1,80}$/.test(id))) throw C.error(400, 'clinical_gallery_scope_invalid', 'Selecciona como máximo 100 episodios sin repetir.');
    }
    const rows = await db.AppointmentClinicalReport.findAll({ where: { patient_id: patientId, clinic_id: clinicId, ...(selected ? { public_id: { [Op.in]: selected } } : {}) }, attributes: ['public_id', 'title', 'status', 'occurred_at', 'material_refs', 'version_number'], order: [['occurred_at', 'DESC'], ['id', 'DESC']], limit: 101 });
    if (selected && rows.length !== selected.length) throw C.error(404, 'clinical_gallery_episode_not_found', 'Un episodio no pertenece a este paciente y clínica.');
    const episodes = rows.slice(0, 100).map(row => ({ id: row.public_id, title: row.title || 'Episodio clínico', status: row.status, occurred_at: row.occurred_at, version: Number(row.version_number) }));
    const sources = rows.slice(0, 100).flatMap(row => {
      const refs = parse(row.material_refs);
      return (Array.isArray(refs) ? refs : []).filter(ref => ref?.kind === 'attachment' && typeof ref.id === 'string').map(ref => ({ ref, row }));
    });
    const ids = [...new Set(sources.map(({ ref }) => ref.id))];
    if (!ids.length) return { items: [], episodes, truncated: false, truncated_episodes: rows.length > 100 };
    const assets = await db.ClinicalPrivateAsset.findAll({ where: { public_id: { [Op.in]: ids }, patient_id: patientId, clinic_id: clinicId, scope_type: 'clinic', status: 'active', content_type: { [Op.in]: ['image/jpeg', 'image/png', 'image/webp'] }, purpose: { [Op.in]: Object.keys(PURPOSE_FEATURE) } }, attributes: ['public_id', 'original_filename', 'content_type', 'created_at', 'purpose'] });
    const permissions = new Map();
    for (const featureKey of new Set(assets.map(asset => PURPOSE_FEATURE[asset.purpose]))) permissions.set(featureKey, await canAccess({ actorId: Number(input.actorId), clinicId, featureKey }));
    const byId = new Map(assets.filter(asset => permissions.get(PURPOSE_FEATURE[asset.purpose])).map(asset => [asset.public_id, asset]));
    const items = sources.flatMap(({ ref, row }) => {
      const asset = byId.get(ref.id); if (!asset) return [];
      return [{ id: asset.public_id, kind: 'attachment', phase: ['before', 'after'].includes(ref.phase) ? ref.phase : 'other', episode_id: row.public_id,
        episode_title: row.title || 'Episodio clínico', episode_version: Number(row.version_number), episode_status: row.status, occurred_at: row.occurred_at,
        title: asset.original_filename || 'Fotografía clínica', mime_type: asset.content_type, created_at: asset.created_at }];
    });
    return { items: items.slice(0, 500), episodes, truncated: items.length > 500, truncated_episodes: rows.length > 100 };
  }
  return { read };
}
let singleton;
module.exports = { createClinicalMaterialGalleryService, read: input => { singleton ||= createClinicalMaterialGalleryService({ db: require('../../models') }); return singleton.read(input); } };
