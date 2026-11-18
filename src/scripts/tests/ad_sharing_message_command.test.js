'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { Op } = require('sequelize');
const { resolveAdSharingMessage } = require('../../services/adSharingMessage.service');

function fixture({ unavailable = false, stale = false, omitSelection = false } = {}) {
  const calls = { rows: [], queued: [], committed: 0, rolledBack: 0 };
  const family = 'clinicaclick_compartir_promocion';
  const template = { id: 1, name: family, category: 'MARKETING', status: 'APPROVED', is_active: true,
    catalog_template_id: 1, language: 'es', components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Hola {{1}}, desde {{2}}: {{3}}.' }] };
  const transaction = { LOCK: { UPDATE: 'UPDATE' }, commit: async () => { calls.committed++; transaction.finished = 'commit'; },
    rollback: async () => { calls.rolledBack++; transaction.finished = 'rollback'; } };
  const conversation = { id: 7, clinic_id: 66, patient_id: 5, channel: 'whatsapp', contact_id: '34000000123', save: async () => {} };
  const body = params => [{ type: 'body', parameters: Object.keys(params).map(key => ({ type: 'text', text: params[key] })) }];
  const canonical = { reference: { provider: 'meta_ads', account_id: '123', campaign_id: '456', group_id: '800', ad_id: '700' },
    templateFamily: family, selection: { allowed: !unavailable }, creative: { available: !unavailable, source: 'social_posts',
      kind: 'IMAGE', shareText: 'Source advertising copy', fingerprint: 'a'.repeat(64),
      mediaParameter: { type: 'image', image: { link: 'https://scontent.fbcdn.net/original.jpg' } } } };
  const context = { exports: {}, console, Buffer, Op,
    db: { sequelize: { transaction: async () => transaction }, WhatsappTemplateCatalog: {
      findByPk: async () => ({ family_key: family, category: 'MARKETING', is_active: true }) } },
    Conversation: { findByPk: async () => conversation },
    Paciente: { findByPk: async () => ({ telefono_movil: conversation.contact_id }) },
    WhatsappTemplate: { findOne: async () => template },
    Message: { create: async values => { calls.rows.push(structuredClone(values)); return { ...values, id: 9 }; } },
    getUserClinics: async () => ({ clinicIds: [66] }), ensureAccess: () => true, ensureQuickChatConversationReadAccess: async () => {},
    findCanonicalWhatsappConversation: async () => null, getIO: () => null,
    patientDirectionService: { resolveOutboundPolicy: async () => ({ clinicConfig: { authorizedBroker: {}, phoneNumberId: '401', wabaId: '301' } }) },
    isWhatsappRoutingConfigAvailable: () => true, canUserSelectWhatsappTemplate: () => true, isReviewWorkflowWhatsappTemplate: () => false,
    extractWhatsappTemplateDisplayButtons: () => [],
    whatsappService: { normalizePhoneNumber: v => v, assertRecipientCanReceive: async () => {}, checkOutboundLimit: async () => ({}), buildTemplateComponents: ({ templateParams }) => body(templateParams) },
    queues: { outboundWhatsApp: { add: async (...args) => { calls.queued.push(args); } } },
    markBufferedResponseExecutionsForHumanReply: async () => {}, completeAutomationStateAfterHumanReplyForConversation: async () => ({}),
    resolveAutomationAttentionForConversation: async () => ({}), process: { env: {} },
    require: name => {
      if (name === '../lib/whatsapp-contact-identity') return require('../../lib/whatsapp-contact-identity');
      if (name === '../services/whatsappTemplateScope.service') return { resolveTemplateInWaba: async () => template };
      if (name === '../services/temporaryPatientDirection.service') return { observeConversation: async () => {} };
      if (name === '../services/adSharingMessage.service') return { resolveAdSharingMessage: options => resolveAdSharingMessage({ ...options,
        hasAccess: async () => true, load: async () => ({ items: [canonical] }) }) };
      throw Error('Unexpected module: ' + name);
    },
  };
  const source = fs.readFileSync(require.resolve('../../controllers/conversation.controller'), 'utf8');
  vm.runInNewContext(source.slice(source.indexOf('exports.postMessage ='), source.indexOf('exports.sendScheduledMessageNow =')), context);
  const req = { params: { id: '7' }, userData: { userId: 1 }, body: { message: 'Untrusted client display', message_type: 'template',
    useTemplate: true, templateId: 1, templateParams: { '1': 'Alex', '2': 'Clinic', '3': 'Untrusted invented conditions' },
    templateComponents: [{ type: 'header', parameters: [{ type: 'image', image: { link: 'https://attacker.invalid/not-the-ad.jpg' } }] }],
    ...(omitSelection ? {} : { adSharing: { purpose: 'patient_promotion', ad_id: '700', creative_sha256: (stale ? 'b' : 'a').repeat(64) } }) } };
  const res = { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
  return { calls, req, res, run: () => context.exports.postMessage(req, res) };
}

test('native conversation command stores canonical copy/header and queues exactly once after commit, ignoring client media', async () => {
  const f = fixture(); await f.run();
  assert.equal(f.res.statusCode, 200); assert.equal(f.calls.rows.length, 1); assert.equal(f.calls.committed, 1); assert.equal(f.calls.queued.length, 1);
  const payload = f.calls.queued[0][1];
  assert.equal(payload.templateComponents[0].parameters[0].image.link, 'https://scontent.fbcdn.net/original.jpg');
  assert.equal(payload.templateParams['3'], 'Source advertising copy');
  assert.equal(payload.body, 'Hola Alex, desde Clinic: Source advertising copy.');
  assert.equal(f.calls.rows[0].content, payload.body);
  assert(!JSON.stringify(f.calls.rows).includes('attacker.invalid'));
});

test('missing asset, stale preview or omitted source selection rolls back before creating or queuing a message', async () => {
  for (const options of [{ unavailable: true }, { stale: true }, { omitSelection: true }]) {
    const f = fixture(options); await f.run();
    assert.ok([400, 409].includes(f.res.statusCode)); assert.equal(f.calls.rows.length, 0); assert.equal(f.calls.queued.length, 0); assert.equal(f.calls.rolledBack, 1);
  }
});
