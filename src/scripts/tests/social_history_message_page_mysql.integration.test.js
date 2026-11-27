'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Sequelize, DataTypes } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { loadSource } = require('./fixtures/business_profile_flow_runtime.fixture');

test('QuickChat and lead threads paginate social history by provider time, including hidden cursor rows', async () => {
  await withIsolatedCampaignMysql(async ({ sql, models: db, report }) => {
    db.Sequelize = Sequelize;
    const Conversation = sql.define('Conversation', {
      clinic_id: DataTypes.INTEGER, channel: DataTypes.STRING, lead_id: DataTypes.INTEGER,
      patient_id: DataTypes.INTEGER, contact_id: DataTypes.STRING, last_message_at: DataTypes.DATE,
      social_account_name: DataTypes.STRING, social_alias: DataTypes.STRING,
    }, { timestamps: false });
    db.Message = sql.define('Message', {
      conversation_id: DataTypes.INTEGER, sent_at: DataTypes.DATE(6),
      createdAt: DataTypes.DATE(6), metadata: DataTypes.JSON,
    }, { timestamps: false });
    await sql.sync();
    const threads = [
      { id: 1, clinic_id: 10, channel: 'instagram', lead_id: 101 },
      { id: 2, clinic_id: 10, channel: 'messenger', lead_id: 102 },
      { id: 3, clinic_id: 10, channel: 'whatsapp' },
      { id: 4, clinic_id: 20, channel: 'instagram', lead_id: 104 },
    ];
    await Conversation.bulkCreate(threads);
    // The associations used for presentation do not participate in the message query.
    db.Conversation = {
      findByPk: id => Conversation.findByPk(id), findAll: options => Conversation.findAll(options),
    };
    db.LeadIntake = {
      findByPk: id => ({ id, clinica_id: threads.find(t => t.lead_id === id).clinic_id }),
      findAll: async () => [],
    };
    db.LeadAssistantSession = { findOne: async () => null };
    db.UsuarioClinica = { findAll: async () => [{ id_clinica: 10, rol_clinica: 'equipo' }] };
    const passthrough = { enrich: async rows => rows };
    const controller = loadSource('../controllers/conversation.controller', {
      '../../models': db,
      '../services/inboundLeadCapturePresentation.service': require('../../services/inboundLeadCapturePresentation.service'),
      '../services/patientDirection.service': { getAssignedClinicIds: async () => [] },
      '../services/marketingOptOut.service': { getActiveContactRestrictionsForConversations: async () => new Map() },
      '../services/whatsappContactIdentity.service': {
        ...passthrough, memberIds: require('../../services/whatsappContactIdentity.service').memberIds,
        aggregatePending: async () => new Map(),
      },
      '../services/whatsapp.service': { normalizePhoneNumber: () => null },
      '../lib/canonical-conversation': { findCanonicalWhatsappConversation: async () => null },
      '../lib/access-policy': { canUserAccessFeature: async ({ actorId, clinicId, featureKey }) =>
        actorId === 7 && clinicId === 10 && featureKey === 'quickchat.read_leads' },
      '../services/temporaryPatientDirection.service': passthrough,
      '../services/leadPatientAttention.service': passthrough,
      '../services/leadPatientContext.service': passthrough,
      '../services/socialInbox.service': { service: () => ({ availability: async () => ({}) }) },
    }, {});
    async function read(thread, byLead, query = {}, actor = 7) {
      const req = { userData: { userId: actor }, params: { id: thread.id, leadId: thread.lead_id }, query };
      const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(data) {
        this.data = JSON.parse(JSON.stringify(data)); return this;
      } };
      return (byLead ? controller.getConversationByLead : controller.getMessages)(req, res);
    }
    for (const thread of threads) {
      const base = 100 * thread.id;
      const messages = Array.from({ length: 27 }, (_, i) => ({
        id: base + i + 1, conversation_id: thread.id,
        // The live DM comes first by insertion. The subsequent import has 24 tied timestamps.
        sent_at: i === 0 ? '2026-01-10' : i === 1 ? null : i === 2 ? '2026-01-01' : '2026-01-05',
        createdAt: i === 1 ? '2026-01-08' : '2026-01-11',
        metadata: i === 9 ? { hide_from_quickchat: true } : i === 8 ? { qa_cleanup: true } : {},
      }));
      await db.Message.bulkCreate(messages);
    }
    for (const thread of threads.slice(0, 2)) {
      const base = thread.id * 100;
      for (const byLead of [false, true]) {
        const page = async query => {
          const response = await read(thread, byLead, query);
          assert.equal(response.statusCode, 200, JSON.stringify(response.data));
          assert.equal(response.data.conversation.id, thread.id);
          return response.data;
        };
        const first = await page({});
        assert.equal(first.messages.at(-1).id, base + 1, 'the original live DM remains visible after backfill');
        assert.deepEqual(first.messages.map(m => m.id), [
          ...Array.from({ length: 17 }, (_, i) => base + 11 + i), base + 2, base + 1,
        ]);
        assert.deepEqual(first.messages_page, { limit: 20, has_more_before: true, next_before_message_id: base + 10 });
        const refreshed = await page({ message_id: base + 27, before_message_id: 9999, limit: 2 });
        assert.deepEqual(refreshed.messages.map(m => m.id), [base + 27]);
        assert.deepEqual(refreshed.messages_page, { limit: 1, has_more_before: false, next_before_message_id: null });
        for (const exact of [base + 9, base + 10, 401, (3 - thread.id) * 100 + 1, 9999, 'bad']) {
          assert.deepEqual((await page({ message_id: exact })).messages, []);
        }
        const second = await page({ before_message_id: first.messages_page.next_before_message_id });
        assert.deepEqual(second.messages.map(m => m.id), Array.from({ length: 6 }, (_, i) => base + 3 + i));
        assert.equal(second.messages_page.has_more_before, false);
        const hidden = await page({ before_message_id: base + 11, limit: 2 });
        assert.deepEqual(hidden.messages, []);
        assert.equal(hidden.messages_page.next_before_message_id, base + 9);
        for (const cursor of [401, 9999, (3 - thread.id) * 100 + 1]) {
          const unrelated = await page({ before_message_id: cursor });
          assert.deepEqual(unrelated.messages, []);
          assert.equal(unrelated.messages_page.has_more_before, false);
        }
      }
    }
    // SQL can distinguish provider times inside one millisecond even if a JS Date cannot.
    await sql.query(`UPDATE Messages
      SET sent_at = CASE id WHEN 103 THEN '2026-01-10 00:00:00.000002' ELSE '2026-01-10 00:00:00.000001' END
      WHERE id IN (103, 127)`);
    const newest = (await read(threads[0], false, { limit: 1 })).data;
    assert.equal(newest.messages[0].id, 103);
    const prior = (await read(threads[0], true, { limit: 1, before_message_id: newest.messages_page.next_before_message_id })).data;
    assert.equal(prior.messages[0].id, 127);
    const whatsapp = await read(threads[2], false, { limit: 1 });
    assert.equal(whatsapp.data.messages[0].id, 327);
    assert.equal((await read(threads[2], false, { before_message_id: 327, limit: 1 })).data.messages[0].id, 326);
    assert.equal((await read(threads[3], false)).statusCode, 403);
    assert.equal((await read(threads[3], true)).statusCode, 403);
    assert.equal((await read(threads[0], false, {}, 8)).statusCode, 403);
    assert.equal((await read(threads[0], true, {}, 8)).statusCode, 404);
    report.checks.push('Instagram and Messenger, QuickChat and Lead endpoints, late backfill, ties, fallback time, hidden cursor, clinic/category scope, unchanged WhatsApp cursor');
  });
});
