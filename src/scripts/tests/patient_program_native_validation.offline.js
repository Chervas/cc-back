#!/usr/bin/env node
'use strict';

// Captured published definitions and template contracts only: no SQL/provider.
const assert = require('node:assert/strict'), fs = require('node:fs');
require('./fixtures/security_offline_runtime.cjs');
process.env.DB_HOST = '127.0.0.1';
const A = require('../../lib/patient-program-appointment-flow');
const C = require('../../lib/patient-program-booking-confirmation');
const dir = process.env.PROGRAM_NATIVE_VALIDATION_DIR;
assert(dir?.startsWith('/home/ubuntu/secure-imports/'), 'PRIVATE_FIXTURES_REQUIRED');
const sources = JSON.parse(fs.readFileSync(dir + '/source-flows.json'));
const lookup = JSON.parse(fs.readFileSync(dir + '/template-contracts.json'));
const parse = row => Object.fromEntries(Object.entries(row).map(([key, value]) =>
  [key, ['nodes', 'trigger_config', 'components', 'variables'].includes(key) && typeof value === 'string' ? JSON.parse(value) : value]));
const logging = console.log; console.log = () => {};
const db = require('../../../models');
let syntheticApproval = false;
db.WhatsappTemplate.findAll = async () => lookup.templates.map(parse).map(row => syntheticApproval ? { ...row, status: 'APPROVED' } : row);
db.WhatsappTemplateCatalog.findAll = async () => lookup.catalogs.map(parse);
db.AutomationFlowTemplateV2.findByPk = async id => sources.find(row => Number(row.id) === Number(id));
db.sequelize.query = async () => { throw Error('NATIVE_VALIDATION_SQL_FORBIDDEN'); };
const controller = require('../../controllers/automationsV2.controller');
console.log = logging;
(async () => {
  const report = { publishedSources: sources.length, passedWithSimulatedApproval: 0, actualApprovalBlockers: [], transport: 'offline', sourceUnchanged: true };
  try {
    for (const source of sources) {
      const before = C.hash(source), adapted = A.adapt(source);
      syntheticApproval = false;
      const actual = await controller.validateFlowPayloadForInternalUse(adapted);
      assert(actual.errors.every(error => error.code === 'whatsapp_language_template_not_approved'), JSON.stringify(actual.errors));
      report.actualApprovalBlockers.push(...actual.errors.map(error => ({ source: source.id, ...error })));
      syntheticApproval = true;
      const result = await controller.validateFlowPayloadForInternalUse(adapted);
      assert.equal(result.ok, true, JSON.stringify(result.errors));
      assert.deepEqual(result.nodes.filter(node => adapted.trigger_config[A.POLICY].normal_ids.includes(node.id)),
        adapted.nodes.filter(node => adapted.trigger_config[A.POLICY].normal_ids.includes(node.id)));
      assert(A.graphValid({ ...adapted, nodes: result.nodes, trigger_config: result.trigger_config }));
      assert.equal(C.hash(source), before);
      const invalid = structuredClone(adapted);
      invalid.nodes.find(node => node.id === A.programNode(adapted, 1)).config.template_name = 'TESTONLY_WRONG';
      assert.equal((await controller.validateFlowPayloadForInternalUse(invalid)).ok, false);
      report.passedWithSimulatedApproval++;
    }
    fs.writeFileSync(dir + '/native-validation-report.json', JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(report));
  } finally {
    for (const queue of Object.values(require('../../services/queue.service').queues)) await queue.close();
    await db.sequelize.close();
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
