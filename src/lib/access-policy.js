'use strict';

const { Op } = require('sequelize');
const { AccessPolicyOverride, UsuarioClinica, Clinica } = require('../../models');
const { isGlobalAdmin } = require('./role-helpers');

const ALLOWED_FEATURE_KEYS = new Set([
  'marketing',
  'clinic.settings.edit',
  'team.manage',
  'billing.reports.view',
  'patients.view',
  'patients.edit',
  'appointments.manage',
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
  'appointments.manage': {
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
  assertUserCanAccessFeature,
  canUserAccessFeature,
  defaultForFeature,
  normalizeFeatureKey,
  normalizeRoleCode,
  roleCodeFromMembership,
};
