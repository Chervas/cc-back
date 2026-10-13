'use strict';

const fs = require('node:fs');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const { FAMILY_KEY, addSameDayNoActionBranch, isSameDayDirectionsTemplate } = require('../lib/same-day-no-action-branch');
const CATALOG_NAME = 'recordatorio_mismo_dia_a_las_8_sabes_llegar';
const hash = value => createHash('sha256').update(JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)).digest('hex');
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;

async function inspect(db) {
  const { Op } = db.Sequelize;
  const catalog = await db.AutomationFlowCatalog.findOne({ where: { name: CATALOG_NAME }, raw: true });
  assert(catalog && catalog.is_generic, 'same_day_catalog_missing_or_not_generic');
  const source = await db.AutomationFlowTemplateV2.findOne({ where: { public_id: catalog.template_key,
    is_active: true, published_at: { [Op.ne]: null } }, order: [['version', 'DESC']], raw: true });
  assert(source && isSameDayDirectionsTemplate(source), 'same_day_source_invalid');
  const clinics = await db.Clinica.findAll({ attributes: ['id_clinica'], order: [['id_clinica', 'ASC']], raw: true });
  const copies = [];
  for (const clinic of clinics) {
    const key = FAMILY_KEY + '__clinic_' + clinic.id_clinica;
    const latest = await db.AutomationFlowTemplateV2.findOne({ where: { template_key: key },
      order: [['version', 'DESC']], raw: true });
    assert(latest?.published_at && isSameDayDirectionsTemplate(latest), 'same_day_unpublished_or_missing_clinic');
    assert.equal(hash(addSameDayNoActionBranch(latest)), hash(addSameDayNoActionBranch(source)), 'same_day_clinic_graph_diverged');
    assert.equal(hash(latest.trigger_config), hash(source.trigger_config), 'same_day_clinic_trigger_diverged');
    copies.push(latest);
  }
  const nodes = addSameDayNoActionBranch(source);
  const validation = await require('../controllers/automationsV2.controller')
    .validateFlowPayloadForInternalUse({ ...source, nodes });
  assert(validation.ok, 'same_day_graph_invalid');
  return { catalog, source, copies, nodes };
}

async function promote(db, expected, { apply = false, actorUserId = 1 } = {}) {
  const before = await inspect(db);
  if (!apply) return before;
  assert.equal(hash(before), hash(expected), 'same_day_preflight_changed');
  const oldVersions = await db.AutomationFlowTemplateV2.findAll({ raw: true, order: [['id', 'ASC']] });
  const familyIds = new Set([before.source.id, ...before.copies.map(c => c.id)]);
  let promoted = before.source;
  if (hash(before.source.nodes) !== hash(before.nodes)) {
    await db.sequelize.transaction(async transaction => {
      const currentCatalog = await db.AutomationFlowCatalog.findByPk(before.catalog.id,
        { transaction, lock: transaction.LOCK.UPDATE, raw: true });
      const current = await db.AutomationFlowTemplateV2.findByPk(before.source.id,
        { transaction, lock: transaction.LOCK.UPDATE, raw: true });
      assert.equal(hash(current), hash(before.source), 'same_day_source_changed');
      assert.equal(hash(currentCatalog), hash(before.catalog), 'same_day_catalog_changed');
      const { id, ...payload } = before.source;
      const version = await db.AutomationFlowTemplateV2.max('version',
        { where: { public_id: before.source.public_id }, transaction });
      const now = new Date();
      promoted = (await db.AutomationFlowTemplateV2.create({ ...payload, nodes: before.nodes,
        version: Number(version) + 1, published_at: now, published_by: actorUserId,
        created_by: actorUserId, created_at: now, updated_at: now }, { transaction })).toJSON();
      await db.AutomationFlowTemplateV2.update({ is_active: false }, { where: { id: current.id }, transaction });
      await db.AutomationFlowCatalog.update({ template_version: promoted.version }, { where: { id: currentCatalog.id }, transaction });
    });
  }
  const defaults = require('../services/automationDefaults.service');
  const result = await defaults.propagateCatalogAutomationToClinics({
    catalogId: before.catalog.id, actorUserId, backfillScheduled: false,
  });
  assert(result.success && result.failed === 0 && result.created === 0, 'same_day_propagation_incomplete');
  const after = await inspect(db);
  assert.equal(hash(after.source.nodes), hash(before.nodes));
  for (const prior of before.copies) {
    const current = after.copies.find(c => c.clinic_id === prior.clinic_id);
    for (const key of ['public_id', 'template_key', 'is_active', 'trigger_type', 'trigger_config', 'entry_node_id']) {
      assert.equal(hash(current[key]), hash(prior[key]), 'same_day_clinic_contract_changed:' + key);
    }
  }
  for (const old of oldVersions) {
    const current = await db.AutomationFlowTemplateV2.findByPk(old.id, { raw: true });
    assert(current, 'same_day_existing_version_deleted');
    for (const key of Object.keys(old)) {
      if (familyIds.has(old.id) && ['is_active', 'updated_at'].includes(key)) continue;
      assert.equal(hash(current[key]), hash(old[key]), 'same_day_existing_version_changed:' + key);
    }
  }
  await db.AutomationFlowCatalog.update({ last_propagated_at: new Date(),
    last_propagated_template_key: after.source.public_id, last_propagated_template_version: after.source.version },
  { where: { id: before.catalog.id } });
  return { ...result, source_version: after.source.version, backfillScheduled: false,
    old_versions_verified: oldVersions.length, activations_preserved: true };
}

async function main() {
  const args = process.argv.slice(2);
  const manifest = args[args.indexOf('--manifest') + 1];
  const database = args[args.indexOf('--database') + 1];
  assert(['clinicaclick', 'clinicaclick_dev_isolated'].includes(database), 'explicit_database_required');
  assert(args.includes('--manifest') && /^\/home\/ubuntu\/secure-imports\/[\w.-]+\.json$/.test(manifest), 'private_manifest_required');
  process.env.JOBS_AUTO_START = 'false';
  const queuePath = require.resolve('../services/queue.service');
  require.cache[queuePath] = { id: queuePath, filename: queuePath, loaded: true,
    exports: { queues: {}, createWorker: () => { throw Error('Workers forbidden during publication'); } } };
  const log = console.log; console.log = () => {};
  const db = require('../../models'); console.log = log;
  try {
    const [[runtime]] = await db.sequelize.query('SELECT DATABASE() name');
    assert.equal(runtime.name, database, 'database_mismatch');
    for (const model of [db.Message, db.JobRequest]) for (const method of ['create', 'bulkCreate', 'upsert', 'findOrCreate']) {
      model[method] = async () => { throw Error('Communications forbidden during publication'); };
    }
    if (!args.includes('--apply')) {
      const before = await promote(db, null);
      fs.writeFileSync(manifest, JSON.stringify(before), { mode: 0o600, flag: 'wx' });
      log(JSON.stringify({ apply: false, source_version: before.source.version, clinics: before.copies.length,
        needs_branch: hash(before.source.nodes) !== hash(before.nodes), manifest_sha256: hash(before) }));
    } else {
      assert.equal(fs.statSync(manifest).mode & 0o077, 0, 'manifest_not_private');
      log(JSON.stringify(await promote(db, parse(fs.readFileSync(manifest, 'utf8')), { apply: true })));
    }
  } finally { await db.sequelize.close(); }
}

module.exports = { inspect, promote };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
