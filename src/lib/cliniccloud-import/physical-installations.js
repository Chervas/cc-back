'use strict';

// Operator preparation, not a runtime migration. Old numbered agendas were
// virtual groups, so neither their number nor name proves a physical identity.
const { hash } = require('./adapter');
const VERSION = 'cliniccloud-physical-installations/2';
const ROOMS = Object.freeze([
  ['C1', 'Consulta', 'consulta', [66, 72]],
  ['C2', 'Tratamientos capilares y curas', 'consulta', [66, 72]],
  ['C3', 'Consulta médica y nutrición', 'consulta', [66, 72]],
  ['C6', 'Quirófano', 'quirofano', [66, 72]],
  ['C7', 'Consulta médica', 'consulta', [66, 72]],
  ['C8', 'INDIBA y EXION', 'box', [72]],
  ['C9', 'Lymphastim y tratamientos corporales', 'box', [72]],
  ['C10', 'Tratamientos corporales y capilares', 'box', [66, 72]],
  ['C11', 'Cyclone y EMShape', 'box', [72]],
  ['C12', 'INDIBA', 'box', [66, 72]],
  ['Hospital', 'Procedimientos externos', 'otro', [72]],
]);
function verifySources(sources) {
  if (!Array.isArray(sources) || sources.length < 2 || sources.some(s => !s.path || !/^[a-f0-9]{64}$/.test(s.sha256))) throw Error('PHYSICAL_SOURCE_EVIDENCE_REQUIRED');
}
function preparePhysicalInstallations({ sources, installations, aliases, groupId, target, now = new Date().toISOString() }) {
  verifySources(sources);
  if (groupId !== 29 || target !== 'crm') throw Error('PHYSICAL_CLIENT_SCOPE_REQUIRED');
  const rows = ROOMS.flatMap(([key, label, type, clinics]) => clinics.map(clinicId => ({
    key, clinic_id: clinicId, name: `${key} · ${label}`, type,
    // Activation follows the appointment remap; do not offer the same capacity
    // once under an old virtual agenda and again under a new physical cabin.
    active: false, capacity: 1,
    canonical_clinic_id: clinics.includes(72) ? 72 : clinics[0],
  })));
  const preserved = [], additions = [], aliasAdditions = [];
  for (const row of rows) {
    const found = installations.filter(i => Number(i.clinica_id) === row.clinic_id && new RegExp(`^${row.key}(?:[ ·]|$)`, 'i').test(i.nombre));
    if (found.length > 1) throw Error('PHYSICAL_INSTALLATION_DUPLICATED');
    if (!found.length) { additions.push(row); continue; }
    const existing = found[0];
    // A label alone does not authorize reusing an unrelated resource. Only the
    // previously journaled, inactive one-place documentary map is accepted.
    if (existing.activo !== 0 || existing.capacidad !== 1 || existing.tipo !== row.type
      || !/^Mapa físico documental BS 2026\. (?:C\d+|Hospital)\. .*Paquete [a-f0-9]{64}\.$/.test(existing.descripcion || '')
      || !existing.descripcion.startsWith(`Mapa físico documental BS 2026. ${row.key}.`)) throw Error('PHYSICAL_INSTALLATION_ALREADY_PRESENT_REVIEW_REQUIRED');
    preserved.push({ key: row.key, clinic_id: row.clinic_id, id: Number(existing.id), before_sha256: hash(existing) });
  }
  for (const key of new Set(rows.map(r => r.key))) {
    const members = preserved.filter(r => r.key === key);
    const ids = members.map(r => r.id);
    const related = aliases.filter(a => ids.includes(Number(a.installation_id)) || ids.includes(Number(a.canonical_installation_id)));
    if (related.some(a => Number(a.group_id) !== groupId || !ids.includes(Number(a.installation_id))
      || !ids.includes(Number(a.canonical_installation_id)) || a.installation_id === a.canonical_installation_id)
      || new Set(related.map(a => a.installation_id)).size !== related.length) throw Error('PHYSICAL_ALIAS_TOPOLOGY_CHANGED');
    const roots = members.filter(m => !related.some(a => Number(a.installation_id) === m.id));
    if (members.length && (roots.length !== 1 || related.some(a => Number(a.canonical_installation_id) !== roots[0].id))) throw Error('PHYSICAL_ALIAS_TOPOLOGY_CHANGED');
    // Preserve an existing canonical ID, including Capilar's C2 and C6.
    const canonicalClinic = roots[0]?.clinic_id ?? rows.find(r => r.key === key).canonical_clinic_id;
    for (const row of rows.filter(r => r.key === key)) row.canonical_clinic_id = canonicalClinic;
    for (const row of additions.filter(r => r.key === key && r.clinic_id !== canonicalClinic)) {
      aliasAdditions.push({ key, clinic_id: row.clinic_id, canonical_clinic_id: canonicalClinic });
    }
  }
  const body = { version: VERSION, target, group_id: groupId, created_at: now, sources, rows, additions, preserved, alias_additions: aliasAdditions,
    before: { installations, aliases }, before_sha256: hash({ installations, aliases }),
    existing_appointments_changed: false, existing_installations_changed: false, hours_invented: false,
    activation: 'inactive_until_appointment_assignments_reviewed', external_hospital: 'manual_capacity_not_assumed' };
  return { ...body, package_sha256: hash(body) };
}
function verifyPhysicalPackage(pkg) {
  const { package_sha256, ...body } = pkg;
  if (pkg.version !== VERSION || hash(body) !== package_sha256 || pkg.target !== 'crm' || pkg.group_id !== 29) throw Error('PHYSICAL_PACKAGE_INVALID');
  const expected = preparePhysicalInstallations({ sources: pkg.sources, ...pkg.before, groupId: pkg.group_id, target: pkg.target, now: pkg.created_at });
  if (hash(expected) !== hash(pkg)) throw Error('PHYSICAL_PACKAGE_ROWS_OR_POLICY_CHANGED');
}
module.exports = { VERSION, ROOMS, preparePhysicalInstallations, verifyPhysicalPackage };
