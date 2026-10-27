'use strict';

// Personal restrictions follow the doctor's CURRENT shared calendar. A block
// remains one definition, anchored in its original clinic, with one exception
// series. Unlinking stops projection; it never copies or globalizes a block.
const { resolveClinicTimezone } = require('./availability-calendar');
const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const enabled = value => value === true || value === 1;
const plain = row => row?.toJSON ? row.toJSON() : row;
const failure = () => Object.assign(Error('El vínculo del calendario ha cambiado. Revisa sus clínicas antes de continuar.'),
  { code: 'personal_block_scope_review_required', status: 409, statusCode: 409 });
const unique = values => [...new Set(values.map(Number).filter(positive))].sort((a, b) => a - b);

function createPersonalBlockScopes(input = []) {
  const rows = input.map(plain), groups = new Map(), byDoctorClinic = new Map(), activeByDoctor = new Map();
  for (const row of rows) {
    if (!positive(row?.doctor_id) || !positive(row?.clinica_id)) continue;
    const key = `${Number(row.doctor_id)}:${Number(row.clinica_id)}`;
    if (byDoctorClinic.has(key)) throw failure();
    byDoctorClinic.set(key, row);
    if (row.activo !== false && row.activo !== 0) activeByDoctor.set(Number(row.doctor_id),
      unique([...(activeByDoctor.get(Number(row.doctor_id)) || []), row.clinica_id]));
    if (row.shared_schedule_source_id == null) continue;
    if (!positive(row.shared_schedule_source_id)) throw failure();
    const group = groups.get(Number(row.shared_schedule_source_id)) || [];
    group.push(row); groups.set(Number(row.shared_schedule_source_id), group);
  }
  for (const [sourceId, members] of groups) {
    const source = members.find(row => Number(row.id) === sourceId);
    if (!source || members.length < 2 || members.length > 31
      || members.some(row => !enabled(row.activo) || Number(row.doctor_id) !== Number(source.doctor_id))) throw failure();
    const clinics = members.map(row => row.clinica || row.Clinica);
    if (clinics.every(Boolean)) {
      const groupId = Number(clinics[0].grupoClinicaId ?? clinics[0].grupo_clinica_id);
      const zone = resolveClinicTimezone(clinics[0]);
      if (!positive(groupId) || clinics.some(clinic => Number(clinic.grupoClinicaId ?? clinic.grupo_clinica_id) !== groupId
        || resolveClinicTimezone(clinic) !== zone)) throw failure();
    }
  }
  const metadata = block => {
    const row = plain(block) || {}, doctor = Number(row.doctor_id);
    const anchor = row.clinica_id == null ? null : Number(row.clinica_id);
    if (anchor == null || enabled(row.aplica_a_todas_clinicas)) return {
      scope: 'global', canonical_clinica_id: anchor, effective_clinic_ids: [...(activeByDoctor.get(doctor) || [])],
    };
    const link = byDoctorClinic.get(`${doctor}:${anchor}`);
    const members = link?.shared_schedule_source_id == null ? null : groups.get(Number(link.shared_schedule_source_id));
    return { scope: members ? 'linked' : 'clinic', canonical_clinica_id: anchor,
      effective_clinic_ids: members ? unique(members.map(member => member.clinica_id)) : unique([anchor]) };
  };
  const applies = (block, clinicId) => {
    const scope = metadata(block);
    return scope.scope === 'global' || scope.effective_clinic_ids.includes(Number(clinicId));
  };
  const filter = (definitions, clinicId) => {
    const seen = new Set();
    return (definitions || []).filter(row => {
      if (!applies(row, clinicId)) return false;
      if (!positive(row.id)) return true;
      const key = Number(row.id); if (seen.has(key)) return false; seen.add(key); return true;
    });
  };
  return { rows, metadata, applies, filter };
}

async function loadPersonalBlockScopes({ db, doctorIds = [], transaction = null, links = null }) {
  const ids = unique(doctorIds);
  if (!ids.length) return createPersonalBlockScopes([]);
  if (ids.length > 100) throw failure();
  // A complete current-clinic link already proves that this clinic is outside
  // any other shared group. Avoid an extra query for independent calendars.
  if (Array.isArray(links) && links.every(row => plain(row)?.shared_schedule_source_id == null))
    return createPersonalBlockScopes(links);
  if (!db.DoctorClinica?.findAll) return createPersonalBlockScopes(links || []);
  const attributes = ['id', 'doctor_id', 'clinica_id', 'activo'];
  if (!db.DoctorClinica.rawAttributes || db.DoctorClinica.rawAttributes.shared_schedule_source_id) attributes.push('shared_schedule_source_id');
  const include = db.Clinica && db.DoctorClinica.associations?.clinica
    ? [{ model: db.Clinica, as: 'clinica', attributes: ['id_clinica', 'grupoClinicaId', 'configuracion'] }] : [];
  const rows = await db.DoctorClinica.findAll({ where: { doctor_id: { [db.Sequelize.Op.in]: ids } },
    attributes, include, order: [['doctor_id', 'ASC'], ['id', 'ASC']], limit: 4001,
    transaction, skipSharedScheduleProjection: true });
  if (rows.length > 4000 || rows.some(row => !ids.includes(Number(row.doctor_id)))) throw failure();
  return createPersonalBlockScopes(rows);
}

async function filterPersonalBlocksForClinic({ db, definitions = [], clinicId, transaction = null, links = null }) {
  if (!definitions.length) return [];
  const scopes = await loadPersonalBlockScopes({ db, doctorIds: definitions.map(row => row.doctor_id), transaction, links });
  return scopes.filter(definitions, clinicId);
}

async function checkPersonalBlockScopePermissions(metadata, checkClinic) {
  if (metadata.scope === 'global') return checkClinic(null);
  if (!metadata.effective_clinic_ids.length) return false;
  return (await Promise.all(metadata.effective_clinic_ids.map(id => checkClinic(id)))).every(Boolean);
}

module.exports = { createPersonalBlockScopes, loadPersonalBlockScopes, filterPersonalBlocksForClinic, checkPersonalBlockScopePermissions };
