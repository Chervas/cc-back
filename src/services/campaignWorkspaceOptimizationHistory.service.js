'use strict';

const crypto = require('node:crypto');
const { Op, literal } = require('sequelize');
const { digest } = require('./campaignWorkspaceOptimizationCapabilities.service');
const { verifyChange } = require('./campaignWorkspaceOptimizationCommand.service');
const { settingScope } = require('./campaignWorkspaceSettings.service');
const loadWorkspaceInventory = options => require('./campaignWorkspace.service').loadWorkspaceInventory(options);
const currentNamespace = () => require('./jobRequests.service').getCurrentRuntimeNamespace();

const ACTIVE_JOBS = ['pending', 'queued', 'running', 'waiting'];
const PAGE_SIZE = 10;
const STATUSES = { queued: 'Pendiente', leased: 'Comprobando', submitted: 'Resultado pendiente', verified: 'Confirmado por la plataforma',
  observed: 'Estado comprobado', skipped: 'No aplicado', uncertain: 'Necesita revisión', resolved: 'Revisión cerrada manualmente' };
const ACTIONS = { pause_underperforming_ads: 'Pausa de anuncio', adjust_bids: 'Ajuste de puja', negative_keywords: 'Búsqueda excluida', adjust_budget: 'Ajuste de presupuesto' };
const fail = (code, status = 409) => { throw Object.assign(new Error(code), { code, status }); };
const query = transaction => ({ transaction, ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}) });
const revision = row => digest([row.id, row.status, row.plan_key, row.clinic_id, row.job_request_id, row.lease_token, row.updated_at, row.resolution]);
const date = value => value && Number.isFinite(+new Date(value)) ? new Date(value).toISOString() : null;
const sameCampaign = (run, campaign) => !!campaign && campaign.assigned && campaign.clinicId === run.clinic_id
  && campaign.provider === run.provider && campaign.account_id === run.account_id && campaign.campaign_id === run.campaign_id;
const visibleWhere = campaigns => ({ [Op.or]: campaigns.filter(row => row.assigned).map(row => ({
  provider: row.provider, account_id: row.account_id, campaign_id: row.campaign_id, clinic_id: row.clinicId,
})) });

function changeLabel(change, value, currency) {
  if (change.target.action === 'negative_keywords') return value === false ? 'Sin exclusión' : String(value);
  if (change.target.action === 'pause_underperforming_ads') return value === 'PAUSED' ? 'En pausa' : 'Activo';
  const unit = change.target.unit;
  const amount = Number(value) / (unit === 'micros' ? 1e6 : unit === 'minor' ? 100 : unit === 'roas_10000' ? 10000 : 1);
  if (['micros', 'minor'].includes(unit) && currency === 'EUR') {
    return new Intl.NumberFormat('es-ES', { style: 'currency', currency, maximumFractionDigits: 6 }).format(amount);
  }
  return new Intl.NumberFormat('es-ES', { maximumFractionDigits: 6 }).format(amount)
    + (['micros', 'minor'].includes(unit) ? ' (moneda de la cuenta)' : ' ROAS');
}

function publicRun(row, campaign, { canWrite = false, owner = null, job = null, now = new Date() } = {}) {
  const change = verifyChange(row.change);
  if (!Object.hasOwn(STATUSES, row.status) || !sameCampaign(row, campaign)) fail('workspace_optimization_history_invalid');
  const leaseActive = row.lease_token && +new Date(row.lease_until) > +now;
  const canResolve = row.status === 'uncertain' && !!row.submitted_at && !leaseActive && !ACTIVE_JOBS.includes(job?.status)
    && canWrite && owner?.id === row.setting_id;
  return { id: row.id, revision: revision(row), campaignId: campaign.id, campaignName: campaign.name, provider: row.provider,
    action: change.target.action, actionLabel: ACTIONS[change.target.action], before: changeLabel(change, change.before, campaign.currency), after: changeLabel(change, change.after, campaign.currency),
    status: row.status, statusLabel: STATUSES[row.status], createdAt: date(row.created_at), checkedAt: date(row.updated_at),
    nextCheckAt: date(row.next_check_at), canResolve, resolvedAt: date(row.resolution?.resolved_at),
    detail: row.status === 'uncertain' ? 'No se ha confirmado el resultado. Otros ajustes quedan detenidos hasta revisarlo; este cambio no se volverá a enviar.'
      : row.status === 'observed' ? 'Se comprobó el estado actual. Esto no demuestra que el cambio lo realizara ClinicaClick.'
        : row.status === 'resolved' ? 'Una persona confirmó su revisión en la plataforma. No se aplicaron cambios al cerrar la revisión.'
          : row.status === 'skipped' ? 'No se envió el ajuste porque sus condiciones dejaron de cumplirse.' : null };
}

async function loadOptimizationHistory({ models, scope, actorId, input = {}, hasAccess, loadInventory = loadWorkspaceInventory, now = new Date(), namespace = currentNamespace() }) {
  if (!Number.isSafeInteger(actorId) || actorId <= 0 || !await hasAccess({ userId: actorId, clinicIds: scope.clinicIds, access: 'read' })) fail('marketing_scope_forbidden', 403);
  const page = input.page === undefined ? 0 : Number(input.page);
  if (!Number.isSafeInteger(page) || page < 0 || page > 10000 || input.campaignId != null && typeof input.campaignId !== 'string') fail('invalid_optimization_history_query', 400);
  const inventory = await loadInventory({ models, scope });
  const campaigns = inventory.campaigns.filter(row => row.assigned && (!input.campaignId || row.id === input.campaignId));
  if (input.campaignId && !campaigns.length) fail('workspace_campaign_not_in_scope', 404);
  const empty = { success: true, page, pageSize: PAGE_SIZE, total: 0, rows: [] };
  if (!campaigns.length) {
    if (!await hasAccess({ userId: actorId, clinicIds: scope.clinicIds, access: 'read' })) fail('marketing_scope_forbidden', 403);
    return empty;
  }
  let owner = null; let canWrite = false;
  if (!scope.isAll && (scope.groupId || scope.clinicIds.length === 1)) {
    owner = await models.CampaignWorkspaceSetting.findOne({ where: settingScope(scope), raw: true });
    canWrite = await hasAccess({ userId: actorId, clinicIds: scope.clinicIds, access: 'write' });
  }
  const result = await models.CampaignWorkspaceOptimizationRun.findAndCountAll({ where: { ...visibleWhere(campaigns), runtime_namespace: namespace },
    order: [[literal("CASE WHEN status IN ('submitted', 'uncertain') THEN 0 ELSE 1 END"), 'ASC'], ['created_at', 'DESC'], ['id', 'DESC']], limit: PAGE_SIZE, offset: page * PAGE_SIZE, raw: true });
  const ids = result.rows.map(row => row.job_request_id).filter(Boolean);
  const jobs = ids.length ? await models.JobRequest.findAll({ where: { id: { [Op.in]: ids } }, attributes: ['id', 'status'], raw: true }) : [];
  if (!await hasAccess({ userId: actorId, clinicIds: scope.clinicIds, access: 'read' })) fail('marketing_scope_forbidden', 403);
  return { ...empty, total: result.count, rows: result.rows.map(row => publicRun(row, campaigns.find(c => sameCampaign(row, c)),
    { owner, canWrite, now, job: jobs.find(job => job.id === row.job_request_id) })) };
}

async function resolveOptimizationReview({ models, scope, actorId, runId, input, hasAccess, loadInventory = loadWorkspaceInventory, now = () => new Date(), namespace = currentNamespace() }) {
  if (!/^[a-f0-9-]{36}$/.test(runId || '') || !input || Object.keys(input).sort().join(',') !== 'confirmed,expected_revision'
    || input.confirmed !== true || !/^[a-f0-9]{64}$/.test(input.expected_revision || '')) fail('invalid_optimization_resolution', 400);
  if (!Number.isSafeInteger(actorId) || actorId <= 0) fail('unauthenticated', 401);
  const owner = settingScope(scope);
  return models.sequelize.transaction(async transaction => {
    const membershipModel = { findAll: options => models.UsuarioClinica.findAll({ ...options, ...query(transaction) }) };
    const permitted = () => hasAccess({ userId: actorId, clinicIds: scope.clinicIds, access: 'write', membershipModel });
    if (!await permitted()) fail('marketing_scope_forbidden', 403);
    const scopeOwner = await (scope.groupId ? models.GrupoClinica : models.Clinica).findByPk(owner.scope_id, query(transaction));
    if (!scopeOwner) fail('scope_not_found', 404);
    const members = scope.groupId ? await models.Clinica.findAll({ where: { grupoClinicaId: scope.groupId },
      attributes: ['id_clinica', 'estado_clinica'], ...query(transaction) }) : [scopeOwner];
    if (members.some(row => ![true, 1, '1'].includes(row.estado_clinica))
      || JSON.stringify(members.map(row => Number(row.id_clinica)).sort((a, b) => a - b))
        !== JSON.stringify([...scope.clinicIds].sort((a, b) => a - b))) fail('workspace_scope_changed');
    const setting = await models.CampaignWorkspaceSetting.findOne({ where: owner, ...query(transaction) });
    const run = await models.CampaignWorkspaceOptimizationRun.findByPk(runId, query(transaction));
    if (!setting || run?.setting_id !== setting.id || run.runtime_namespace !== namespace) fail('workspace_optimization_run_not_found', 404);
    const inventory = await loadInventory({ models, scope, transaction });
    const campaign = inventory.campaigns.find(campaign => sameCampaign(run, campaign));
    if (!campaign) fail('workspace_campaign_not_in_scope', 404);
    if (run.status === 'resolved' && run.resolution?.expected_revision === input.expected_revision) return { success: true, changed: false };
    if (revision(run) !== input.expected_revision) fail('workspace_optimization_review_changed');
    const job = run.job_request_id ? await models.JobRequest.findByPk(run.job_request_id, query(transaction)) : null;
    if (!publicRun(run, campaign, { owner: setting, canWrite: true, job, now: now() }).canResolve) fail('workspace_optimization_review_busy');
    if (!await permitted()) fail('marketing_scope_forbidden', 403);
    const resolution = { decision: 'reviewed_in_platform', resolved_at: now().toISOString(), resolved_by_user_id: actorId, expected_revision: input.expected_revision };
    await run.update({ status: 'resolved', resolution, next_check_at: null, completed_at: now(), lease_token: null, lease_until: null }, { transaction });
    const version = setting.version + 1;
    await setting.update({ version, updated_by_user_id: actorId }, { transaction });
    await models.CampaignWorkspaceEvent.create({ id: crypto.randomUUID(), setting_id: setting.id, version,
      actor_user_id: actorId, created_at: now(), event_type: 'optimization_resolved',
      changes: { run_id: run.id, decision: resolution.decision, provider_mutation: false } }, { transaction });
    return { success: true, changed: true };
  });
}

async function loadOptimizationIncidentEvidence({ models, campaigns, namespace = currentNamespace() }) {
  const selected = campaigns.filter(row => row.assigned); const evidence = new Map();
  if (!selected.length) return evidence;
  const rows = await models.CampaignWorkspaceOptimizationRun.findAll({ where: { ...visibleWhere(selected), runtime_namespace: namespace,
    status: { [Op.in]: ['submitted', 'uncertain'] } }, attributes: ['id', 'provider', 'account_id', 'campaign_id', 'clinic_id', 'change', 'updated_at'], raw: true });
  for (const row of rows) {
    const campaign = selected.find(campaign => sameCampaign(row, campaign));
    if (!campaign) continue;
    const change = verifyChange(row.change);
    const entries = evidence.get(campaign.id) || [];
    entries.push({ id: row.id, action: change.target.action, actionLabel: ACTIONS[change.target.action], checkedAt: date(row.updated_at) });
    evidence.set(campaign.id, entries);
  }
  return evidence;
}

module.exports = { publicRun, loadOptimizationHistory, resolveOptimizationReview, loadOptimizationIncidentEvidence, revision };
