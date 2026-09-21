'use strict';
require('./fixtures/security_offline_runtime.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');
const { selectTemplateInWaba, isApprovedTemplateInWaba } = require('../../lib/whatsapp-template-scope');
const db = require('../../../models');
const service = require('../../services/whatsappTemplateScope.service');
const whatsapp = require('../../services/whatsapp.service');
const components = [{ type: 'BODY', text: 'Hola {{1}}, soy {{2}} de {{3}}.' },
  { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Quiero una cita' }] }];
const local = { id: 10, clinic_id: 35, waba_id: null, catalog_template_id: 108,
  name: 'primera_visita_v32', language: 'es', status: 'APPROVED', is_active: true,
  components, meta_template_id: 'other-remote-id' };
const remote = { ...local, id: 20, clinic_id: null, waba_id: 'sender-waba', name: 'primera_visita_v40', meta_template_id: 'correct-remote-id' };
const scope = { clinicId: 35, wabaId: 'sender-waba' };

test('an override approved in another account resolves to identical content in the actual sender account', () => {
  assert.equal(selectTemplateInWaba(local, [{ ...remote, id: 99, waba_id: 'other-waba' }, remote], scope), remote);
  assert.equal(isApprovedTemplateInWaba(local, scope), false);
});
for (const [label, change] of Object.entries({
  wrong_waba: { waba_id: 'other-waba' }, other_clinic: { clinic_id: 36 },
  different_language: { language: 'ca' }, different_catalog: { catalog_template_id: 109 },
  changed_body: { components: [{ type: 'BODY', text: 'Otro mensaje {{1}}' }] },
  changed_buttons: { components: [components[0]] }, paused: { status: 'PAUSED' },
  pending: { status: 'PENDING' }, retired: { retired_at: '2026-09-01' },
  inactive: { is_active: false }, superseded: { superseded_by_template_id: 30 },
})) {
  test('never substitutes ' + label, () => assert.equal(selectTemplateInWaba(local, [{ ...remote, ...change }], scope), null));
}

test('a pending local edit is not silently approved by an existing remote version', () => {
  assert.equal(selectTemplateInWaba({ ...local, status: 'PENDING_LOCAL' }, [remote], scope), null);
});
test('personal templates and another clinic reference cannot be rebound as a catalog template', () => {
  assert.equal(selectTemplateInWaba({ ...local, catalog_template_id: null }, [remote], scope), null);
  assert.equal(selectTemplateInWaba({ ...local, clinic_id: 36 }, [remote], scope), null);
});
test('a personal local reference can resolve only to its exact remote identity and contract', () => {
  const source = { ...local, catalog_template_id: null, meta_template_id: remote.meta_template_id, name: remote.name };
  assert.equal(selectTemplateInWaba(source, [remote], scope), remote);
  assert.equal(selectTemplateInWaba(source, [{ ...remote, meta_template_id: 'different' }], scope), null);
});
test('the author retains access to an existing personal template in the same shared WABA', async () => {
  const personal = { ...remote, clinic_id: 36, created_by_user_id: 99 };
  assert.equal(await service.resolveTemplateInWaba({ template: personal, ...scope, userId: 99 }), personal);
});
test('an existing valid selection remains stable even if a newer version exists', () => {
  assert.equal(selectTemplateInWaba(remote, [{ ...remote, id: 21 }], scope), remote);
});
test('examples do not change the provider-facing contract', () => {
  const withExamples = { ...remote, components: [{ ...components[0], example: { body_text: [['Ficticio','Recepción','Pruebas']] } }, components[1]] };
  assert.equal(selectTemplateInWaba(local, [withExamples], scope), withExamples);
});
test('empty or malformed component contracts cannot justify a substitution', () => {
  for (const components of [null, [], '{}', 'invalid']) {
    assert.equal(selectTemplateInWaba({ ...local, components }, [{ ...remote, components }], scope), null);
  }
});
test('legacy conversation selection uses an approved WABA row within the transaction', async t => {
  const transaction = {};
  t.mock.method(db.WhatsappTemplate, 'findAll', async options => {
    assert.equal(options.where.waba_id, scope.wabaId);
    assert.equal(options.where.language, 'es');
    assert.equal(options.transaction, transaction);
    assert.deepEqual(options.where[Op.or], [{ clinic_id: null }, { clinic_id: 35 }]);
    return [remote];
  });
  assert.equal(await service.resolveTemplateInWaba({ template: local, ...scope, transaction }), remote);
});
test('final transport guard rejects an unavailable template before any provider request', async t => {
  let transportCalls = 0;
  t.mock.method(db.WhatsappTemplate, 'findOne', async options => {
    assert.equal(options.where.waba_id, scope.wabaId);
    assert.equal(options.where.name, local.name);
    return null;
  });
  t.mock.method(require('../../lib/whatsappAuthorizedBrokerClient'), 'send', async () => { transportCalls++; });
  await assert.rejects(whatsapp.dispatchMessage({ type: 'template', template: { name: local.name, language: { code: 'es' } } },
    { wabaId: scope.wabaId, clinicId: scope.clinicId, authorizedBroker: {} }),
  error => error.code === 'whatsapp_template_waba_mismatch' && error.retryable === false);
  assert.equal(transportCalls, 0);
});
test('guard accepts a real approved template for the sender and rejects retired rows', async t => {
  t.mock.method(db.WhatsappTemplate, 'findOne', async () => remote);
  await service.assertTemplateInWaba({ ...scope, name: remote.name, language: 'es' });
  t.mock.method(db.WhatsappTemplate, 'findOne', async () => ({ ...remote, retired_at: '2026-09-01' }));
  await assert.rejects(service.assertTemplateInWaba({ ...scope, name: remote.name, language: 'es' }), { code: 'whatsapp_template_waba_mismatch' });
});
test('group sync cannot overwrite a clinic with its own sender or another secondary account', async t => {
  const calls = [];
  t.mock.method(whatsapp, 'getClinicConfig', async id => {
    calls.push(id);
    return { wabaId: ({ 35: 'clinic-waba', 36: 'group-waba', 37: 'another-primary' })[id] };
  });
  assert.deepEqual(await service.filterClinicsForWaba([35,36,37,36], 'group-waba'), [36]);
  assert.deepEqual(calls, [35,36,37]);
});
test('full group synchronization updates only overrides whose current primary sender uses this WABA', async t => {
  const broker = require('../../lib/whatsappAuthorizedBrokerClient');
  const templates = require('../../services/whatsappTemplates.service');
  const changed = [];
  t.mock.method(broker, 'templateBinding', async () => ({ clinicId: 36, assetId: 7 }));
  t.mock.method(broker, 'configuration', () => ({ bindings: [] }));
  t.mock.method(broker, 'templates', async () => ({ data: [{ id: 'meta-group', name: local.name, language: 'es', status: 'APPROVED', components }] }));
  t.mock.method(db.WhatsappTemplateCatalog, 'findAll', async () => []);
  t.mock.method(db.WhatsappTemplate, 'findOne', async () => null);
  t.mock.method(db.ClinicMetaAsset, 'findAll', async () => [{ assignmentScope: 'group', grupoClinicaId: 7 }]);
  t.mock.method(db.Clinica, 'findAll', async () => [{ id_clinica: 35 }, { id_clinica: 36 }]);
  t.mock.method(whatsapp, 'getClinicConfig', async id => ({ wabaId: id === 35 ? 'clinic-waba' : 'group-waba' }));
  t.mock.method(db.WhatsappTemplate, 'findAll', async options => {
    if (options.where.waba_id) return []; // no pending resubmissions
    assert.deepEqual(options.where.clinic_id[Op.in], [36]);
    return [{ ...local, clinic_id: 36, update: async value => changed.push(value) }];
  });
  await templates.syncTemplatesForWaba({ wabaId: 'group-waba' });
  assert.equal(changed.length, 1);
  assert.equal(changed[0].meta_template_id, 'meta-group');
});
test('bulk send resolves the same canonical template and does not rank foreign overrides', async t => {
  const bulk = require('../../services/marketingBulkSends.service').__testing;
  t.mock.method(db.WhatsappTemplate, 'findAll', async () => [remote]);
  assert.equal(await bulk.resolveWhatsappTemplateForClinic(local, 35, { wabaId: scope.wabaId }), remote);
  assert.equal(bulk.scoreWhatsappTemplateForScope(local, [35], scope.wabaId), 0);
  assert.equal(bulk.scoreWhatsappTemplateForScope({ ...remote, clinic_id: 36 }, [35], scope.wabaId), 0);
  assert.equal(bulk.scoreWhatsappTemplateForScope(remote, [35], scope.wabaId), 2);
});
