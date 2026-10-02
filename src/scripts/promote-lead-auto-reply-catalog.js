'use strict';

const SNAPSHOT_KEY = 'lead_auto_reply_catalog_regulated_v1';

function buildDefinition(source, lead) {
  if (source.clinic_id != null || source.group_id != null
    || source.template_key !== lead.BASE_TEMPLATE_KEY) {
    throw Error('lead_catalog_source_scope_mismatch');
  }
  const catalogTemplateId = source.trigger_config?.whatsapp_catalog_template_id
    || source.nodes?.find((node) => node.type === 'action/send_whatsapp')?.config?.catalog_template_id;
  if (!catalogTemplateId) throw Error('lead_catalog_message_reference_missing');
  const config = lead.normalizeConfig({
    managed_feature: lead.FEATURE_KEY,
    configured: false,
    sources: ['write'],
    timing: 'immediate',
    schedule_scope: 'clinic_hours',
    whatsapp_catalog_template_id: catalogTemplateId,
  });
  return { entry_node_id: 'N1', trigger_type: 'lead_nuevo',
    trigger_config: config, nodes: lead.buildManagedNodes(config), is_active: false };
}

async function promote({ apply = false, actorUserId = 1 } = {}) {
  const db = require('../../models');
  const lead = require('../services/leadAutoReply.service');
  const defaults = require('../services/automationDefaults.service');
  const catalog = await db.AutomationFlowCatalog.findOne({ where: { name: lead.CATALOG_NAME } });
  if (!catalog) throw Error('lead_catalog_missing');
  const source = await db.AutomationFlowTemplateV2.findOne({
    where: { template_key: lead.BASE_TEMPLATE_KEY, clinic_id: null, group_id: null,
      published_at: { [db.Sequelize.Op.ne]: null } },
    order: [['version', 'DESC'], ['id', 'DESC']],
  });
  if (!source) throw Error('lead_catalog_source_missing');
  const definition = buildDefinition(source.toJSON(), lead);
  const validation = await require('../controllers/automationsV2.controller')
    .validateFlowPayloadForInternalUse(definition);
  if (!validation.ok) throw Error('lead_catalog_graph_invalid:' + JSON.stringify(validation.errors));
  if (!apply) return { apply: false, sourceVersion: source.version, nodes: definition.nodes.length,
    sourceActive: false, backfillScheduled: false };

  const [snapshots] = await db.sequelize.query(
    'SELECT payload FROM AutomationIntentMigrationSnapshots WHERE snapshot_key=:key LIMIT 1',
    { replacements: { key: SNAPSHOT_KEY } },
  );
  let promoted;
  if (snapshots.length) {
    const snapshot = typeof snapshots[0].payload === 'string'
      ? JSON.parse(snapshots[0].payload) : snapshots[0].payload;
    promoted = await db.AutomationFlowTemplateV2.findByPk(snapshot.promoted_template_id);
    if (!promoted || promoted.is_active || promoted.clinic_id || promoted.group_id
      || Number(source.id) !== Number(promoted.id)
      || !defaults.catalogTemplateMatchesDesired(promoted.toJSON(), {
        ...promoted.toJSON(), ...definition,
      }, false)) throw Error('lead_catalog_existing_promotion_changed');
  } else {
    await db.sequelize.transaction(async (transaction) => {
      const locked = await db.AutomationFlowTemplateV2.findByPk(source.id,
        { transaction, lock: transaction.LOCK.UPDATE });
      if (!locked || locked.updated_at.getTime() !== source.updated_at.getTime()) {
        throw Error('lead_catalog_source_changed');
      }
      const version = await db.AutomationFlowTemplateV2.max('version', {
        where: { template_key: lead.BASE_TEMPLATE_KEY }, transaction,
      });
      const payload = source.toJSON();
      delete payload.id;
      const now = new Date();
      promoted = await db.AutomationFlowTemplateV2.create({
        ...payload, ...definition, version: Number(version) + 1,
        published_at: now, published_by: actorUserId, created_by: actorUserId,
        created_at: now, updated_at: now,
      }, { transaction });
      await db.AutomationFlowTemplateV2.update({ is_active: false }, {
        where: { public_id: source.public_id, id: { [db.Sequelize.Op.ne]: promoted.id } }, transaction,
      });
      await db.sequelize.query(
        'INSERT INTO AutomationIntentMigrationSnapshots (snapshot_key,payload,created_at,updated_at) VALUES (:key,:payload,:now,:now)',
        { transaction, replacements: { key: SNAPSHOT_KEY, now,
          payload: JSON.stringify({ source: payload, catalog_before: catalog.toJSON(),
            promoted_template_id: promoted.id }) } },
      );
      await catalog.update({ template_version: promoted.version }, { transaction });
    });
  }
  const result = await defaults.propagateCatalogAutomationToClinics({
    catalogId: catalog.id, actorUserId, backfillScheduled: false,
  });
  if (!result.success || result.failed) throw Error('lead_catalog_propagation_incomplete');
  await catalog.update({ template_version: promoted.version, last_propagated_at: new Date(),
    last_propagated_template_key: promoted.public_id,
    last_propagated_template_version: promoted.version });
  return { ...result, sourceVersion: promoted.version, sourceActive: false, backfillScheduled: false };
}

module.exports = { buildDefinition, promote, SNAPSHOT_KEY };

if (require.main === module) {
  const { env } = require('./security-email-login-metadata').observedEnvironment('staging');
  Object.assign(process.env, env, { JOBS_AUTO_START: 'false', RUNTIME_ROLE: 'gateway' });
  promote({ apply: process.argv.includes('--apply') })
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => { console.error(JSON.stringify({ error: error.message })); process.exitCode = 1; })
    .finally(async () => { await require('../../models').sequelize.close(); process.exit(process.exitCode || 0); });
}
