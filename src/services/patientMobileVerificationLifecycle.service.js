'use strict';

const C = require('../lib/patient-mobile-verification');
const POLICY = 'patient_mobile_verification';
const TIMEOUT = 1440;
const JOB = 'patient_mobile_verification_reconcile';
const bool = value => value === true || value === 1;
const plain = row => row?.toJSON ? row.toJSON() : row;

function createService(deps) {
  const { db } = deps, { Op } = db.Sequelize;
  const enabled = () => deps.enabled ? deps.enabled() : process.env.PATIENT_MOBILE_VERIFICATION_ENABLED === 'true';
  const now = () => new Date(deps.now ? deps.now() : Date.now());
  const rowsFor = (clinicId, transaction) => db.AutomationFlowTemplateV2.findAll({
    where: { clinic_id: clinicId, trigger_type: C.REQUEST }, order: [['id', 'ASC']], transaction,
    ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}),
  });
  const catalog = () => db.AutomationFlowCatalog.findOne({ where: { name: C.FAMILY, is_active: true } });
  const utility = transaction => db.WhatsappTemplateCatalog.findOne({ where: { name: C.TEMPLATE, is_active: true }, transaction });

  async function inspect(clinicId, { clinic, rows, transaction } = {}) {
    clinic ||= await db.Clinica.findByPk(clinicId, { transaction });
    rows ||= await rowsFor(clinicId, transaction);
    const published = rows.filter(r => r.published_at).sort((a, b) => b.version - a.version || b.id - a.id);
    const latest = published[0], policy = clinic?.configuracion?.[POLICY];
    // A configured inactive release predates the standard lifecycle: do not
    // mistake a previous operator stop for a never-configured distribution.
    const legacyStop = policy?.enabled == null && latest && !bool(latest.is_active) && C.configValid(latest.trigger_config);
    const featureEnabled = policy?.enabled !== false && !legacyStop;
    const result = (status, reason, extra = {}) => ({ enabled: featureEnabled, ready: false, status, reason, ...extra });
    if (!featureEnabled) return result('manual_disabled', 'manual_disabled', { legacyStop: !!legacyStop });
    if (!enabled()) return result('pending', 'runtime_disabled');
    if (!clinic) return result('pending', 'clinic_missing');
    const families = new Set(rows.map(r => r.public_id || r.template_key));
    if (families.size > 1 || published.filter(r => bool(r.is_active)).length > 1 || rows.some(r => !r.published_at)) {
      return result('review_required', 'local_copy_conflict');
    }
    if (latest && (bool(latest.is_system) || !C.graphValid(latest.nodes))) return result('review_required', 'local_copy_incompatible');
    const trigger = latest?.nodes.find(n => n.type === `trigger/${C.REQUEST}`);
    if (latest && C.configValid(latest.trigger_config) && (latest.trigger_config.response_timeout_minutes !== TIMEOUT
      || trigger?.config?.response_timeout_minutes !== TIMEOUT || trigger?.config?.enabled_after !== latest.trigger_config.enabled_after)) {
      return result('review_required', 'local_configuration_incompatible');
    }
    const tplCatalog = await utility(transaction);
    if (!tplCatalog) return result('pending', 'template_catalog_unavailable');
    if (latest && latest.nodes.filter(n => n.type === 'action/send_whatsapp').some(n =>
      n.config.catalog_template_id != tplCatalog.id || n.config.sender_mode !== 'clinic_default')) {
      return result('review_required', 'local_template_binding_incompatible');
    }
    let sender;
    try { sender = await deps.sender(clinicId); } catch { return result('pending', 'whatsapp_unavailable'); }
    if (!sender?.originId || !sender.phoneNumberId || !sender.wabaId || sender.routingUnavailable
      || sender.authorizedBroker?.sendEnabled !== true) return result('pending', 'whatsapp_unavailable');
    const asset = await db.ClinicMetaAsset.findByPk(sender.originId, { transaction });
    if (!asset || !bool(asset.isActive) || String(asset.phoneNumberId) !== String(sender.phoneNumberId)
      || String(asset.wabaId) !== String(sender.wabaId)) return result('pending', 'whatsapp_unavailable');
    const health = deps.health(asset);
    if (health?.can_send !== true || health.is_stale || !['healthy', 'degraded'].includes(health.state)) return result('pending', 'whatsapp_unavailable');
    const instances = await db.WhatsappTemplate.findAll({ where: { catalog_template_id: tplCatalog.id,
      waba_id: sender.wabaId, is_active: true, [Op.or]: [{ clinic_id: clinicId }, { clinic_id: null }] }, transaction });
    if (!instances.some(t => C.templateValid(t))) return result('pending', 'template_approval_pending');
    if (deps.selectTemplate && latest) {
      for (const node of latest.nodes.filter(n => n.type === 'action/send_whatsapp')) {
        const selected = await deps.selectTemplate(node.config, clinicId, sender.wabaId);
        if (!selected || !instances.some(t => Number(t.id) === Number(selected.id) && C.templateValid(t))) {
          return result('pending', 'template_approval_pending');
        }
      }
    }
    return result(latest && bool(latest.is_active) && C.configValid(latest.trigger_config) ? 'active' : 'available', null,
      { ready: true, template: latest, catalogTemplateId: tplCatalog.id });
  }

  async function reconcile(clinicId) {
    if (!enabled()) return { status: 'pending', reason: 'runtime_disabled' };
    const source = await catalog();
    if (!source) return { status: 'pending', reason: 'catalog_unavailable' };
    // Keep distribution inactive. Launch is a separate validated operation.
    await deps.distribute({ clinicId, catalogFlow: source, backfillScheduled: false });
    return db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, async transaction => {
      const clinic = await db.Clinica.findByPk(clinicId, { transaction, lock: transaction.LOCK.UPDATE });
      if (!clinic) return { status: 'pending', reason: 'clinic_missing' };
      const rows = await rowsFor(clinicId, transaction);
      const state = await inspect(clinicId, { clinic, rows, transaction });
      if (state.legacyStop) await clinic.update({ configuracion: { ...clinic.configuracion,
        [POLICY]: { enabled: false, launched: true, source: 'preserved_legacy_stop' } } }, { transaction });
      const policy = clinic.configuracion?.[POLICY] || {};
      if (state.status === 'active' && policy.launched !== true) await clinic.update({ configuracion: {
        ...clinic.configuracion, [POLICY]: { ...policy, launched: true } } }, { transaction });
      if (!state.ready || state.status === 'active') return publicState(state);
      const previous = state.template;
      if (!previous) return { status: 'review_required', reason: 'local_copy_missing' };
      if (C.configValid(previous.trigger_config) && policy.launched === true) {
        // Explicit re-enable or recovery keeps the original immutable cut/version.
        await previous.update({ is_active: true }, { transaction });
        return { enabled: true, ready: true, status: 'active', reason: null };
      }
      const nodes = structuredClone(previous.nodes), cut = now().toISOString();
      const trigger = nodes.find(n => n.type === `trigger/${C.REQUEST}`);
      trigger.config = { ...trigger.config, response_timeout_minutes: TIMEOUT, enabled_after: cut };
      for (const node of nodes.filter(n => n.type === 'action/send_whatsapp')) node.config.template_id = null;
      const candidate = { ...plain(previous), nodes, trigger_config: { managed_feature: POLICY, configured: true,
        response_timeout_minutes: TIMEOUT, enabled_after: cut } };
      const validation = await deps.validate(candidate);
      if (!validation.ok) return { enabled: true, ready: false, status: 'review_required', reason: 'local_copy_incompatible' };
      const copy = await db.AutomationFlowTemplateV2.create({ public_id: previous.public_id, template_key: previous.template_key,
        version: Math.max(...rows.map(r => r.version)) + 1, engine_version: previous.engine_version,
        name: previous.name, description: previous.description, trigger_type: C.REQUEST,
        trigger_config: candidate.trigger_config, nodes,
        clinic_id: clinicId, group_id: previous.group_id, is_system: false, is_active: false,
        entry_node_id: previous.entry_node_id, created_by: previous.created_by }, { transaction });
      await deps.publish({ row: copy, transaction, isActive: true });
      await clinic.update({ configuracion: { ...clinic.configuracion, [POLICY]: { ...policy, launched: true } } }, { transaction });
      return { enabled: true, ready: true, status: 'active', reason: null };
    });
  }
  async function request(clinicId = null) {
    if (!enabled()) return;
    return deps.enqueue({ type: JOB, payload: { clinic_id: C.id(clinicId) }, priority: 'low',
      origin: POLICY, dedupeScope: clinicId ? `clinic:${clinicId}` : 'global', maxAttempts: 3 });
  }
  async function setEnabled(template, value, actorId) {
    if (!template.clinic_id || bool(template.is_system)) throw Object.assign(Error('mobile_verification_central_inactive'), { statusCode: 409 });
    if (!value) return deps.stop(template, false, { mobilePolicyActor: actorId });
    await db.sequelize.transaction(async transaction => {
      const clinic = await db.Clinica.findByPk(template.clinic_id, { transaction, lock: transaction.LOCK.UPDATE });
      await clinic.update({ configuracion: { ...clinic.configuracion, [POLICY]: {
        ...clinic.configuracion?.[POLICY], enabled: true, updated_by: actorId, updated_at: now().toISOString() } } }, { transaction });
    });
    await reconcile(template.clinic_id);
    return {};
  }
  async function run({ clinic_id: clinicId } = {}) {
    if (!enabled()) return { status: 'completed', result: { skipped: 'runtime_disabled' } };
    const clinics = clinicId ? [{ id_clinica: C.id(clinicId) }]
      : await db.Clinica.findAll({ attributes: ['id_clinica'], order: [['id_clinica', 'ASC']], raw: true });
    const counts = {};
    for (const clinic of clinics) {
      try {
        const state = await reconcile(clinic.id_clinica);
        counts[state.status] = (counts[state.status] || 0) + 1;
      } catch (error) {
        counts.deferred = (counts.deferred || 0) + 1;
        console.warn('[mobile verification] Clinic reconciliation deferred', { clinicId: clinic.id_clinica, code: error.code || error.name });
      }
    }
    return { status: 'completed', result: counts };
  }
  return { inspect, reconcile, request, run, setEnabled };
}

function publicState(state) {
  return { enabled: state.enabled, ready: state.ready, status: state.status, reason: state.reason };
}
let service, lastSweep = 0;
function current() {
  return service ||= createService({ db: require('../../models'),
    sender: clinicId => require('./whatsapp.service').getClinicConfig(clinicId),
    health: asset => require('./whatsappAccountHealth.service').summarizeAssetHealth(asset),
    selectTemplate: (config, clinicId, wabaId) => require('./flowEngineV2.service')._loadConfiguredWhatsappTemplate(
      { ...config, template_id: null }, { clinic_id: clinicId }, { targetWabaId: wabaId,
        expectedLocale: require('../lib/whatsapp-template-locale').normalizeWhatsappLocale(config.language_code || 'es') }),
    distribute: args => require('./automationDefaults.service').ensureCatalogTemplateForClinic(args),
    publish: args => require('./automationDefaults.service').publishClinicTemplateVersion(args),
    validate: args => require('../controllers/automationsV2.controller').validateFlowPayloadForInternalUse(args),
    enqueue: args => require('./jobRequests.service').enqueueUniqueJobRequest(args),
    stop: (...args) => require('../lib/automation-runtime-stop').setActive(...args),
  });
}
async function signal(clinicId = null) {
  if (process.env.PATIENT_MOBILE_VERIFICATION_ENABLED !== 'true') return;
  try { await current().request(clinicId); }
  catch (error) { console.warn('[mobile verification] Reconciliation deferred', { code: error.code || error.name }); }
}
async function tick() {
  if (process.env.PATIENT_MOBILE_VERIFICATION_ENABLED !== 'true' || Date.now() - lastSweep < 300000) return;
  lastSweep = Date.now();
  await signal();
}
module.exports = { POLICY, TIMEOUT, JOB, createService, current, publicState, signal, tick };
