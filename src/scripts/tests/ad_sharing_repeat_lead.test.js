'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Sequelize = require('sequelize');
const { resolveAdSharingMessage, resolveExistingPatientLeadConversation } = require('../../services/adSharingMessage.service');
const phone = require('../../lib/phone');

function fixture() {
  const writes = () => assert.fail('read-only identity validation must not mutate');
  const conversation = { id: 303, clinic_id: 66, channel: 'whatsapp', patient_id: 5, lead_id: 9, contact_id: '+34600000001' };
  const rows = [conversation];
  const lead = { id: 10, clinica_id: 66, nombre: 'Paciente ficticio', telefono: '+34600000001', email: null, created_at: '2026-11-18T09:00:00Z' };
  const context = { relationship: 'existing_patient', patient_id: 5, clinic_id: 66, same_clinic: true };
  const calls = { leadReads: [], canonicalReads: [], load: [], context: 0 };
  const db = { Sequelize, Conversation: { findAll: async options => { calls.canonicalReads.push(options); return rows; },
    create: writes, update: writes, destroy: writes }, Message: { update: writes, create: writes, destroy: writes },
    ConversationRead: {}, WhatsAppWebOrigin: {}, sequelize: { transaction: writes, query: writes } };
  const sandbox = { module: { exports: {} }, process: { env: { META_WHATSAPP_DEFAULT_COUNTRY_CODE: '+34' } },
    require: name => {
      if (name === '../../models') return db;
      if (name === './phone') return phone;
      if (name === '../services/whatsapp.service') return {};
      assert.fail('unexpected canonical dependency: ' + name);
    } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../../lib/canonical-conversation'), 'utf8'), sandbox);
  const family = 'clinicaclick_enviar_anuncio';
  const models = { WhatsappTemplateCatalog: { findByPk: async () => ({ family_key: family, category: 'MARKETING', is_active: true }) },
    LeadIntake: { findOne: async options => { calls.leadReads.push(options); return lead; } } };
  const args = { models, conversation, userId: 44,
    template: { name: family, catalog_template_id: 1, is_active: true, status: 'APPROVED', category: 'MARKETING',
      components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Hola {{1}}, desde {{2}}: {{3}}.' }] },
    input: { purpose: 'lead_ad', ad_id: '700', lead_id: 10 }, templateParams: { '1': 'Paciente', '2': 'Clínica' },
    hasAccess: async () => true,
    buildBody: params => [{ type: 'body', parameters: Object.values(params).map(text => ({ type: 'text', text })) }],
    load: async options => { calls.load.push(options); return { items: [{ reference: { ad_id: '700' }, templateFamily: family,
      selection: { allowed: true }, creative: { available: true, kind: 'IMAGE', shareText: 'Anuncio real',
        mediaParameter: { type: 'image', image: { link: 'https://scontent.fbcdn.net/ad.jpg' } } } }] }; },
    resolveLeadConversation: options => resolveExistingPatientLeadConversation({ ...options,
      getPatientContext: async value => { calls.context++; assert.equal(value, lead); return context; },
      resolvePhone: async value => { assert.equal(value.update, undefined); return value.telefono; },
      findCanonical: sandbox.module.exports.findCanonicalWhatsappConversation,
    }),
  };
  return { args, conversation, lead, context, rows, calls };
}

test('a repeated enquiry may share its exact existing patient chat without rewriting the older lead link', async () => {
  const f = fixture(); const before = structuredClone(f.conversation);
  const result = await resolveAdSharingMessage(f.args);
  assert.deepEqual(f.conversation, before);
  assert.equal(result.metadata.lead_id, 10);
  assert.equal(f.calls.load[0].input.lead_id, '10');
  assert.equal(f.calls.leadReads[0].where.id, 10); assert.equal(f.calls.leadReads[0].where.clinica_id, 66);
  assert.equal(f.calls.leadReads[0].where.archived_at, null); assert.equal(f.calls.leadReads[0].raw, true);
  assert.equal(f.calls.canonicalReads.length, 1);
});

test('another person, clinic, contact or ambiguous evidence cannot use the existing patient exception', async () => {
  for (const change of [f => { f.context.patient_id = 8; }, f => { f.context.relationship = 'possible_patient'; },
    f => { f.context.same_clinic = false; }, f => { f.context.clinic_id = 72; },
    f => { f.lead.clinica_id = 72; }, f => { f.lead.id = 11; },
    f => { f.lead.telefono = '+34600000002'; }, f => { f.conversation.patient_id = 7; },
    f => { f.rows.push({ ...f.conversation, id: 404 }); }, f => { f.rows[0] = { ...f.conversation, id: 404 }; }]) {
    const f = fixture(); change(f); const before = structuredClone(f.conversation);
    await assert.rejects(resolveAdSharingMessage(f.args), { code: 'ad_sharing_lead_mismatch' });
    assert.deepEqual(f.conversation, before); assert.equal(f.calls.load.length, 0);
  }
});

test('missing canonical proof, missing requested lead and revoked access fail before source resolution', async () => {
  for (const change of [f => { f.args.resolveLeadConversation = undefined; },
    f => { f.args.models.LeadIntake.findOne = async () => null; },
    f => { f.args.hasAccess = async () => false; }]) {
    const f = fixture(); change(f);
    await assert.rejects(resolveAdSharingMessage(f.args)); assert.equal(f.calls.load.length, 0);
  }
});
