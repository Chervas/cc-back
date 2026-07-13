'use strict';

const { Op } = require('sequelize');
const { AccessPolicyOverride, UsuarioClinica, Clinica } = require('../../models');
const { isGlobalAdmin } = require('./role-helpers');

const ALLOWED_FEATURE_KEYS = new Set([
  'marketing',
  'clinic.settings.edit',
  'team.view',
  'team.manage',
  'billing.reports.view',
  'patients.view',
  'patients.edit',
  'appointments.view',
  'appointments.manage',
  'consents.view',
  'consents.manage',
  'quickchat.read_patients',
  'quickchat.read_team',
  'quickchat.read_leads',
  'nutrition.workspace.view',
  'nutrition.measurements.create',
  'nutrition.reports.finalize',
]);

const ALLOWED_ROLE_CODES = new Set([
  'propietario',
  'agencia',
  'doctor',
  'assistant',
  'reception',
  'admin_staff',
  'unknown',
]);

const DEFAULT_FEATURES = {
  marketing: {
    propietario: true,
    agencia: true,
    doctor: false,
    assistant: true,
    reception: true,
    admin_staff: true,
    unknown: true,
  },
  'clinic.settings.edit': {
    propietario: true,
    agencia: false,
    doctor: false,
    assistant: false,
    reception: false,
    admin_staff: true,
    unknown: false,
  },
  'team.view': {
    propietario: true,
    agencia: true,
    doctor: true,
    assistant: true,
    reception: true,
    admin_staff: true,
    unknown: false,
  },
  'team.manage': {
    propietario: true,
    agencia: false,
    doctor: false,
    assistant: false,
    reception: false,
    admin_staff: true,
    unknown: false,
  },
  'billing.reports.view': {
    propietario: true,
    agencia: false,
    doctor: false,
    assistant: false,
    reception: false,
    admin_staff: true,
    unknown: false,
  },
  'patients.view': {
    propietario: true,
    agencia: true,
    doctor: true,
    assistant: true,
    reception: true,
    admin_staff: true,
    unknown: true,
  },
  'patients.edit': {
    propietario: true,
    agencia: true,
    doctor: true,
    assistant: true,
    reception: true,
    admin_staff: true,
    unknown: false,
  },
  'appointments.view': {
    propietario: true,
    agencia: true,
    doctor: true,
    assistant: true,
    reception: true,
    admin_staff: true,
    unknown: true,
  },
  'appointments.manage': {
    propietario: true,
    agencia: true,
    doctor: true,
    assistant: true,
    reception: true,
    admin_staff: true,
    unknown: false,
  },
  'consents.view': {
    propietario: true,
    agencia: true,
    doctor: true,
    assistant: true,
    reception: true,
    admin_staff: true,
    unknown: false,
  },
  'consents.manage': {
    propietario: true,
    agencia: true,
    doctor: true,
    assistant: true,
    reception: true,
    admin_staff: true,
    unknown: false,
  },
  'quickchat.read_patients': {
    propietario: true,
    agencia: true,
    doctor: true,
    assistant: true,
    reception: true,
    admin_staff: true,
    unknown: false,
  },
  'quickchat.read_team': {
    propietario: true,
    agencia: true,
    doctor: true,
    assistant: true,
    reception: true,
    admin_staff: true,
    unknown: false,
  },
  'quickchat.read_leads': {
    propietario: true,
    agencia: true,
    doctor: false,
    assistant: true,
    reception: true,
    admin_staff: true,
    unknown: false,
  },
  'nutrition.workspace.view': {
    propietario: true,
    agencia: false,
    doctor: true,
    assistant: true,
    reception: false,
    admin_staff: false,
    unknown: false,
  },
  'nutrition.measurements.create': {
    propietario: true,
    agencia: false,
    doctor: true,
    assistant: true,
    reception: false,
    admin_staff: false,
    unknown: false,
  },
  'nutrition.reports.finalize': {
    propietario: true,
    agencia: false,
    doctor: true,
    assistant: false,
    reception: false,
    admin_staff: false,
    unknown: false,
  },
};

const ROLE_CATALOG = [
  {
    code: 'propietario',
    label: 'Propietario',
    description: 'Dirección completa de la clínica.',
  },
  {
    code: 'agencia',
    label: 'Agencia',
    description: 'Gestión externa centrada en captación y seguimiento.',
  },
  {
    code: 'doctor',
    label: 'Doctor',
    description: 'Trabajo clínico con pacientes y agenda.',
  },
  {
    code: 'assistant',
    label: 'Auxiliar',
    description: 'Operativa diaria de consulta y mediciones.',
  },
  {
    code: 'reception',
    label: 'Recepción',
    description: 'Recepción, ventas y coordinación de citas.',
  },
  {
    code: 'admin_staff',
    label: 'Administración',
    description: 'Administración interna de la clínica.',
  },
  {
    code: 'unknown',
    label: 'Sin subrol',
    description: 'Asignaciones sin subrol clínico normalizado.',
  },
];

const FEATURE_CATALOG = [
  {
    key: 'patients.view',
    group: 'clinical_operations',
    kind: 'view',
    label: 'Ver pacientes',
    enforcement_status: 'route',
    sensitive: false,
  },
  {
    key: 'patients.edit',
    group: 'clinical_operations',
    kind: 'action',
    label: 'Editar pacientes',
    enforcement_status: 'backend',
    sensitive: false,
  },
  {
    key: 'appointments.view',
    group: 'clinical_operations',
    kind: 'view',
    label: 'Ver agenda',
    enforcement_status: 'route',
    sensitive: false,
  },
  {
    key: 'appointments.manage',
    group: 'clinical_operations',
    kind: 'action',
    label: 'Gestionar agenda',
    enforcement_status: 'backend',
    sensitive: false,
  },
  {
    key: 'consents.view',
    group: 'clinical_operations',
    kind: 'view',
    label: 'Ver consentimientos',
    enforcement_status: 'route',
    sensitive: true,
  },
  {
    key: 'consents.manage',
    group: 'clinical_operations',
    kind: 'action',
    label: 'Gestionar consentimientos',
    enforcement_status: 'partial',
    sensitive: false,
  },
  {
    key: 'clinic.settings.edit',
    group: 'administration',
    kind: 'action',
    label: 'Editar configuración de clínica',
    enforcement_status: 'route',
    sensitive: true,
  },
  {
    key: 'team.view',
    group: 'administration',
    kind: 'view',
    label: 'Ver personal y horarios',
    enforcement_status: 'route',
    sensitive: false,
  },
  {
    key: 'team.manage',
    group: 'administration',
    kind: 'action',
    label: 'Gestionar personal y horarios',
    enforcement_status: 'partial',
    sensitive: true,
  },
  {
    key: 'billing.reports.view',
    group: 'administration',
    kind: 'view',
    label: 'Ver informes de facturación',
    enforcement_status: 'prepared',
    sensitive: true,
  },
  {
    key: 'nutrition.workspace.view',
    group: 'clinical_areas',
    kind: 'view',
    label: 'Ver ficha de Nutrición',
    enforcement_status: 'backend',
    sensitive: false,
  },
  {
    key: 'nutrition.measurements.create',
    group: 'clinical_areas',
    kind: 'action',
    label: 'Registrar mediciones de Nutrición',
    enforcement_status: 'backend',
    sensitive: false,
  },
  {
    key: 'nutrition.reports.finalize',
    group: 'clinical_areas',
    kind: 'action',
    label: 'Cerrar informes de Nutrición',
    enforcement_status: 'backend',
    sensitive: true,
  },
  {
    key: 'marketing',
    group: 'marketing_conversations',
    kind: 'view',
    label: 'Ver Marketing',
    enforcement_status: 'route',
    sensitive: false,
  },
  {
    key: 'quickchat.read_patients',
    group: 'marketing_conversations',
    kind: 'read',
    label: 'QuickChat pacientes',
    enforcement_status: 'backend',
    sensitive: false,
  },
  {
    key: 'quickchat.read_leads',
    group: 'marketing_conversations',
    kind: 'read',
    label: 'QuickChat leads',
    enforcement_status: 'backend',
    sensitive: false,
  },
  {
    key: 'quickchat.read_team',
    group: 'marketing_conversations',
    kind: 'read',
    label: 'QuickChat equipo',
    enforcement_status: 'backend',
    sensitive: false,
  },
];

function getAccessPolicyCatalog() {
  return {
    version: 1,
    roles: ROLE_CATALOG,
    features: FEATURE_CATALOG,
    defaults: DEFAULT_FEATURES,
  };
}

function normalizeFeatureKey(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeRoleCode(value) {
  return String(value || '').trim().toLowerCase();
}

function roleCodeFromMembership(membership) {
  const role = String(membership?.rol_clinica || '').trim().toLowerCase();
  if (role === 'propietario') return 'propietario';
  if (role === 'agencia') return 'agencia';

  const subrole = String(membership?.subrol_clinica || '').trim().toLowerCase();
  if (subrole === 'doctores' || subrole.includes('doctor')) return 'doctor';
  if (subrole === 'auxiliares y enfermeros' || subrole.includes('auxiliar') || subrole.includes('enfermer')) return 'assistant';
  if (subrole === 'recepción / comercial ventas' || subrole.includes('recep') || subrole.includes('comercial') || subrole.includes('ventas')) return 'reception';
  if (subrole === 'administrativos' || subrole.includes('admin')) return 'admin_staff';

  return 'unknown';
}

function defaultForFeature(featureKey, roleCode) {
  return Boolean(DEFAULT_FEATURES[featureKey]?.[roleCode] ?? true);
}

async function getClinicGroupId(clinicId) {
  const clinic = await Clinica.findByPk(clinicId, {
    attributes: ['id_clinica', 'grupoClinicaId'],
    raw: true,
  });
  const groupId = Number(clinic?.grupoClinicaId);
  return Number.isFinite(groupId) ? groupId : null;
}

async function getFeatureOverride({ featureKey, roleCode, clinicId, groupId }) {
  const clauses = [{ scope_type: 'clinic', scope_id: clinicId }];
  if (Number.isFinite(Number(groupId))) {
    clauses.push({ scope_type: 'group', scope_id: Number(groupId) });
  }

  const rows = await AccessPolicyOverride.findAll({
    where: {
      feature_key: featureKey,
      role_code: roleCode,
      [Op.or]: clauses,
    },
    attributes: ['scope_type', 'scope_id', 'effect'],
    raw: true,
  });

  const clinicOverride = rows.find((row) => row.scope_type === 'clinic' && Number(row.scope_id) === Number(clinicId));
  if (clinicOverride?.effect === 'allow') return true;
  if (clinicOverride?.effect === 'deny') return false;

  const groupOverride = rows.find((row) => row.scope_type === 'group' && Number(row.scope_id) === Number(groupId));
  if (groupOverride?.effect === 'allow') return true;
  if (groupOverride?.effect === 'deny') return false;

  return undefined;
}

async function canUserAccessFeature({ actorId, featureKey, clinicId }) {
  const normalizedFeatureKey = normalizeFeatureKey(featureKey);
  const normalizedClinicId = Number(clinicId);

  if (!Number.isFinite(Number(actorId))) return false;
  if (!ALLOWED_FEATURE_KEYS.has(normalizedFeatureKey)) return false;
  if (isGlobalAdmin(actorId)) return true;
  if (!Number.isFinite(normalizedClinicId)) return false;

  const membership = await UsuarioClinica.findOne({
    where: {
      id_usuario: Number(actorId),
      id_clinica: normalizedClinicId,
    },
    attributes: ['rol_clinica', 'subrol_clinica'],
    raw: true,
  });
  if (!membership) return false;

  const roleCode = roleCodeFromMembership(membership);
  const groupId = await getClinicGroupId(normalizedClinicId);
  const override = await getFeatureOverride({
    featureKey: normalizedFeatureKey,
    roleCode,
    clinicId: normalizedClinicId,
    groupId,
  });

  return override ?? defaultForFeature(normalizedFeatureKey, roleCode);
}

async function assertUserCanAccessFeature({ actorId, featureKey, clinicId }) {
  const allowed = await canUserAccessFeature({ actorId, featureKey, clinicId });
  if (allowed) return true;

  const error = new Error('access_policy_forbidden');
  error.status = 403;
  error.details = {
    feature_key: normalizeFeatureKey(featureKey),
    clinic_id: Number(clinicId),
  };
  throw error;
}

module.exports = {
  ALLOWED_FEATURE_KEYS,
  ALLOWED_ROLE_CODES,
  DEFAULT_FEATURES,
  FEATURE_CATALOG,
  ROLE_CATALOG,
  assertUserCanAccessFeature,
  canUserAccessFeature,
  defaultForFeature,
  getAccessPolicyCatalog,
  normalizeFeatureKey,
  normalizeRoleCode,
  roleCodeFromMembership,
};
