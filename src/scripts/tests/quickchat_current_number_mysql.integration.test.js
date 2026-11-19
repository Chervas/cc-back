'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { Sequelize, DataTypes: D } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { loadSource } = require('./fixtures/business_profile_flow_runtime.fixture');
const { findCurrentConversation } = require('../../services/patientWhatsappContactChange.service');
const { key } = require('../../lib/whatsapp-contact-identity');
const { normalizePhoneE164 } = require('../../lib/phone');
const identityMigration = require('../../../migrations/20261110210000-whatsapp-contact-identities');

test('current-number lookup reads a proved, exact international chat and leaves its ownership and history untouched', async () => {
  await withIsolatedCampaignMysql(async ({ sql, models: db, report }) => {
    db.Sequelize = Sequelize;
    db.sequelize = sql;
    const define = (name, fields, tableName) => sql.define(name, fields, { tableName, timestamps: false });
    db.Paciente = define('Paciente', { id_paciente: { type: D.INTEGER, primaryKey: true },
      clinica_id: D.INTEGER, telefono_movil: D.STRING, public_id: D.STRING, nombre: D.STRING,
      apellidos: D.STRING, foto: D.STRING, email: D.STRING }, 'Pacientes');
    db.PacienteClinica = define('PacienteClinica', { paciente_id: D.INTEGER, clinica_id: D.INTEGER }, 'PacienteClinicas');
    db.Conversation = define('Conversation', { clinic_id: D.INTEGER, channel: D.STRING, contact_id: D.STRING,
      patient_id: D.INTEGER, lead_id: D.INTEGER }, 'Conversations');
    db.Message = define('Message', { conversation_id: D.INTEGER, content: D.STRING, status: D.STRING }, 'Messages');
    await sql.sync();
    await identityMigration.up({ sequelize: sql });
    const identityService = loadSource('whatsappContactIdentity.service', { '../../models': db },
      { WHATSAPP_CONTACT_IDENTITIES_ENABLED: 'true' });

    const patient = { id_paciente: 27, clinica_id: 66, telefono_movil: '306900000003' };
    const old = { id: 10, clinic_id: 72, channel: 'whatsapp', contact_id: '+30690000003', patient_id: 27 };
    const unowned = { id: 11, clinic_id: 72, channel: 'whatsapp', contact_id: '+30 690 000 0003', patient_id: null, lead_id: null };
    const sender = { phoneNumberId: '11111111111', wabaId: '22222222222' };
    const otherPatient = 28;
    await db.Paciente.create(patient);
    await db.PacienteClinica.create({ paciente_id: patient.id_paciente, clinica_id: 72 });
    await db.Conversation.bulkCreate([old, unowned, { ...unowned, id: 12, clinic_id: 83, patient_id: otherPatient }]);
    await db.Message.bulkCreate([
      { conversation_id: old.id, content: 'Synthetic original send', status: 'failed' },
      { conversation_id: unowned.id, content: 'Synthetic valid delivery', status: 'read' },
    ]);

    const identityKey = key(72, '33333333333', 'phone', patient.telefono_movil);
    await sql.query(`INSERT INTO WhatsappContactIdentities
      (identity_key,clinic_id,business_id,identity_type,identity_value,conversation_id,waba_id,phone_id,source,created_at,updated_at)
      VALUES(?,72,'33333333333','phone',?,11,?,?,'provider',NOW(3),NOW(3))`, {
      replacements: [identityKey, patient.telefono_movil, sender.wabaId, sender.phoneNumberId],
    });
    const lookup = (overrides = {}) => sql.transaction({ readOnly: true, isolationLevel: 'REPEATABLE READ' }, transaction =>
      findCurrentConversation({ db, patient, clinicId: 72, transaction, identityService,
        senderForClinic: async () => sender, ...overrides }));
    const snapshot = async () => [await db.Conversation.findAll({ raw: true }), await db.Message.findAll({ raw: true }),
      (await sql.query('SELECT * FROM WhatsappContactIdentities'))[0], (await sql.query('SELECT * FROM WhatsappConversationLinks'))[0]];
    const before = await snapshot();
    assert.equal((await lookup()).id, 11);
    assert.equal(await lookup({ clinicId: 24 }), null);
    await assert.rejects(lookup({ senderForClinic: async () => ({ ...sender, phoneNumberId: '44444444444' }) }),
      { code: 'quickchat_current_number_unverified' });

    let allowUnowned = true;
    const handlers = {};
    const controller = fs.readFileSync(require.resolve('../../controllers/conversation.controller'), 'utf8');
    vm.runInNewContext(controller.slice(controller.indexOf('async function readConversationByPatient('), controller.indexOf('exports.getConversationByLead =')), {
      exports: handlers, db, Paciente: db.Paciente, Conversation: db.Conversation, CitaPaciente: {},
      findCurrentConversation, normalizePhoneE164, contactIdentity: { ...identityService, enrich: async rows => rows },
      whatsappService: { getClinicConfig: async () => sender }, getUserClinics: async () => ({ clinicIds: [72] }),
      ensureAccess: ({ clinicIds }, id) => clinicIds.includes(id),
      ensureQuickChatConversationReadAccess: async (_id, row) => {
        if (!row.patient_id && !allowUnowned) throw Error('quickchat_category_forbidden');
      },
      sendQuickChatCategoryForbidden: res => res.status(403).json({ error: 'forbidden' }),
      findCanonicalWhatsappConversation: () => assert.fail('Opening a current number must not call the mutation-capable lookup'),
      enrichConversationUnreadForUser: async (_id, row) => row, attachContactRestrictions: async rows => rows,
      enrichPatientDirectionAssignments: async rows => rows, attachTemporaryQuickChatEligibility: async rows => rows,
      getConversationMessagePage: async (row, _query, transaction) => ({
        messages: await db.Message.findAll({ where: { conversation_id: row.id }, raw: true, transaction }), messagesPage: {},
      }),
    });
    async function read(query = {}) {
      const req = { userData: { userId: 7 }, params: { patientId: '27' }, query: { clinic_id: '72', current_number_from: '10', ...query } };
      const res = { statusCode: 200, status(statusCode) { this.statusCode = statusCode; return this; }, json(data) { this.data = data; return this; } };
      return handlers.getCurrentNumberConversationByPatient(req, res);
    }
    const opened = await read();
    assert.equal(opened.statusCode, 200);
    assert.equal(opened.data.conversation.id, 11);
    assert.equal(opened.data.conversation.patient_id, null);
    assert.equal(opened.data.messages[0].status, 'read');
    assert.equal((await read({ current_number_from: '11' })).statusCode, 404);
    assert.equal((await read({ current_number_from: undefined })).statusCode, 400);
    assert.equal((await read({ clinic_id: '83' })).statusCode, 403);
    allowUnowned = false;
    assert.equal((await read()).statusCode, 403);
    allowUnowned = true;
    assert.deepEqual(await snapshot(), before);

    await db.Paciente.create({ ...patient, id_paciente: otherPatient, clinica_id: 72, telefono_movil: '0030 690 000 0003' });
    await assert.rejects(lookup(), { code: 'quickchat_current_number_unverified' });
    await db.Paciente.destroy({ where: { id_paciente: otherPatient } });
    await db.Conversation.update({ lead_id: 50 }, { where: { id: 11 } });
    await assert.rejects(lookup(), { code: 'quickchat_current_number_unverified' });
    await db.Conversation.update({ patient_id: otherPatient }, { where: { id: 11 } });
    await assert.rejects(lookup(), { code: 'whatsapp_contact_identity_conflict' });
    const conflict = await read();
    assert.equal(conflict.statusCode, 409);
    assert.match(conflict.data.error, /otra ficha/);
    await db.Conversation.update({ patient_id: patient.id_paciente }, { where: { id: 11 } });
    const withHistoricalLead = await lookup();
    assert.equal(withHistoricalLead.id, 11);
    assert.equal(withHistoricalLead.lead_id, 50);
    await db.Conversation.create({ ...unowned, id: 13, contact_id: '00306900000003' });
    await assert.rejects(lookup(), { code: 'whatsapp_contact_identity_conflict' });

    await db.Paciente.update({ telefono_movil: '306900000004' }, { where: { id_paciente: patient.id_paciente } });
    const absent = await read();
    assert.equal(absent.statusCode, 404);
    assert.equal(absent.data.error, 'quickchat_current_number_not_found');

    report.checks.push('exact Greek number, authorized sender proof, primary/secondary clinic scope, foreign owner/lead/duplicates denied, original records immutable');
  });
});
