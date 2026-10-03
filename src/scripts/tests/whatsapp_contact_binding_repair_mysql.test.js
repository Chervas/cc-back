'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createHash, randomUUID } = require('node:crypto');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { SCHEMA } = require('../../lib/whatsappInboxImport');
const { importScopedLease } = require('../../lib/whatsappInboxScopes');
const { repairOrphanedContactBinding } = require('../../lib/whatsappInboxContactRepair');
const { eligible } = require('../../lib/whatsappFreshInboundEligibility');
const phone = require('../../lib/phone');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('merges preserve inbox bindings atomically; explicit orphan repair preserves scope and passive recovery', async () => {
  await withIsolatedCampaignMysql(async ({ sql, report }) => {
    const Sequelize = require('sequelize');
    const integer = Sequelize.DataTypes.INTEGER;
    const string = Sequelize.DataTypes.STRING;
    const Conversation = sql.define('Conversation', {
      id: { type: integer, primaryKey: true, autoIncrement: true }, clinic_id: integer,
      channel: string, contact_id: string, patient_id: integer, lead_id: integer, assignee_id: integer,
      unread_count: integer, last_message_at: Sequelize.DataTypes.DATE,
      last_inbound_at: Sequelize.DataTypes.DATE,
    }, { tableName: 'Conversations' });
    const Message = sql.define('Message', {
      id: { type: integer, primaryKey: true, autoIncrement: true }, conversation_id: integer,
      direction: string, content: Sequelize.DataTypes.TEXT, message_type: string,
      status: string, metadata: Sequelize.DataTypes.JSON, sent_at: Sequelize.DataTypes.DATE,
    }, { tableName: 'Messages' });
    const ConversationRead = sql.define('ConversationRead', {
      id: { type: integer, primaryKey: true, autoIncrement: true }, conversation_id: integer,
      user_id: integer, last_read_at: Sequelize.DataTypes.DATE,
    }, { tableName: 'ConversationReads' });
    const WhatsAppWebOrigin = sql.define('WhatsAppWebOrigin', {
      id: { type: integer, primaryKey: true, autoIncrement: true }, used_conversation_id: integer,
    }, { tableName: 'WhatsAppWebOrigins' });
    await sql.sync();
    await sql.query('CREATE TABLE Clinicas(id_clinica INT PRIMARY KEY,grupoClinicaId INT)');
    await sql.query('INSERT INTO Clinicas VALUES(71,NULL),(72,NULL)');
    await sql.query('CREATE TABLE ClinicMetaAssets(id INT PRIMARY KEY,assignmentScope VARCHAR(20),clinicaId INT,grupoClinicaId INT,assetType VARCHAR(40),phoneNumberId VARCHAR(30),wabaId VARCHAR(30))');
    await sql.query("INSERT INTO ClinicMetaAssets VALUES(81,'clinic',71,NULL,'whatsapp_phone_number','201','101')");
    await sql.query('CREATE TABLE PatientDirectionSettings(clinic_id INT,director_phone_asset_id INT)');
    await sql.query('CREATE TABLE MetaScopeBlocks(scope_key VARCHAR(100) PRIMARY KEY)');
    for (const ddl of SCHEMA) await sql.query(ddl);
    const db = { Sequelize, sequelize: sql, Conversation, Message, ConversationRead, WhatsAppWebOrigin };
    const sandbox = { module: { exports: {} }, require: name => name === '../../models' ? db : name === './phone' ? phone : {}, process: { env: {} }, Date, Number, Map, Set };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(require.resolve('../../lib/canonical-conversation'), 'utf8'), sandbox);
    const merge = sandbox.module.exports.mergeDuplicateConversations;
    const first = await Conversation.create({ clinic_id: 71, channel: 'whatsapp', contact_id: '+34600000001', unread_count: 1 });
    const duplicate = await Conversation.create({ clinic_id: 71, channel: 'whatsapp', contact_id: '600000001', unread_count: 1 });
    const keys = [hash([71, '201', '34600000001']), hash([71, '202', '34600000001'])];
    for (const key of keys) await sql.query('INSERT INTO WhatsappInboxContactKeys VALUES(?,?,NOW(3))', { replacements: [key, duplicate.id] });
    const existing = await Message.create({ conversation_id: duplicate.id, direction: 'inbound', content: 'synthetic', metadata: {} });
    await sql.query('INSERT INTO WhatsappInboxMessageKeys VALUES(?,?,?,NOW(3))', { replacements: [hash(['old']), hash(['digest']), existing.id] });
    await ConversationRead.create({ conversation_id: duplicate.id, user_id: 7, last_read_at: new Date() });
    await WhatsAppWebOrigin.create({ used_conversation_id: duplicate.id });
    const destroy = Conversation.destroy;
    Conversation.destroy = async () => { throw Error('synthetic interrupted merge'); };
    await assert.rejects(merge(first, [duplicate]), /synthetic interrupted merge/);
    Conversation.destroy = destroy;
    assert.equal((await sql.query('SELECT DISTINCT conversation_id FROM WhatsappInboxContactKeys'))[0][0].conversation_id, duplicate.id);
    assert.equal((await Message.findByPk(existing.id)).conversation_id, duplicate.id);
    assert.ok(await Conversation.findByPk(duplicate.id));
    await merge(first, [duplicate]);
    assert.equal(await Conversation.findByPk(duplicate.id), null);
    assert.deepEqual((await sql.query('SELECT conversation_id FROM WhatsappInboxContactKeys'))[0].map(row => row.conversation_id), [first.id, first.id]);
    assert.equal((await Message.findByPk(existing.id)).conversation_id, first.id);
    assert.equal((await sql.query('SELECT message_id FROM WhatsappInboxMessageKeys'))[0][0].message_id, existing.id);
    assert.equal((await ConversationRead.findOne()).conversation_id, first.id);
    assert.equal((await WhatsAppWebOrigin.findOne()).used_conversation_id, first.id);
    for (const patch of [{ clinic_id: 72 }, { contact_id: '+213600000001' }, { patient_id: 99 }, { channel: 'email' }]) {
      await first.update({ patient_id: 5 });
      const other = await Conversation.create({ clinic_id: 71, channel: 'whatsapp', contact_id: first.contact_id, ...patch });
      await assert.rejects(merge(first, [other]), error => error.code === 'whatsapp_contact_identity_conflict');
      assert.ok(await Conversation.findByPk(other.id));
      await other.destroy();
    }
    report.checks.push('merge rollback', 'both sender bindings transferred', 'message dedup retained', 'reads and web origin retained', 'cross-clinic, country, owner and channel conflicts rejected');

    const rawConnection = await sql.connectionManager.getConnection();
    const connection = rawConnection.promise();
    const scope = { assetId: 81, wabaId: '101', phoneId: '201', clinicIds: [71] };
    const peer = '19995550101';
    const binding = hash([71, '201', peer]);
    const missingId = 9000;
    const options = { scope, clinicId: 71, peer, expectedContactKey: binding, expectedConversationId: missingId };
    const make = id => ({ receipt: randomUUID(), lease: randomUUID(), automaticActionsAllowed: false,
      recoveryWithoutAutomation: true, scopeBindings: [{ wabaId: '101', phoneId: '201', clinicIds: [71] }],
      raw: Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '101', changes: [{ field: 'messages', value: {
        messaging_product: 'whatsapp', metadata: { phone_number_id: '201' },
        messages: [{ id: 'wamid.' + id, from: peer, timestamp: '1790928000', type: 'text', text: { body: 'synthetic recovered answer' } }],
      } }] }] })) });
    try {
      await sql.query('INSERT INTO WhatsappInboxContactKeys VALUES(?,?,NOW(3))', { replacements: [binding, missingId] });
      await assert.rejects(importScopedLease(connection, make('held'), { version: 1, scopes: [scope] }), error => error.reviewDetail === 'contact_binding_mismatch');
      await assert.rejects(repairOrphanedContactBinding(connection, { ...options, peer: '19995550102' }), /identity_mismatch/);
      await assert.rejects(repairOrphanedContactBinding(connection, { ...options, clinicId: 72 }), /identity_mismatch/);
      await sql.query("INSERT INTO MetaScopeBlocks VALUES('clinic:71')");
      await assert.rejects(repairOrphanedContactBinding(connection, options), /review_required/);
      await sql.query('DELETE FROM MetaScopeBlocks');
      const otherClinic = await Conversation.create({ clinic_id: 72, channel: 'whatsapp', contact_id: peer });
      const repaired = await repairOrphanedContactBinding(connection, options);
      assert.equal(repaired.created, true);
      assert.notEqual(repaired.conversationId, otherClinic.id);
      assert.equal((await Conversation.findByPk(repaired.conversationId)).clinic_id, 71);
      await assert.rejects(repairOrphanedContactBinding(connection, options), /binding_changed/);
      const packet = make('recovered');
      const imported = await importScopedLease(connection, packet, { version: 1, scopes: [scope] });
      assert.equal((await importScopedLease(connection, packet, { version: 1, scopes: [scope] })).importReceipt, imported.importReceipt);
      const [messages] = await sql.query("SELECT * FROM Messages WHERE JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.wamid'))='wamid.recovered'");
      assert.equal(messages.length, 1);
      assert.equal(messages[0].metadata.recovery_without_automation, true);
      assert.equal(eligible(messages[0], { id: repaired.conversationId, clinic_id: 71, channel: 'whatsapp' },
        { clinicId: 71, phoneId: '201', wabaId: '101', sendEnabled: true }, '2026-09-01'), false);
      await sql.query('UPDATE WhatsappInboxContactKeys SET conversation_id=? WHERE contact_key=?', { replacements: [missingId, binding] });
      const same = await repairOrphanedContactBinding(connection, options);
      assert.equal(same.created, false); assert.equal(same.conversationId, repaired.conversationId);
      await sql.query('UPDATE WhatsappInboxContactKeys SET conversation_id=? WHERE contact_key=?', { replacements: [missingId, binding] });
      const ambiguous = await Conversation.create({ clinic_id: 71, channel: 'whatsapp', contact_id: '+' + peer });
      await assert.rejects(repairOrphanedContactBinding(connection, options), /ambiguous/);
      assert.equal((await sql.query('SELECT conversation_id FROM WhatsappInboxContactKeys WHERE contact_key=?', { replacements: [binding] }))[0][0].conversation_id, missingId);
      await ambiguous.destroy();
      await Conversation.create({ id: missingId, clinic_id: 72, channel: 'whatsapp', contact_id: peer });
      await assert.rejects(repairOrphanedContactBinding(connection, options), /not_orphaned/);
      report.checks.push('orphan native import held', 'identity and scope validation', 'blocked scope rollback', 'new chat only in same clinic', 'repair replay guarded', 'passive recovery deduplicated and ineligible for automation', 'unique existing destination reused', 'ambiguous or existing old target left untouched');
    } finally {
      await sql.connectionManager.releaseConnection(rawConnection);
    }
  });
});
