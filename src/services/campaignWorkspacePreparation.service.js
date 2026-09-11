'use strict';

const crypto = require('node:crypto');
const { Op } = require('sequelize');
const { loadWorkspaceInventory, loadWebEvidence } = require('./campaignWorkspace.service');
const { settingScope, campaignIncluded, publicSettings } = require('./campaignWorkspaceSettings.service');
const { resolveModeStateForScope } = require('./campaignMode.service');
const { assignmentClinics } = require('./campaignWorkspaceAssignment.service');
const { loadSignalAuthorizationReview } = require('./campaignWorkspaceSignalAuthorization.service');

const MODE_LABELS = {
  connect_only: 'Medición de interesados (leads)',
  guided_improvement: 'Optimiza',
  managed_service: 'Plan gestionado',
  managed_self: 'Gestión propia',
};

function assessCampaignPreparation(campaign, evidence = {}) {
  const base = { campaign, ready: false, action: 'review', reason: 'destination_unverified',
    title: 'Comprobar el destino', detail: 'Todavía no hemos confirmado dónde llegan los interesados de esta campaña.' };
  if (!campaign.assigned) return { ...base, action: 'assign', reason: 'clinic_required', title: 'Confirmar la clínica',
    detail: 'La cuenta es compartida. Confirma qué clínica debe recibir sus interesados.' };
  if (campaign.destinationCheckedAt && (campaign.destinationComplete === false || evidence.reception?.state === 'unverified')) return { ...base,
    detail: 'La última comprobación no cubre todos los destinos de esta campaña. Revisa los destinos y formularios detectados.' };
  if (campaign.destination === 'native') return evidence.reception?.checked && evidence.reception.ready
    ? { ...base, ready: true, action: null, reason: null, title: 'Recepción comprobada', detail: evidence.reception.detail }
    : { ...base, action: 'native', reason: 'native_reception_unverified', title: 'Comprobar el formulario de la plataforma',
      detail: evidence.reception?.detail || 'Conectar la cuenta publicitaria no confirma el acceso a sus formularios ni la llegada de interesados.' };
  if (!['web', 'mixed'].includes(campaign.destination)) return base;
  if (evidence.privacy?.checked !== true || evidence.privacy.ready !== true) return { ...base, action: 'web',
    reason: 'web_preparation_required', title: 'Preparar la web', detail: evidence.privacy?.detail || 'Comprueba la instalación y el consentimiento de los destinos anunciados.' };
  if (campaign.destination === 'mixed' && evidence.nativeReception?.ready !== true) return { ...base, action: 'native',
    reason: 'native_reception_unverified', title: 'Comprobar el formulario de la plataforma',
    detail: evidence.nativeReception?.detail || 'La campaña también utiliza formularios nativos. Falta comprobar su recepción.' };
  if (evidence.reception?.checked !== true || evidence.reception.ready !== true) return { ...base, action: 'web',
    reason: 'web_reception_unverified', title: 'Comprobar la recepción del formulario',
    detail: evidence.reception?.detail || 'Falta recibir un formulario desde cada destino anunciado en Interesados (leads).' };
  return { ...base, ready: true, action: null, reason: null, title: 'Recepción comprobada', detail: evidence.reception.detail };
}

async function loadWorkspacePreparation({ models, scope, now = new Date(), transaction = null,
  loadInventory = loadWorkspaceInventory, loadEvidence = loadWebEvidence, resolveMode = resolveModeStateForScope,
  loadSignalReview = loadSignalAuthorizationReview }) {
  const where = settingScope(scope);
  const setting = await models.CampaignWorkspaceSetting.findOne({ where, raw: true, transaction });
  const intakeRecord = await models.IntakeConfig.findOne({ where: { assignment_scope: where.scope_type,
    [where.scope_type === 'group' ? 'group_id' : 'clinic_id']: where.scope_id }, raw: true, transaction });
  const inventory = await loadInventory({ models, scope, transaction });
  const campaigns = inventory.campaigns.filter(campaign => campaignIncluded(campaign, setting))
    .sort((a, b) => a.id.localeCompare(b.id));
  const evidence = await loadEvidence({ models, campaigns, selectedClinics: inventory.selectedClinics, groups: inventory.groups, scope, now, transaction });
  const legacyScope = { assignment_scope: where.scope_type, clinic_id: where.scope_type === 'clinic' ? where.scope_id : null,
    group_id: scope.groupId || inventory.selectedClinics[0]?.grupoClinicaId || null, clinic_ids: scope.clinicIds };
  const existingMode = await resolveMode(legacyScope, {
    IntakeConfig: models.IntakeConfig, CampaignRequest: models.CampaignRequest, Clinica: models.Clinica, operators: Op, transaction,
  });
  const workspaceMode = setting?.activation?.schema_version === 2 && setting.activation.status === 'active'
    ? { measurement: 'connect_only', optimize: 'guided_improvement' }[setting.activation.mode] : null;
  const currentMode = existingMode?.mode || workspaceMode;
  const checks = campaigns.map(campaign => ({ ...assessCampaignPreparation(campaign, evidence.get(campaign.id)),
    configurationScope: evidence.get(campaign.id)?.configurationScope || null }));
  const assigned = checks.filter(row => row.campaign.assigned);
  const ready = assigned.filter(row => row.ready);
  const signalReview = await loadSignalReview({ models, scope, setting, now, transaction });
  const body = {
    configuration: publicSettings(setting, scope),
    existing: currentMode ? { mode: currentMode, label: MODE_LABELS[currentMode] } : null,
    selectionConfirmed: !!setting?.accounts?.length,
    activationAvailable: process.env.CAMPAIGN_WORKSPACE_ACTIVATION_ENABLED === 'true',
    signals: signalReview.review,
    assignmentClinics: scope.groupId ? assignmentClinics(inventory.selectedClinics) : [],
    campaigns: checks,
    counts: { total: checks.length, assigned: assigned.length, ready: ready.length, unassigned: checks.length - assigned.length },
    receptionReady: assigned.length > 0 && assigned.every(row => row.ready),
  };
  // Bind review screens to the settings and evidence they actually displayed, not browser flags.
  const revision = crypto.createHash('sha256').update(JSON.stringify([body, intakeRecord || null, signalReview.authorization || null])).digest('hex');
  return { success: true, revision, checkedAt: now.toISOString(), ...body };
}

module.exports = { assessCampaignPreparation, loadWorkspacePreparation };
