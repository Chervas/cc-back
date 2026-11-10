'use strict';
const IDENTITY_SCHEMA = require('../../../migrations/20261110210000-whatsapp-contact-identities').SCHEMA;
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
process.env.WHATSAPP_CONTACT_IDENTITIES_ENABLED = 'true';
const I = require('../../lib/whatsapp-contact-identity'), Importer = require('../../lib/whatsappInboxImport');
test('scoped provider identities and linked histories preserve endpoints, ownership and idempotency', async () => {
    await withIsolatedCampaignMysql(async ({ sql, report }) => {
        await sql.query('CREATE TABLE Clinicas(id_clinica INT PRIMARY KEY)');
        await sql.query('INSERT INTO Clinicas VALUES(71),(72)');
        await sql.query("CREATE TABLE Conversations(id INT PRIMARY KEY AUTO_INCREMENT,clinic_id INT NOT NULL,channel VARCHAR(20),contact_id VARCHAR(255),patient_id INT NULL,lead_id INT NULL,unread_count INT,last_message_at DATETIME(3),last_inbound_at DATETIME(3),createdAt DATETIME(3),updatedAt DATETIME(3))");
        await sql.query("CREATE TABLE Messages(id INT PRIMARY KEY AUTO_INCREMENT,conversation_id INT,direction VARCHAR(20),content TEXT,message_type VARCHAR(20),status VARCHAR(20),metadata JSON,sent_at DATETIME(3),createdAt DATETIME(3),updatedAt DATETIME(3))");
        await sql.query('CREATE TABLE ClinicMetaAssets(id INT PRIMARY KEY,assetType VARCHAR(40),phoneNumberId VARCHAR(30),wabaId VARCHAR(30),additionalData JSON)');
        await sql.query("INSERT INTO ClinicMetaAssets VALUES(1,'whatsapp_phone_number','201','101',?), (2,'whatsapp_phone_number','202','102',?)", { replacements: [JSON.stringify({ businessId: '301' }), JSON.stringify({ businessId: '302' })] });
        for (const schema of [...Importer.SCHEMA, ...IDENTITY_SCHEMA])
            await sql.query(schema);
        const raw = await sql.connectionManager.getConnection();
        const c = raw.promise();
        const q = async (s, v = []) => (await c.execute(s, v))[0];
        const scope = { clinicId: 71, wabaId: '101', phoneId: '201' };
        const m = (id, bsuid = 'ES.testPerson', number) => ({ id: 'wamid.' + id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Fictitious message' }, from_user_id: bsuid, ...(number ? { from: number } : {}) });
        const lease = (message, contact = {}, field = 'messages') => ({ receipt: randomUUID(), lease: randomUUID(), automaticActionsAllowed: false, raw: Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '101', changes: [{ field, value: { messaging_product: 'whatsapp', metadata: { phone_number_id: '201' }, contacts: [{ user_id: message.from_user_id || message.to_user_id, profile: { name: 'Test person', username: 'test_alias' }, ...contact }], ...(field === 'messages' ? { messages: [message] } : { message_echoes: [message] }) } }] }] })) });
        try {
            const first = lease(m('first'));
            await Importer.importLease(c, first, scope);
            await Importer.importLease(c, first, scope);
            let conversations = await q('SELECT * FROM Conversations');
            assert.equal(conversations.length, 1);
            const originalId = conversations[0].id;
            assert.equal(conversations[0].contact_id, 'bsuid:301:ES.testPerson');
            assert.equal((await q('SELECT COUNT(*) n FROM Messages'))[0].n, 1);
            await Importer.importLease(c, lease(m('second')), scope);
            assert.equal((await q('SELECT COUNT(*) n FROM Conversations'))[0].n, 1);
            const both = lease(m('both', 'ES.testPerson', '19995550101'), { wa_id: '19995550101' });
            await Importer.importLease(c, both, scope);
            conversations = await q('SELECT * FROM Conversations');
            assert.equal(conversations.length, 2);
            const destination = conversations.find(c => c.contact_id === '19995550101');
            assert.equal((await I.members(q, originalId, 71)).canonicalId, destination.id);
            assert.deepEqual((await I.members(q, originalId, 71)).ids, [originalId, destination.id]);
            assert.equal((await q('SELECT conversation_id FROM Messages WHERE id=1'))[0].conversation_id, originalId, 'old message endpoint is immutable');
            assert.equal((await q("SELECT COUNT(*) n FROM Messages WHERE JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.activity_type'))='whatsapp_phone_added'"))[0].n, 1);
            await Importer.importLease(c, lease(m('bothAgain', 'ES.testPerson', '19995550101'), { wa_id: '19995550101' }), scope);
            assert.equal((await q("SELECT COUNT(*) n FROM Messages WHERE JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.activity_type'))='whatsapp_phone_added'"))[0].n, 1, 'no duplicate phone-added card');
            await Importer.importLease(c, lease(m('hiddenAgain')), scope);
            assert.equal((await q('SELECT COUNT(*) n FROM Conversations'))[0].n, 2);
            // Same alias or same literal BSUID in another portfolio does not unify.
            const otherScope = { clinicId: 72, wabaId: '102', phoneId: '202' };
            const other = lease(m('other'));
            let body = JSON.parse(other.raw);
            body.entry[0].id = '102';
            body.entry[0].changes[0].value.metadata.phone_number_id = '202';
            other.raw = Buffer.from(JSON.stringify(body));
            await Importer.importLease(c, other, otherScope);
            const otherRow = (await q('SELECT * FROM Conversations WHERE clinic_id=72'))[0];
            assert.equal(otherRow.contact_id, 'bsuid:302:ES.testPerson');
            assert.equal((await I.members(q, otherRow.id, 72)).ids.length, 1);
            await assert.rejects(Importer.importLease(c, lease(m('mismatch', 'ES.testPerson', '19995550102'), { wa_id: '19995550103' }), scope), /review_required/);
            // A shared vCard is never accepted as the sender's phone.
            const thirdParty = { ...m('cardOther', 'ES.anotherPerson'), type: 'contacts', contacts: [{ origin: 'other', phones: [{ phone: '19995550101', wa_id: '19995550101' }] }] };
            await Importer.importLease(c, lease(thirdParty), scope);
            const third = (await q("SELECT * FROM Conversations WHERE contact_id='bsuid:301:ES.anotherPerson'"))[0];
            assert(third);
            assert.equal(third.patient_id, null);
            // Contact-request origin is provider evidence, unlike a typed number or vCard.
            const own = { ...m('ownCard', 'ES.anotherPerson'), type: 'contacts', contacts: [{ origin: 'contact_request', phones: [{ phone: '19995550104', wa_id: '19995550104' }] }] };
            await Importer.importLease(c, lease(own), scope);
            const ownRow = (await q("SELECT * FROM Conversations WHERE contact_id='19995550104'"))[0];
            assert.equal((await I.members(q, third.id, 71)).canonicalId, ownRow.id);
            // Mobile echoes without a phone are still outbound, never an inbound response.
            const echo = { ...m('echo', 'ES.echoPerson'), to_user_id: 'ES.echoPerson' };
            delete echo.from_user_id;
            await Importer.importLease(c, lease(echo, {}, 'smb_message_echoes'), scope);
            assert.equal((await q("SELECT direction FROM Messages WHERE JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.wamid'))='wamid.echo'"))[0].direction, 'outbound');
            // A status from the exact original phone/WAMID learns BSUID before the
            // user's number becomes private; the next inbound reuses that same endpoint.
            const sent = { id: 'wamid.statusLearn', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Fictitious clinic reply' }, to: '19995550105' };
            const outgoing = lease({ ...sent, to_user_id: 'ES.statusPerson' }, { wa_id: '19995550105' }, 'smb_message_echoes');
            // Existing phone-only send: do not learn until the provider status arrives.
            let outBody = JSON.parse(outgoing.raw);
            delete outBody.entry[0].changes[0].value.message_echoes[0].to_user_id;
            outBody.entry[0].changes[0].value.contacts = [];
            outgoing.raw = Buffer.from(JSON.stringify(outBody));
            await Importer.importLease(c, outgoing, scope);
            const status = { ...outgoing, receipt: randomUUID(), lease: randomUUID() };
            outBody.entry[0].changes[0].field = 'messages';
            delete outBody.entry[0].changes[0].value.message_echoes;
            outBody.entry[0].changes[0].value.statuses = [{ id: 'wamid.statusLearn', status: 'delivered', timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: '19995550105', recipient_user_id: 'ES.statusPerson' }];
            status.raw = Buffer.from(JSON.stringify(outBody));
            await Importer.importLease(c, status, scope);
            await Importer.importLease(c, lease(m('privateAfterStatus', 'ES.statusPerson')), scope);
            assert.equal((await q("SELECT conversation_id FROM Messages WHERE JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.wamid'))='wamid.privateAfterStatus'"))[0].conversation_id, (await q("SELECT id FROM Conversations WHERE contact_id='19995550105'"))[0].id);
            // Retrying identical media with a different provider clock does not repeat
            // reception, unread counts or IA, even after the original was dispatched.
            const video = { ...m('videoRetry', 'ES.testPerson', '19995550101'), type: 'video', video: { id: '1001', mime_type: 'video/mp4', sha256: 'synthetic_hash' } };
            await Importer.importLease(c, lease(video, { wa_id: '19995550101' }), scope);
            const before = (await q("SELECT * FROM Messages WHERE JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.wamid'))='wamid.videoRetry'"))[0];
            await q("UPDATE Messages SET metadata=JSON_SET(metadata,'$.fresh_inbound_dispatched_at','2026-11-10T10:00:00Z') WHERE id=?", [before.id]);
            await Importer.importLease(c, lease({ ...video, timestamp: String(Number(video.timestamp) + 1) }, { wa_id: '19995550101' }), scope);
            const after = await q("SELECT * FROM Messages WHERE JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.wamid'))='wamid.videoRetry'");
            assert.equal(after.length, 1);
            assert.equal(+new Date(after[0].sent_at), +new Date(before.sent_at));
            await assert.rejects(Importer.importLease(c, lease({ ...video, video: { ...video.video, id: '1002' } }, { wa_id: '19995550101' }), scope), /review_required/);
            const renewed = { ...video, id: 'wamid.videoRenewal', video: { ...video.video, sha256: 'a'.repeat(64) } };
            await Importer.importLease(c, lease(renewed, { wa_id: '19995550101' }), scope);
            const priorRenewal=await q("SELECT * FROM Messages WHERE JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.wamid'))='wamid.videoRenewal'");
            const priorClock=await q('SELECT unread_count,last_inbound_at,last_message_at FROM Conversations WHERE id=?',[priorRenewal[0].conversation_id]);
            await Importer.importLease(c, lease({ ...renewed, timestamp: String(Number(renewed.timestamp)+3), video: { ...renewed.video, id:'1002' } }, { wa_id: '19995550101' }), scope);
            assert.deepEqual(await q("SELECT * FROM Messages WHERE JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.wamid'))='wamid.videoRenewal'"),priorRenewal,'renewed file ID preserves the original transport row and metadata');
            assert.deepEqual(await q('SELECT unread_count,last_inbound_at,last_message_at FROM Conversations WHERE id=?',[priorRenewal[0].conversation_id]),priorClock,'renewed file ID never reopens a window or repeats unread');
            await assert.rejects(Importer.importLease(c, lease({ ...renewed, video: { ...renewed.video, id:'1002',sha256:'b'.repeat(64) } }, { wa_id: '19995550101' }), scope), /review_required/);
            await assert.rejects(Importer.importLease(c, lease({ ...renewed, video: { ...renewed.video, id:'1002',mime_type:'video/other' } }, { wa_id: '19995550101' }), scope), /review_required/);
            await q("UPDATE ClinicMetaAssets SET additionalData=JSON_OBJECT() WHERE id=1");
            await Importer.importLease(c, lease(m('legacyUnscoped', 'ES.unlearnedPerson', '19995550106'), { wa_id: '19995550106' }), scope);
            assert.equal((await q("SELECT COUNT(*) n FROM WhatsappContactIdentities WHERE identity_value='ES.unlearnedPerson'"))[0].n, 0);
            await assert.rejects(Importer.importLease(c, lease(m('unscopedOpaque', 'ES.unlearnedPerson')), scope), /review_required/);
            await q("UPDATE ClinicMetaAssets SET additionalData=? WHERE id=1", [JSON.stringify({ businessId: '301' })]);
            await q("INSERT INTO ClinicMetaAssets VALUES(3,'whatsapp_phone_number','203','101',?)", [JSON.stringify({ businessId: '301' })]);
            const secondRaw = await sql.connectionManager.getConnection();
            try {
                const a = lease(m('parallelA', 'ES.parallelPerson')), b = lease(m('parallelB', 'ES.parallelPerson'));
                const packet = JSON.parse(b.raw);
                packet.entry[0].changes[0].value.metadata.phone_number_id = '203';
                b.raw = Buffer.from(JSON.stringify(packet));
                await Promise.all([Importer.importLease(c, a, scope), Importer.importLease(secondRaw.promise(), b, { ...scope, phoneId: '203' })]);
                assert.equal((await q("SELECT COUNT(*) n FROM Conversations WHERE contact_id='bsuid:301:ES.parallelPerson'"))[0].n, 1);
                assert.equal((await q("SELECT COUNT(*) n FROM Messages WHERE JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.wamid')) IN ('wamid.parallelA','wamid.parallelB')"))[0].n, 2);
            }
            finally {
                await sql.connectionManager.releaseConnection(secondRaw);
            }
            // A conflict between patients rolls back the complete union.
            await q('UPDATE Conversations SET patient_id=1 WHERE id=?', [destination.id]);
            await q('UPDATE Conversations SET patient_id=2 WHERE id=?', [ownRow.id]);
            await c.beginTransaction();
            await assert.rejects(I.unite(q, { ids: [destination.id, ownRow.id], canonicalId: ownRow.id, clinicId: 71, source: 'patient_phone_edit', patientId: 1 }), /identity_conflict/);
            await c.rollback();
            assert.equal((await I.members(q, destination.id, 71)).canonicalId, destination.id);
            // Unions cannot cross clinical boundaries, even with a matching number/name.
            await c.beginTransaction();
            await assert.rejects(I.unite(q, { ids: [destination.id, otherRow.id], canonicalId: destination.id, clinicId: 71, source: 'patient_phone_edit', patientId: 1 }), /identity_conflict/);
            await c.rollback();
            assert.equal((await q("SELECT COUNT(*) n FROM Messages WHERE JSON_EXTRACT(metadata,'$.automatic_actions_allowed')=CAST('true' AS JSON)"))[0].n, 0);
            await q("INSERT INTO Messages(conversation_id,direction,content,message_type,status,metadata,sent_at,createdAt,updatedAt) VALUES(?,'inbound','Fictitious latest alias preview','text','sent',JSON_OBJECT(),DATE_ADD(NOW(3),INTERVAL 1 SECOND),NOW(3),NOW(3))", [originalId]);
            const previews = await require('../../services/whatsappContactIdentity.service').recentMessages([{ id: destination.id }]);
            assert.equal(previews.get(destination.id)[0].content, 'Fictitious latest alias preview');
            assert.equal(previews.get(destination.id)[0].conversation_id, originalId, 'the list preview uses the shared history without rewriting its endpoint');
            // The real inbox account has table grants, unlike the fixture owner.
            // MySQL FOR UPDATE needs UPDATE even on the dedicated lock table.
            await q("CREATE USER 'identity_qa'@'localhost' IDENTIFIED BY 'FictitiousOnly_Identity1'");
            for(const table of ['Clinicas','ClinicMetaAssets'])await q("GRANT SELECT ON campaign_optimization_qa."+table+" TO 'identity_qa'@'localhost'");
            for(const table of ['Conversations','Messages','WhatsappContactIdentities','WhatsappConversationLinks'])await q("GRANT SELECT,INSERT,UPDATE ON campaign_optimization_qa."+table+" TO 'identity_qa'@'localhost'");
            for(const table of ['WhatsappInboxImports','WhatsappInboxContactKeys','WhatsappInboxMessageKeys','WhatsappContactIdentityLocks'])await q("GRANT SELECT,INSERT ON campaign_optimization_qa."+table+" TO 'identity_qa'@'localhost'");
            const limited=await require('mysql2/promise').createConnection({socketPath:sql.options.dialectOptions.socketPath,user:'identity_qa',password:'FictitiousOnly_Identity1',database:'campaign_optimization_qa'});
            try {
              await assert.rejects(limited.query('SELECT 1 FROM WhatsappContactIdentityLocks LIMIT 0 FOR UPDATE'),e=>e.code==='ER_TABLEACCESS_DENIED_ERROR');
              await q("GRANT UPDATE ON campaign_optimization_qa.WhatsappContactIdentityLocks TO 'identity_qa'@'localhost'");
              await limited.query('SELECT 1 FROM WhatsappContactIdentityLocks LIMIT 0 FOR UPDATE');
              const privilegedReceipt=lease(m('scopedPrivilege','ES.ScopedPrivilege'));
              await Importer.importLease(limited,privilegedReceipt,scope);
              assert.equal((await q("SELECT COUNT(*) n FROM Conversations WHERE contact_id='bsuid:301:ES.ScopedPrivilege'"))[0].n,1);
            }finally{await limited.end();}
            const snap = await require('../../lib/securitySchemaContract').snapshot(async (s) => (await sql.query(s))[0]);
            const baseline = require('../../../ops/security/schema-contract.json');
            const tables = Object.fromEntries(['WhatsappContactIdentities', 'WhatsappConversationLinks', 'WhatsappContactIdentityLocks'].map(name => [name, baseline.tables[name]]));
            assert(Object.values(tables).every(Boolean));
            assert.equal(require('../../lib/securitySchemaContract').compare(snap, { defaults: snap.defaults, tables, migrations: [] }).compatible, true);
            const evidence = process.env.WHATSAPP_IDENTITY_SCHEMA_EVIDENCE;
            if (evidence) {
                assert(evidence.startsWith('/home/ubuntu/secure-imports/'));
                fs.writeFileSync(evidence, JSON.stringify(snap), { mode: 0o600 });
            }
            Object.assign(report, { identityCases: 19, patientRowsCreated: 0, sends: 0, automationActions: 0, scopedBsuid: true, presentationUnionPreservesTransport: true });
        }
        finally {
            await sql.connectionManager.releaseConnection(raw);
        }
    });
});
