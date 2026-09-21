'use strict';

// Operator preparation, not a runtime migration. Old numbered agendas were
// virtual groups, so neither their number nor name proves a physical identity.
const { hash } = require('./adapter');
const VERSION = 'cliniccloud-physical-installations/1';
const ROOMS = Object.freeze([
  ['C1', 'Consulta', 'consulta', [66, 72]],
  ['C2', 'Tratamientos capilares', 'consulta', [66]],
  ['C3', 'Consulta médica y nutrición', 'consulta', [66, 72]],
  ['C6', 'Quirófano capilar', 'quirofano', [66]],
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
function preparePhysicalInstallations({ sources, installations, aliases, groupId, target }) {
  verifySources(sources);
  if (groupId !== 29 || target !== 'crm') throw Error('PHYSICAL_CLIENT_SCOPE_REQUIRED');
  const rows = ROOMS.flatMap(([key, label, type, clinics]) => clinics.map(clinicId => ({
    key, clinic_id: clinicId, name: `${key} · ${label}`, type,
    // Activation follows the appointment remap; do not offer the same capacity
    // once under an old virtual agenda and again under a new physical cabin.
    active: false, capacity: 1,
    canonical_clinic_id: clinics.includes(72) ? 72 : clinics[0],
  })));
  for (const row of rows) {
    if (installations.some(i => i.clinica_id === row.clinic_id && (i.nombre === row.name || new RegExp(`^${row.key}(?:[ ·]|$)`, 'i').test(i.nombre)))) throw Error('PHYSICAL_INSTALLATION_ALREADY_PRESENT_REVIEW_REQUIRED');
  }
  const body = { version: VERSION, target, group_id: groupId, created_at: new Date().toISOString(), sources, rows,
    before: { installations, aliases }, before_sha256: hash({ installations, aliases }),
    existing_appointments_changed: false, existing_installations_changed: false, hours_invented: false,
    activation: 'inactive_until_appointment_assignments_reviewed', external_hospital: 'manual_capacity_not_assumed' };
  return { ...body, package_sha256: hash(body) };
}
function verifyPhysicalPackage(pkg) {
  const { package_sha256, ...body } = pkg;
  if (pkg.version !== VERSION || hash(body) !== package_sha256 || pkg.target !== 'crm' || pkg.group_id !== 29) throw Error('PHYSICAL_PACKAGE_INVALID');
  const expected = preparePhysicalInstallations({ sources: pkg.sources, ...pkg.before, groupId: pkg.group_id, target: pkg.target });
  if (hash(expected.rows) !== hash(pkg.rows) || hash(pkg.before) !== pkg.before_sha256) throw Error('PHYSICAL_PACKAGE_ROWS_CHANGED');
  if (pkg.existing_appointments_changed !== false || pkg.existing_installations_changed !== false || pkg.hours_invented !== false
      || pkg.activation !== expected.activation || pkg.external_hospital !== expected.external_hospital) throw Error('PHYSICAL_PACKAGE_POLICY_CHANGED');
}
module.exports = { VERSION, ROOMS, preparePhysicalInstallations, verifyPhysicalPackage };
