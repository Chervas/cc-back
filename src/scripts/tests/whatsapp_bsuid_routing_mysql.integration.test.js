'use strict';
const IDENTITY_SCHEMA = require('../../../migrations/20261110210000-whatsapp-contact-identities').SCHEMA;
const test = require('node:test'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
process.env.WHATSAPP_CONTACT_IDENTITIES_ENABLED = 'true';
const I = require('../../lib/whatsapp-contact-identity'), scopes = require('../../lib/whatsappInboxScopes'), routing = require('../../lib/whatsappInboxRoutingReview'), importer = require('../../lib/whatsappInboxImport');
test('ambiguous BSUIDs reuse the authorized clinic-choice card and recovered messages do not replay clinical actions', async () => {
    await withIsolatedCampaignMysql(async ({ sql, report }) => {
        await sql.query('CREATE TABLE Clinicas(id_clinica INT PRIMARY KEY,grupoClinicaId INT,nombre_clinica VARCHAR(100))');
        await sql.query("INSERT INTO Clinicas VALUES(71,9,'FICTITIOUS A'),(72,9,'FICTITIOUS B')");
        await sql.query('CREATE TABLE ClinicMetaAssets(id INT PRIMARY KEY,assignmentScope VARCHAR(20),clinicaId INT,grupoClinicaId INT,assetType VARCHAR(40),phoneNumberId VARCHAR(30),wabaId VARCHAR(30),additionalData JSON)');
        await sql.query("INSERT INTO ClinicMetaAssets VALUES(83,'group',NULL,9,'whatsapp_phone_number','203','103',?)", { replacements: [JSON.stringify({ businessId: '301' })] });
        await sql.query('CREATE TABLE PatientDirectionSettings(clinic_id INT,director_phone_asset_id INT)');
        await sql.query('CREATE TABLE MetaScopeBlocks(scope_key VARCHAR(100) PRIMARY KEY)');
        await sql.query('CREATE TABLE Conversations(id INT PRIMARY KEY AUTO_INCREMENT,clinic_id INT,channel VARCHAR(20),contact_id VARCHAR(255),patient_id INT,lead_id INT,unread_count INT,last_message_at DATETIME(3),last_inbound_at DATETIME(3),createdAt DATETIME(3),updatedAt DATETIME(3))');
        await sql.query('CREATE TABLE Messages(id INT PRIMARY KEY AUTO_INCREMENT,conversation_id INT,direction VARCHAR(20),content TEXT,message_type VARCHAR(20),status VARCHAR(20),metadata JSON,sent_at DATETIME(3),createdAt DATETIME(3),updatedAt DATETIME(3))');
        for (const schema of [...importer.SCHEMA, ...IDENTITY_SCHEMA, ...routing.SCHEMA])
            await sql.query(schema);
        await sql.query("INSERT INTO Conversations(id,clinic_id,channel,contact_id,patient_id,unread_count) VALUES(100,71,'whatsapp','bsuid:301:ES.TestRouting',1,0),(200,72,'whatsapp','bsuid:301:ES.TestRouting',2,0)");
        const raw = await sql.connectionManager.getConnection(), c = raw.promise(), q = async (s, v = []) => (await c.execute(s, v))[0];
        const scope = { assetId: 83, phoneId: '203', wabaId: '103', clinicIds: [71, 72] }, config = { version: 1, scopes: [scope] };
        for (const [clinicId, conversationId] of [[71, 100], [72, 200]])
            await I.bind(q, { clinicId, conversationId, businessId: '301', type: 'bsuid', value: 'ES.TestRouting', wabaId: '103', phoneId: '203' });
        const make = (suffix, bsuid = 'ES.TestRouting') => ({ receipt: randomUUID(), lease: randomUUID(), receivedAt: Date.now(), automaticActionsAllowed: false, scopeBindings: [{ phoneId: '203', wabaId: '103', clinicIds: [71, 72] }], raw: Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '103', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: '203' }, contacts: [{ user_id: bsuid, profile: { name: 'Fictitious Contact', username: 'test_alias' } }], messages: [{ id: 'wamid.' + suffix, from_user_id: bsuid, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Fictitious response' } }] } }] }] })) });
        try {
            const first = make('bsuidFirst');
            await assert.rejects(scopes.importScopedLease(c, first, config, { routingReviewEnabled: true }), /review_required/);
            const pending = await routing.pending(c, [100], async () => true);
            assert.equal(pending.length, 1);
            assert.equal(pending[0].clinics.length, 2);
            assert.deepEqual(await routing.pending(c, [100], async (convo) => convo.clinic_id === 71), [], 'the other clinic cannot be disclosed');
            await assert.rejects(routing.resolve(c, { conversationId: 100, reviewId: pending[0].id, clinicId: 72, revision: pending[0].revision, userId: 44, scopes: config.scopes, authorize: async () => false }), /routing_review_forbidden/);
            await routing.resolve(c, { conversationId: 100, reviewId: pending[0].id, clinicId: 72, revision: pending[0].revision, userId: 44, scopes: config.scopes, authorize: async () => true });
            await scopes.importScopedLease(c, first, config, { routingReviewEnabled: true });
            await scopes.importScopedLease(c, first, config, { routingReviewEnabled: true });
            const rows = await q('SELECT conversation_id,metadata FROM Messages');
            assert.equal(rows.length, 1);
            assert.equal(rows[0].conversation_id, 200);
            assert.equal(rows[0].metadata.recovery_without_automation, true);
            assert.equal(rows[0].metadata.automatic_actions_allowed, false);
            await assert.rejects(scopes.importScopedLease(c, make('unknownBsuid', 'ES.UnknownFictitious'), config, { routingReviewEnabled: true }), /review_required/);
            assert.equal((await q('SELECT COUNT(*) n FROM Conversations'))[0].n, 2, 'no guessed clinic or patient is created');
            Object.assign(report, { scopedBsuidRouting: true, permissionChecks: true, duplicateImportPrevented: true, historicalActions: 0, sends: 0 });
        }
        finally {
            await sql.connectionManager.releaseConnection(raw);
        }
    });
});
