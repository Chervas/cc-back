'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { Op } = require('sequelize');
const { resolveAdSharingMessage, resolveExistingPatientLeadConversation } = require('../../services/adSharingMessage.service');
const { templateDigest, validateMessage, verifyTemplate } = require('../../../services/integrations-broker/src/whatsapp-authorized-contract');

function fixture({ unavailable = false, stale = false, omitSelection = false, repeatLead = false, variant = false,
  blocked = false, video = false, limited = false, socketFailed = false } = {}) {
  const calls = { rows: [], queued: [], contacts: [], realtime: [], committed: 0, rolledBack: 0 };
  const baseFamily = repeatLead ? 'clinicaclick_enviar_anuncio' : 'clinicaclick_compartir_promocion';
  const family = video ? baseFamily + '_video' : baseFamily;
  const format = video ? 'VIDEO' : 'IMAGE';
  const kind = format.toLowerCase();
  const link = video ? 'https://video.fbcdn.net/original.mp4' : 'https://scontent.fbcdn.net/original.jpg';
  const template = { id: 1, name: family, category: 'MARKETING', status: 'APPROVED', is_active: true,
    catalog_template_id: 1, language: 'es', components: [{ type: 'HEADER', format }, { type: 'BODY', text: 'Hola {{1}}, desde {{2}}: {{3}}.' }] };
  const transaction = { LOCK: { UPDATE: 'UPDATE' }, commit: async () => { calls.committed++; transaction.finished = 'commit'; },
    rollback: async () => { calls.rolledBack++; transaction.finished = 'rollback'; } };
  const conversation = { id: 7, clinic_id: 66, patient_id: 5, channel: 'whatsapp', contact_id: '34000000123', save: async () => {} };
  if (repeatLead) conversation.lead_id = 9;
  const body = params => [{ type: 'body', parameters: Object.keys(params).map(key => ({ type: 'text', text: params[key] })) }];
  const canonical = { reference: { provider: 'meta_ads', account_id: '123', campaign_id: '456', group_id: '800', ad_id: '700' },
    templateFamily: family, selection: { allowed: !unavailable }, creative: { available: !unavailable, source: 'social_posts',
      kind: format, shareText: 'Source advertising copy', fingerprint: 'a'.repeat(64),
      mediaParameter: { type: kind, [kind]: { link } } } };
  if (variant) Object.assign(canonical.creative, { variant_id: 'b'.repeat(64), snapshot_sha256: 'c'.repeat(64),
    provenance: { source: 'asset_feed_spec', path: 'images[1]' } });
  const context = { exports: {}, console, Buffer, Op,
    db: { sequelize: { transaction: async () => transaction }, LeadIntake: { findOne: async () => ({ id: 10, clinica_id: 66, telefono: conversation.contact_id }) }, WhatsappTemplateCatalog: {
      findByPk: async () => ({ family_key: family, category: 'MARKETING', is_active: true }) } },
    Conversation: { findByPk: async () => conversation },
    Paciente: { findByPk: async () => ({ telefono_movil: conversation.contact_id }) },
    WhatsappTemplate: { findOne: async () => template },
    Message: { create: async values => { calls.rows.push(structuredClone(values)); return { ...values, id: 9 }; } },
    getUserClinics: async () => ({ clinicIds: [66] }), ensureAccess: () => true, ensureQuickChatConversationReadAccess: async () => {},
    findCanonicalWhatsappConversation: async options => options.readOnly ? conversation : null,
    resolveLeadWhatsappPhone: async lead => lead.telefono,
    registerLeadWhatsappContactAttempt: async options => calls.contacts.push(options),
    getIO: () => ({ to: room => ({ emit: (event, payload) => {
      if (socketFailed) throw Error('Socket offline');
      calls.realtime.push({ room, event, payload, committed: calls.committed });
    } }) }),
    patientDirectionService: { resolveOutboundPolicy: async () => ({ clinicConfig: { authorizedBroker: {}, phoneNumberId: '401', wabaId: '301' } }) },
    isWhatsappRoutingConfigAvailable: () => true, canUserSelectWhatsappTemplate: () => true, isReviewWorkflowWhatsappTemplate: () => false,
    extractWhatsappTemplateDisplayButtons: () => [],
    whatsappService: { normalizePhoneNumber: v => v, assertRecipientCanReceive: async () => {
      if (blocked) throw Object.assign(Error('Recipient blocked'), { status: 403, code: 'whatsapp_recipient_blocked' });
    }, checkOutboundLimit: async () => ({ limitReached: limited }), buildTemplateComponents: ({ templateParams }) => body(templateParams) },
    queues: { outboundWhatsApp: { add: async (...args) => { calls.queued.push(args); } } },
    markBufferedResponseExecutionsForHumanReply: async () => {}, completeAutomationStateAfterHumanReplyForConversation: async () => ({}),
    resolveAutomationAttentionForConversation: async () => ({}), process: { env: {} },
    require: name => {
      if (name === '../lib/whatsapp-contact-identity') return require('../../lib/whatsapp-contact-identity');
      if (name === '../lib/socket-view-invalidation') return require('../../lib/socket-view-invalidation');
      if (name === '../services/whatsappTemplateScope.service') return { resolveTemplateInWaba: async () => template };
      if (name === '../services/temporaryPatientDirection.service') return { observeConversation: async () => {} };
      if (name === '../services/leadPatientContext.service') return { get: async () => ({ relationship: 'existing_patient', patient_id: 5, clinic_id: 66, same_clinic: true }) };
      if (name === '../services/adSharingMessage.service') return { resolveAdSharingMessage: options => resolveAdSharingMessage({ ...options,
        hasAccess: async () => true, load: async options => {
          assert.equal(options.selectedVariantId, variant ? 'b'.repeat(64) : null);
          return { items: [canonical] };
        } }), resolveExistingPatientLeadConversation };
      throw Error('Unexpected module: ' + name);
    },
  };
  const source = fs.readFileSync(require.resolve('../../controllers/conversation.controller'), 'utf8');
  vm.runInNewContext(source.slice(source.indexOf('exports.postMessage ='), source.indexOf('exports.sendScheduledMessageNow =')), context);
  const req = { params: { id: '7' }, userData: { userId: 1 }, body: { message: 'Untrusted client display', message_type: 'template',
    useTemplate: true, templateId: 1, templateParams: { '1': 'Alex', '2': 'Clinic', '3': 'Untrusted invented conditions' },
    templateComponents: [{ type: 'header', parameters: [{ type: 'image', image: { link: 'https://attacker.invalid/not-the-ad.jpg' } }] }],
    ...(omitSelection ? {} : { adSharing: { purpose: repeatLead ? 'lead_ad' : 'patient_promotion', ad_id: '700',
      ...(repeatLead ? { lead_id: 10 } : {}), ...(variant ? { variant_id: 'b'.repeat(64) } : {}),
      creative_sha256: (stale ? 'b' : 'a').repeat(64) } }) } };
  const res = { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
  return { calls, req, res, template, link, run: () => context.exports.postMessage(req, res) };
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

test('a repeated patient enquiry uses the native command and records contact on the requested lead without rewriting the chat', async () => {
  const f = fixture({ repeatLead: true }); await f.run();
  assert.equal(f.res.statusCode, 200); assert.equal(f.calls.rows.length, 1); assert.equal(f.calls.queued.length, 1);
  assert.equal(f.calls.rows[0].metadata.ad_sharing.lead_id, 10);
  assert.equal(f.calls.contacts.length, 1); assert.equal(f.calls.contacts[0].leadId, 10);
});

test('one selected v2 alternative uses the existing transactional command and native queue exactly once', async () => {
  const f = fixture({ variant: true }); await f.run();
  assert.equal(f.res.statusCode, 200); assert.equal(f.calls.committed, 1); assert.equal(f.calls.queued.length, 1);
  assert.equal(f.calls.rows[0].metadata.ad_sharing.variant_id, 'b'.repeat(64));
  assert.equal(f.calls.rows[0].metadata.ad_sharing.provenance.path, 'images[1]');
  assert.equal(f.calls.queued[0][1].templateParams['3'], 'Source advertising copy');
  assert.equal(f.calls.queued[0][1].templateComponents[0].parameters[0].image.link, 'https://scontent.fbcdn.net/original.jpg');
});

test('v2 double selection, stale source and existing recipient block never create or queue a message', async () => {
  for (const mode of ['double', 'missing-fingerprint', 'stale', 'blocked']) {
    const f = fixture({ variant: true, stale: mode === 'stale', blocked: mode === 'blocked' });
    if (mode === 'double') f.req.body.adSharing.variant_id = ['a'.repeat(64), 'b'.repeat(64)];
    if (mode === 'missing-fingerprint') delete f.req.body.adSharing.creative_sha256;
    await f.run();
    assert.ok(f.res.statusCode >= 400, mode);
    assert.equal(f.calls.rows.length, 0, mode); assert.equal(f.calls.queued.length, 0, mode);
    assert.equal(f.calls.rolledBack, 1, mode);
  }
});

test('the selected ad video survives the canonical message and actual broker template contract', async () => {
  for (const repeatLead of [false, true]) {
    const f = fixture({ video: true, variant: true, repeatLead });
    delete f.req.body.message_type;
    await f.run();
    assert.equal(f.res.statusCode, 200);
    assert.equal(f.calls.queued.length, 1);
    const stored = f.res.body.message;
    const queued = f.calls.queued[0][1];
    const template = { id: '123', name: f.template.name, status: 'APPROVED', language: 'es', components: f.template.components };
    const sent = { messaging_product: 'whatsapp', type: 'template', to: queued.to, template: {
      name: queued.templateName, language: { code: queued.templateLanguage }, components: queued.templateComponents,
    } };
    assert.equal(stored.message_type, 'template');
    assert.equal(stored.metadata.ad_sharing.media_kind, 'VIDEO');
    assert.equal(stored.metadata.templateComponents[0].parameters[0].video.link, f.link);
    assert.deepEqual(stored.metadata.templateComponents, queued.templateComponents);
    assert.equal(validateMessage(sent), sent);
    assert.equal(verifyTemplate(template, { id: '123', name: template.name, language: 'es', contentDigest: templateDigest(template) }, sent), true);
  }
});

test('ad media is available through the committed message reader without broadcasting URL or caption in the clinic room', async () => {
  for (const limited of [false, true]) {
    const f = fixture({ limited }); await f.run();
    assert.equal(f.res.statusCode, limited ? 429 : 200);
    const created = f.calls.realtime.find(item => item.event === 'message:created');
    assert.deepEqual(created, { room: 'clinic:66', event: 'message:created', committed: 1,
      payload: { id: 9, conversation_id: 7, realtime_refresh: true } });
    assert.equal(f.res.body.message.metadata.templateComponents[0].parameters[0].image.link, f.link);
    assert.equal(f.calls.queued.length, limited ? 0 : 1);
  }
});

test('a socket outage after commit leaves the sent ad template queued exactly once', async () => {
  const f = fixture({ socketFailed: true }); await f.run();
  assert.equal(f.res.statusCode, 200);
  assert.equal(f.calls.committed, 1);
  assert.equal(f.calls.rolledBack, 0);
  assert.equal(f.calls.queued.length, 1);
  assert.equal(f.res.body.message.metadata.templateComponents[0].parameters[0].image.link, f.link);
});
