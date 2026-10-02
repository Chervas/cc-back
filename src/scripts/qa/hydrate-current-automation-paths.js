'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const args = process.argv.slice(2);
const argument = (key) => args.includes(key) ? args[args.indexOf(key) + 1] : null;
const root = '/home/ubuntu/wt/back-staging';
const parse = (value) => typeof value === 'string' ? JSON.parse(value) : value;
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function currentAnalysisNode(item, template, waitNodeId) {
  const sameNode = template.nodes.find((node) => node.id === item.node.id);
  if (sameNode?.type === 'condition/ai_analysis') return sameNode;
  const wait = template.nodes.find((node) => node.id === waitNodeId && node.type === 'delay/wait_response');
  const originalWait = item.nodes.find((node) => node.id === waitNodeId && node.type === 'delay/wait_response');
  if (!wait || !originalWait || wait.config?.listens_to_node_id !== originalWait.config?.listens_to_node_id) {
    throw Error('current_wait_reference_not_equivalent:' + item.id);
  }
  const node = template.nodes.find((node) => node.id === wait.outputs?.on_response);
  if (node?.type !== 'condition/ai_analysis') throw Error('current_wait_does_not_resume_analysis:' + item.id);
  return node;
}

async function main() {
  const input = argument('--cases'), output = argument('--report');
  if (!input || !output || fs.existsSync(output)) throw Error('new_private_report_and_cases_required');
  const data = JSON.parse(fs.readFileSync(input));
  if (!data.cases?.length) throw Error('empty_current_path_sample');
  const { env } = require(root + '/src/scripts/security-email-login-metadata').observedEnvironment('staging');
  const c = await require(root + '/node_modules/mysql2/promise').createConnection(
    require(root + '/src/scripts/security-database-metadata').configuration(env));
  try {
    await c.query('START TRANSACTION READ ONLY');
    const ids = [...new Set(data.cases.map((item) => item.execution_id))];
    const [rows] = await c.query(`SELECT e.id execution_id, t.id original_template_id,
      t.version original_version, t.public_id, n.id template_id, n.version, n.is_active,
      n.clinic_id, n.group_id, n.nodes, n.name FROM FlowExecutionsV2 e
      JOIN AutomationFlowTemplatesV2 t ON t.id=e.template_version_id
      JOIN AutomationFlowTemplatesV2 n ON n.public_id=t.public_id AND n.published_at IS NOT NULL
      AND n.version=(SELECT MAX(v.version) FROM AutomationFlowTemplatesV2 v
        WHERE v.public_id=t.public_id AND v.published_at IS NOT NULL)
      WHERE e.id IN (${ids.map(() => '?').join(',')})`, ids);
    const templates = new Map(rows.map((row) => [row.execution_id, { ...row, nodes: parse(row.nodes) }]));
    let replaced = 0, remapped = 0, scopeHolds = 0;
    for (const item of data.cases) {
      const template = templates.get(item.execution_id);
      if (!template) throw Error('current_template_missing:' + item.id);
      if (Number(template.clinic_id) !== Number(item.clinic_id)) {
        item.currentPathError = 'current_template_scope_mismatch';
        item.currentPathEvidence = { templateId: template.template_id, version: template.version,
          isActive: !!template.is_active, scopeRejected: true };
        item.nodes = [];
        scopeHolds++;
        continue;
      }
      let waitNodeId;
      if (!template.nodes.some((node) => node.id === item.node.id && node.type === 'condition/ai_analysis')) {
        const [waits] = await c.query(`SELECT node_id FROM FlowExecutionLogsV2
          WHERE id=? AND flow_execution_id=? AND node_type='delay/wait_response'`,
        [item.responseEvidence?.waitLogId, item.execution_id]);
        waitNodeId = waits[0]?.node_id;
      }
      const node = currentAnalysisNode(item, template, waitNodeId);
      if (node.config?.preset_key === 'confirm_appointment' && Number(node.config.preset_contract_version || 0) < 2) {
        throw Error('current_path_still_uses_legacy_confirmation:' + item.id);
      }
      item.currentPathEvidence = {
        source: 'latest_published_same_public_id_native_wait_response',
        publicId: template.public_id, originalTemplateId: template.original_template_id,
        originalVersion: template.original_version, templateId: template.template_id,
        version: template.version, isActive: !!template.is_active,
        graphHash: hash(template.nodes), originalNodeId: item.node.id, nodeId: node.id,
      };
      replaced += template.original_version !== template.version ? 1 : 0;
      remapped += node.id !== item.node.id ? 1 : 0;
      item.nodes = template.nodes;
      item.node = node;
      item.preset = node.config.preset_key;
      item.automation = template.name;
      item.context.outputs = {};
    }
    data.currentPathReconstruction = {
      at: new Date(), replaced, remapped, scopeHolds,
      limitation: 'Current published graphs with historical replies, not a production replay. Inactive graphs stay inactive.',
    };
    fs.writeFileSync(output, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ cases: data.cases.length, replaced, remapped, scopeHolds,
      presets: data.cases.reduce((counts, item) => { counts[item.preset] = (counts[item.preset] || 0) + 1; return counts; }, {}),
      inactive: data.cases.filter((item) => !item.currentPathEvidence.isActive).length }));
  } finally { await c.rollback(); await c.end(); }
}

module.exports = { currentAnalysisNode };
if (require.main === module) main().catch((error) => { console.error(JSON.stringify({ error: error.message })); process.exitCode = 1; });
