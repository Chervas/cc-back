'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Op } = require('sequelize');
const db = require('../../models');
const defaults = require('../services/automationDefaults.service');
const {
  CANONICAL_PILOT_PUBLIC_ID, CANONICAL_CATALOG_NAME, CANONICAL_SNAPSHOT_KEY, buildCanonicalSameDayFlow,
} = require('../lib/same-day-canonical-flow');

function validateReplayForPromotion(file) {
  if (!file) throw new Error('same_day_canonical_validated_replay_required');
  const report = JSON.parse(fs.readFileSync(file));
  const result = require('./qa/check-appointment-intent-replay').check(report);
  if (result.failures.length) throw new Error('same_day_canonical_replay_failed');
  const backend = path.resolve(__dirname, '../..');
  for (const name of ['src/services/flowEngineV2.service.js', 'src/lib/automation-intent-contract.js',
    'src/lib/automation-conversation-context.js', 'src/lib/same-day-canonical-flow.js']) {
    const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(backend, name))).digest('hex');
    if (report.candidate?.[name] !== hash) throw new Error('same_day_canonical_replay_candidate_mismatch');
  }
  return report;
}

async function promote({ apply = false, actorUserId = 1, validatedReplay = null } = {}) {
  const replay = apply ? validateReplayForPromotion(validatedReplay) : null;
  const catalog = await db.AutomationFlowCatalog.findOne({ where: { name: CANONICAL_CATALOG_NAME } });
  if (!catalog) throw new Error('same_day_canonical_catalog_missing');
  const source = await db.AutomationFlowTemplateV2.findOne({
    where: { public_id: catalog.template_key, is_active: true, published_at: { [Op.ne]: null } },
    order: [['version', 'DESC']],
  });
  const pilot = await db.AutomationFlowTemplateV2.findOne({
    where: { public_id: CANONICAL_PILOT_PUBLIC_ID, version: 10, published_at: { [Op.ne]: null } },
  });
  if (!source || !pilot) throw new Error('same_day_canonical_source_missing');
  const canonical = buildCanonicalSameDayFlow(source.toJSON(), pilot.toJSON());
  if (apply && !replay.canonicalGraphHashes?.includes(
    crypto.createHash('sha256').update(JSON.stringify(canonical.nodes)).digest('hex'))) {
    throw new Error('same_day_canonical_replay_graph_mismatch');
  }
  const validation = await require('../controllers/automationsV2.controller').validateFlowPayloadForInternalUse(canonical);
  if (!validation.ok) throw new Error('same_day_canonical_graph_invalid');
  if (!apply) return { apply: false, catalog_id: catalog.id, source_version: source.version, pilot_version: 10, nodes: canonical.nodes.length };
  const catalogBefore = catalog.toJSON();

  const [snapshots] = await db.sequelize.query(
    'SELECT payload FROM AutomationIntentMigrationSnapshots WHERE snapshot_key=:key LIMIT 1',
    { replacements: { key: CANONICAL_SNAPSHOT_KEY } },
  );
  let promoted;
  if (snapshots.length) {
    const snapshot = typeof snapshots[0].payload === 'string' ? JSON.parse(snapshots[0].payload) : snapshots[0].payload;
    promoted = await db.AutomationFlowTemplateV2.findByPk(snapshot.promoted_template_id);
    if (!promoted || promoted.is_active !== true) throw new Error('same_day_canonical_existing_promotion_inactive');
  } else {
    await db.sequelize.transaction(async (transaction) => {
      const current = await db.AutomationFlowTemplateV2.findByPk(source.id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!current.is_active || current.updated_at.getTime() !== source.updated_at.getTime()) {
        throw new Error('same_day_canonical_source_changed');
      }
      const latest = await db.AutomationFlowTemplateV2.max('version', { where: { public_id: source.public_id }, transaction });
      const now = new Date();
      const payload = source.toJSON();
      delete payload.id;
      promoted = await db.AutomationFlowTemplateV2.create({
        ...payload, ...canonical, version: Number(latest) + 1, created_at: now, updated_at: now,
        published_at: now, published_by: actorUserId, created_by: actorUserId,
      }, { transaction });
      await current.update({ is_active: false }, { transaction });
      await catalog.update({ template_version: promoted.version }, { transaction });
      await db.sequelize.query(
        'INSERT INTO AutomationIntentMigrationSnapshots (snapshot_key,payload,created_at,updated_at) VALUES (:key,:payload,:now,:now)',
        { transaction, replacements: { key: CANONICAL_SNAPSHOT_KEY, now,
          payload: JSON.stringify({ source_template_id: source.id, source: source.toJSON(), pilot_template_id: pilot.id,
            promoted_template_id: promoted.id, catalog_before: catalogBefore }) } },
      );
    });
  }
  // Existing executions retain their pinned graph. Do not replay today's reminders.
  const result = await defaults.propagateCatalogAutomationToClinics({
    catalogId: catalog.id, actorUserId, backfillScheduled: false,
  });
  if (!result.success || result.failed) throw new Error('same_day_canonical_propagation_incomplete');
  await catalog.update({ last_propagated_at: new Date(), last_propagated_template_key: catalog.template_key,
    last_propagated_template_version: promoted.version });
  return { ...result, source_version: promoted.version, backfillScheduled: false };
}

module.exports = { promote, validateReplayForPromotion };

if (require.main === module) {
  const replayIndex = process.argv.indexOf('--validated-replay');
  promote({ apply: process.argv.includes('--apply'), validatedReplay: replayIndex >= 0 ? process.argv[replayIndex + 1] : null })
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => { console.error(JSON.stringify({ error: error.message })); process.exitCode = 1; })
    .finally(async () => { await db.sequelize.close(); process.exit(process.exitCode || 0); });
}
