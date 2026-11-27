'use strict';

const assert = require('node:assert/strict');
const D = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { create } = require('../../services/afterHoursLeadSettings.service');

withIsolatedCampaignMysql(async ({ sql, models: db, report }) => {
  db.Sequelize = D;
  db.Clinica = sql.define('Clinica', {
    id_clinica: { type: D.INTEGER, primaryKey: true }, grupoClinicaId: D.INTEGER,
  }, { timestamps: false });
  db.AutomationFlowTemplateV2 = require('../../../models/automationflowtemplatev2')(sql, D);
  db.LeadAssistantPublication = sql.define('Publication', { clinic_id: D.INTEGER, version: D.INTEGER }, { timestamps: false });
  await Promise.all([db.Clinica.sync(), db.AutomationFlowTemplateV2.sync(), db.LeadAssistantPublication.sync()]);
  await db.Clinica.bulkCreate([{ id_clinica: 41 }, { id_clinica: 42 }]);
  const templateKey = 'system_message_received_after_hours';
  const base = {
    public_id: 'flw_after_hours', template_key: templateKey, version: 5, name: 'Fuera de horario',
    trigger_type: 'message_received', trigger_config: { timing: 'clinic_closed', response_buffer_seconds: 90 },
    entry_node_id: 'N1', nodes: [
      { id: 'N1', type: 'trigger/message_received', config: { timing: 'clinic_closed' }, outputs: { on_success: 'N2' } },
      { id: 'N2', type: 'control/end', config: {}, outputs: {} },
    ], is_system: true, is_active: false, created_by: 1, published_at: new Date(),
  };
  const system = await db.AutomationFlowTemplateV2.create(base);
  const service = create(db);
  const before = await service.read(41);
  assert.equal(before.action, 'notice');
  assert.equal(before.active, false);
  assert.equal(before.template_id, system.id);
  await db.LeadAssistantPublication.create({ clinic_id: 42, version: 17 });
  await assert.rejects(service.save(41, 5, { template_id: system.id, action: 'assistant', assistant_version: 17 }), {code: 'assistant_version_unavailable'});
  await db.LeadAssistantPublication.create({ clinic_id: 41, version: 8 });
  const first = await service.save(41, 5, { template_id: system.id, action: 'assistant', assistant_version: 8 });
  const copy = await db.AutomationFlowTemplateV2.findByPk(first.template_id);
  assert.equal(first.active, false);
  assert.equal(copy.clinic_id, 41);
  assert.equal(copy.trigger_config.after_hours_assistant_version, 8);
  assert.equal(copy.nodes.some(n => n.type === 'action/attend_with_lead_assistant'), true);
  assert.deepEqual(copy.nodes.find(n => n.id === 'N2'), base.nodes[1]);
  assert.equal((await service.read(42)).action, 'notice');
  assert.equal((await service.save(41, 5, {template_id: system.id, action: 'assistant', assistant_version: 8})).template_id, copy.id);
  await assert.rejects(service.save(41, 5, {template_id: system.id, action: 'team'}), {code: 'after_hours_conflict'});
  await copy.update({ is_active: true });
  const [x,y] = await Promise.all([service.save(41, 5, { template_id: copy.id, action: 'team' }), service.save(41, 5, { template_id: copy.id, action: 'team' })]);
  assert.equal(x.template_id, y.template_id);
  assert.equal(x.active, true);
  assert.equal(x.assistant_version, null);
  assert.equal(await db.AutomationFlowTemplateV2.count({where:{ clinic_id:41, is_active:true }}), 1);
  assert.equal((await copy.reload()).is_active, false);
  await db.AutomationFlowTemplateV2.create({ ...base, clinic_id:41, template_key:copy.template_key, version:3, is_system:false, published_at:null });
  await assert.rejects(service.save(41, 5, {template_id:x.template_id,action:'notice'}),{code:'after_hours_draft_exists'});
  report.checks.push('clinic isolation, immutable publication, approved Cleo version, existing graph, active-state preservation, racing saves, retry, stale version and editor draft');
}).catch(error => { console.error(error); process.exitCode = 1; });
