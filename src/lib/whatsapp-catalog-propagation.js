'use strict';

const { createHash } = require('node:crypto');
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
function catalogDigest(catalog) {
  const row = catalog?.toJSON ? catalog.toJSON() : catalog;
  const semantic = Object.fromEntries(
    ['id', 'name', 'family_key', 'locale', 'body_text', 'category', 'components', 'variables', 'is_active', 'is_generic']
      .map(key => [key, row?.[key]])
  );
  semantic.disciplinas = (row?.disciplinas || []).map(d => d.disciplina_code || d).sort();
  return createHash('sha256').update(JSON.stringify(stable(semantic))).digest('hex');
}
const terminal = new Set(['completed', 'failed', 'cancelled']);
const fail = code => { throw Object.assign(Error(code), { code }); };
const namespace = job => job?.payload?.__runtime_namespace;
function assertClaim(row, claim) {
  if (!row || row.status !== 'running' || Number(row.attempts) !== Number(claim.attempts)
    || !namespace(row) || namespace(row) !== namespace(claim)) fail('catalog_propagation_claim_changed');
}

// Native JobRequests coordinator. No provider transport, credentials or separate
// queue live here. The durable plan and its children commit in one transaction.
function createPropagation({ JobRequest, sequelize, loadCatalog, listClinics, resolveConfig,
  applies, enqueue, propagate, acquireLease, settleCatalog, extraTargets = async () => [], provisionSecondary }) {
  async function parent(payload, job) {
    if (!Number.isSafeInteger(Number(job?.id)) || !namespace(job)) fail('catalog_propagation_job_required');
    const catalog = await loadCatalog(payload.templateCatalogId);
    if (!catalog) fail('catalog_not_found');
    const generation = catalogDigest(catalog);
    if (payload.catalogGeneration && payload.catalogGeneration !== generation) {
      return { status: 'completed', result: { state: 'superseded', reason: 'catalog_changed' } };
    }
    const currentTime = new Date(catalog.updated_at || catalog.updatedAt || 0).getTime();
    if (!payload.catalogGeneration && payload.sourceUpdatedAt
      && currentTime > new Date(payload.sourceUpdatedAt).getTime() + 1000) {
      return { status: 'completed', result: { state: 'superseded', reason: 'legacy_source_changed' } };
    }
    let proposed = null;
    if (!job.payload?.catalog_propagation_v1) {
      const targets = new Map();
      const clinics = await listClinics(payload.clinicIds);
      for (const clinic of clinics) {
        if (!applies(catalog, clinic)) continue;
        let wabaId = null, resolutionFailed = false;
        try { wabaId = (await resolveConfig(Number(clinic.id_clinica)))?.wabaId || null; }
        catch (_) { resolutionFailed = true; }
        if (payload.wabaIds && (!wabaId || !payload.wabaIds.map(String).includes(String(wabaId)))) continue;
        const key = wabaId ? 'waba:' + wabaId : 'clinic:' + clinic.id_clinica;
        if (!targets.has(key)) targets.set(key, { key, wabaId: wabaId ? String(wabaId) : null, clinicIds: [], resolutionFailed });
        targets.get(key).clinicIds.push(Number(clinic.id_clinica));
      }
      for (const target of await extraTargets(catalog, payload)) {
        if (!targets.has(target.key)) targets.set(target.key, target);
      }
      proposed = { generation, targets: [...targets.values()] };
    }
    const plan = await sequelize.transaction(async transaction => {
      const row = await JobRequest.findByPk(job.id, { transaction, lock: transaction.LOCK.UPDATE });
      assertClaim(row, job);
      if (row.payload.catalog_propagation_v1) return row.payload.catalog_propagation_v1;
      const targets = [];
      for (const target of proposed.targets) {
        const { job: child } = await enqueue({
          type: 'whatsapp_template_create', priority: 'normal', origin: 'whatsapp_catalog_target', maxAttempts: 3,
          requestedBy: payload.requestedBy || null,
          dedupeScope: `catalog-target:${job.id}:${proposed.generation}:${target.key}`,
          payload: { mode: 'propagate_catalog_target', templateCatalogId: Number(payload.templateCatalogId),
            propagationParentId: Number(job.id), propagationGeneration: proposed.generation, target,
            __runtime_namespace: namespace(job) },
        }, { transaction, activeStatuses: ['pending', 'queued', 'running', 'waiting', 'completed', 'failed', 'cancelled'] });
        targets.push({ ...target, jobId: Number(child.id) });
      }
      const value = { version: 1, generation: proposed.generation, targets };
      const nextPayload = { ...row.payload, catalog_propagation_v1: value };
      await row.update({ payload: nextPayload }, { transaction });
      job.payload = nextPayload;
      return value;
    });
    if (plan.generation !== generation) {
      return { status: 'completed', result: { state: 'superseded', reason: 'catalog_changed' } };
    }
    const states = [];
    const children = plan.targets.length ? await JobRequest.findAll({ where: { id: plan.targets.map(t => t.jobId) },
      attributes: ['id', 'status', 'error_message', 'payload'] }) : [];
    const byId = new Map(children.map(child => [Number(child.id), child]));
    for (const target of plan.targets) {
      const child = byId.get(target.jobId);
      if (!child || namespace(child) !== namespace(job) || child.payload?.propagationParentId !== Number(job.id)
        || child.payload?.propagationGeneration !== plan.generation) fail('catalog_propagation_child_changed');
      states.push({ job_id: child.id, waba_id: target.wabaId, clinic_ids: target.clinicIds,
        status: child.status, error: child.error_message || null });
    }
    const pending = states.filter(row => !terminal.has(row.status)).length;
    const failed = states.filter(row => ['failed', 'cancelled'].includes(row.status)).length;
    const result = { state: pending ? 'distributing' : failed ? 'partial_failure' : 'distributed',
      targets_total: states.length, targets_completed: states.length - pending - failed,
      targets_failed: failed, targets_pending: pending, targets: states };
    if (pending) return { status: 'waiting', backoffMs: 30000, result };
    await settleCatalog({ catalogId: Number(payload.templateCatalogId), generation: plan.generation,
      parentId: Number(job.id), runtimeNamespace: namespace(job), sourceUpdatedAt: payload.sourceUpdatedAt,
      state: failed ? 'failed' : 'completed' });
    return failed ? { status: 'failed', retryable: false, error_message: 'catalog_propagation_partial_failure', result }
      : { status: 'completed', result };
  }

  async function target(payload, job) {
    const parentRow = await JobRequest.findByPk(payload.propagationParentId);
    const plan = parentRow?.payload?.catalog_propagation_v1;
    const target = plan?.targets?.find(t => t.jobId === Number(job?.id));
    if (!target || namespace(parentRow) !== namespace(job) || plan.generation !== payload.propagationGeneration
      || Number(parentRow.payload.templateCatalogId) !== Number(payload.templateCatalogId)
      || JSON.stringify(stable(payload.target)) !== JSON.stringify(stable(Object.fromEntries(
        Object.entries(target).filter(([key]) => key !== 'jobId'))))) fail('catalog_propagation_target_changed');
    if (parentRow.status === 'cancelled') return { status: 'completed', result: { state: 'cancelled', reason: 'parent_cancelled' } };
    const catalog = await loadCatalog(payload.templateCatalogId);
    if (!catalog || catalogDigest(catalog) !== plan.generation) {
      return { status: 'completed', result: { state: 'superseded', reason: 'catalog_changed' } };
    }
    assertClaim(await JobRequest.findByPk(job.id), job);
    if (target.planningError) throw Object.assign(Error('catalog_propagation_scope_unavailable'), { retryable: true });
    if (target.provisioning) {
      const summary = await provisionSecondary({ target, catalogId: Number(payload.templateCatalogId), generation: plan.generation });
      return summary.localPending ? { status: 'failed', retryable: false,
        error_message: 'catalog_propagation_target_unconfirmed', result: summary } : { status: 'completed', result: summary };
    }
    const lease = target.wabaId ? await acquireLease(target.wabaId) : null;
    if (lease && !lease.acquired) return { status: 'waiting', backoffMs: 30000,
      result: { state: 'account_busy', waba_id: target.wabaId } };
    try {
      const eligible = [], moved = [];
      for (const clinicId of target.clinicIds) {
        const current = (await resolveConfig(clinicId))?.wabaId || null;
        if (String(current || '') !== String(target.wabaId || '')) {
          moved.push(clinicId);
        } else eligible.push(clinicId);
      }
      if (!eligible.length) return { status: 'failed', retryable: false, error_message: 'catalog_propagation_routing_changed',
        result: { state: 'routing_changed', clinic_ids: moved, waba_id: target.wabaId } };
      const summary = await propagate({ templateCatalogId: Number(payload.templateCatalogId),
        clinicIds: eligible, ...(target.wabaId ? { wabaIds: [target.wabaId] } : {}),
        expectedCatalogDigest: plan.generation, updateCatalogPropagationState: false });
      if (moved.length || summary.errors?.length || summary.skipped_outside_scope) return {
        status: 'failed', retryable: false, error_message: 'catalog_propagation_target_failed',
        result: { ...summary, routing_changed_clinics: moved } };
      return { status: 'completed', result: summary };
    } finally { if (lease) await lease.release(); }
  }
  return { parent, target };
}

module.exports = { createPropagation, catalogDigest };
