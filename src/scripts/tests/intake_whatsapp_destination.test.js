'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { assertReusableWhatsAppTemplate, scopeWhatsAppFlows, TEMPLATE_DESTINATION_ERROR } = require('../../lib/intakeWhatsAppDestination');
const action = phone => ({ type: 'open_whatsapp', enabled: true, config: { phone } });
const flow = phone => ({ steps: [{ type: 'action', actions: [action(phone)] }] });

test('reusable single and multi-flow templates reject a fixed destination even when disabled', () => {
  for (const phone of ['+34 600 111 222', 600111222, '{{clinic.phone}}', 'bad', {}]) {
    for (const template of [{ flow: flow(phone) }, { flows: [{ enabled: false, flow: flow(phone) }] }]) {
      assert.throws(() => assertReusableWhatsAppTemplate(template), e => e.code === TEMPLATE_DESTINATION_ERROR && e.status === 400);
    }
  }
  for (const phone of [undefined, null, '', 'auto']) assert.doesNotThrow(() => assertReusableWhatsAppTemplate({ flow: flow(phone) }));
});

test('public scope disables and removes a foreign number without mutating the persisted copy', () => {
  const input = { flow: flow('600111222'), flows: [{ flow: flow('+34 600 111 222') }] };
  const before = JSON.stringify(input);
  const scoped = scopeWhatsAppFlows({ ...input, availableLocations: [{ id: 2, whatsapp: '34600333444' }] });
  assert.equal(scoped.flow.steps[0].actions[0].enabled, false);
  assert.equal(scoped.flows[0].flow.steps[0].actions[0].config.phone, 'auto');
  assert.equal(JSON.stringify(input), before);
  assert.ok(!JSON.stringify(scoped).includes('111222'));
});

test('public scope accepts only configured WhatsApp numbers and disables automatic actions if none exist', () => {
  const configured = [{ id: 1, whatsapp: '34600111222', phone: '600333444' }];
  assert.equal(scopeWhatsAppFlows({ flow: flow('600 111 222'), availableLocations: configured }).flow.steps[0].actions[0].enabled, true);
  assert.equal(scopeWhatsAppFlows({ flow: flow('600333444'), availableLocations: configured }).flow.steps[0].actions[0].enabled, false);
  for (const whatsapp of [null, '', 'invalid', '123']) {
    const scoped = scopeWhatsAppFlows({ flow: flow('auto'), availableLocations: [{ id:1, whatsapp }] });
    assert.equal(scoped.flow.steps[0].actions[0].enabled, false);
  }
});

test('model hooks guard normal saves and bulk writers without a database connection', async () => {
  let hooks;
  class Model { static init(_attributes, options) { hooks = options.hooks; } }
  const file = path.resolve(__dirname, '../../../models/chatflowtemplate.js');
  const sandbox = { module: { exports: {} }, require: name => name === 'sequelize' ? { Model }
    : require('../../lib/intakeWhatsAppDestination') };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  sandbox.module.exports({}, { INTEGER: {}, STRING: () => ({}), JSON: {}, BOOLEAN: {} });
  const bad = { flow: flow('600111222') };
  for (const key of ['beforeValidate', 'beforeSave']) assert.throws(() => hooks[key](bad), { code: TEMPLATE_DESTINATION_ERROR });
  assert.throws(() => hooks.beforeBulkCreate([bad]), { code: TEMPLATE_DESTINATION_ERROR });
  assert.throws(() => hooks.beforeBulkUpdate({ attributes: bad }), { code: TEMPLATE_DESTINATION_ERROR });
});

test('HTTP create/update/duplicate/propagate reject unsafe templates before business writes', async () => {
  const file = path.resolve(__dirname, '../../controllers/chatFlowTemplates.controller.js');
  for (const method of ['createChatFlowTemplate', 'updateChatFlowTemplate', 'duplicateChatFlowTemplate', 'propagateChatFlowTemplate']) {
    let writes = 0;
    const row = { id:1, name:'Fixture', flow: flow('600111222'), flows:null };
    const models = { ChatFlowTemplate: { findByPk: async () => row, create: async () => { writes++; } },
      Clinica: { findAll: async () => { writes++; return []; } }, IntakeConfig: {},
      sequelize: { transaction: async cb => { writes++; return cb({}); } } };
    const exports = {};
    const sandbox = { exports, process: { env: { ADMIN_USER_IDS:'1' } }, require: name => name === '../../models' ? models
      : name === 'sequelize' ? { Op:{} } : require('../../lib/intakeWhatsAppDestination') };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
    const res = { status(v) { this.statusCode=v; return this; }, json(v) { this.body=v; return this; } };
    await exports[method]({ userData:{ userId:1 }, params:{id:1}, body:{name:'Fixture',flow:row.flow} }, res);
    assert.equal(res.statusCode, 400, method);
    assert.equal(res.body.code, TEMPLATE_DESTINATION_ERROR, method);
    assert.equal(writes, 0, method);
  }
});
