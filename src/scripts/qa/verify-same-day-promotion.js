'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const root = '/home/ubuntu/wt/back-staging';
const family = /^recordatorio_mismo_d_a_sabes_llegar(?:__clinic_\d+)?$/;
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const parse = (value) => typeof value === 'string' ? JSON.parse(value) : value;
const latest = (rows) => {
  const result = new Map();
  for (const row of rows) if (!result.has(row.template_key)
    || result.get(row.template_key).version < row.version) result.set(row.template_key, row);
  return result;
};

async function verify(file) {
  const before = JSON.parse(fs.readFileSync(file));
  const {env} = require(root + '/src/scripts/security-email-login-metadata').observedEnvironment('staging');
  const connection = await require(root + '/node_modules/mysql2/promise').createConnection(
    require(root + '/src/scripts/security-database-metadata').configuration(env));
  try {
    await connection.query('START TRANSACTION READ ONLY');
    const [rows] = await connection.query('SELECT id,public_id,template_key,version,is_active,clinic_id,group_id,nodes,trigger_config FROM AutomationFlowTemplatesV2 WHERE published_at IS NOT NULL');
    const byId = new Map(rows.map((row) => [row.id, row]));
    const failures = [];
    for (const old of before.rows) {
      const current = byId.get(old.id);
      if (!current || hash(parse(current.nodes)) !== old.nodesHash
        || hash(parse(current.trigger_config)) !== old.triggerHash || current.public_id !== old.public_id) {
        failures.push({id:old.id,reason:'historical_version_changed'});
      } else if (!family.test(old.template_key) && Boolean(current.is_active) !== Boolean(old.is_active)) {
        failures.push({id:old.id,reason:'unrelated_activation_changed'});
      }
    }
    const previous = latest(before.rows.filter((row) => family.test(row.template_key)));
    const current = latest(rows.filter((row) => family.test(row.template_key)));
    const source = [...current.values()].find((row) => row.clinic_id == null && row.group_id == null);
    const deliveryIds = require('../../lib/same-day-canonical-flow').DELIVERY_NODE_IDS;
    const decisions = (row) => parse(row.nodes).filter((node) => !deliveryIds.includes(node.id));
    const expectedDecisionHash = source ? hash(decisions(source)) : null;
    if (!source) failures.push({reason:'source_missing'});
    for (const row of current.values()) {
      const old = previous.get(row.template_key);
      if (old && row.clinic_id != null && (row.public_id !== old.public_id
        || Boolean(row.is_active) !== Boolean(old.is_active))) {
        failures.push({id:row.id,reason:'clinic_identity_or_activation_changed'});
      }
      const nodes = parse(row.nodes);
      const classifier = nodes.find((node) => node.id === 'N3');
      const comparator = nodes.find((node) => node.id === 'N10');
      if (classifier?.outputs?.on_success !== 'N10' || comparator?.config?.mode !== 'multi_branch'
        || comparator.config.branch_rules?.length !== 6 || hash(decisions(row)) !== expectedDecisionHash) {
        failures.push({id:row.id,reason:'canonical_decision_graph_mismatch'});
      }
    }
    return {readOnly:true,historicalVersionsChecked:before.rows.length,
      clinicInstances:current.size - (source ? 1 : 0),sourceVersion:source?.version,
      newPublishedVersions:rows.filter((row) => !before.rows.some((old) => old.id === row.id)).length,failures};
  } finally {await connection.rollback();await connection.end();}
}

module.exports = {verify};
if (require.main === module) verify(process.argv[2])
  .then((result) => {console.log(JSON.stringify(result));if (result.failures.length) process.exitCode = 1;})
  .catch((error) => {console.error(JSON.stringify({error:error.message}));process.exitCode = 1;});
