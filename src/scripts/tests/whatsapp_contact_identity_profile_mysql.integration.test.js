'use strict';
const IDENTITY_SCHEMA = require('../../../migrations/20261110210000-whatsapp-contact-identities').SCHEMA;
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
process.env.WHATSAPP_CONTACT_IDENTITIES_ENABLED = 'true';
const I = require('../../lib/whatsapp-contact-identity'), Importer = require('../../lib/whatsappInboxImport');
test('patient edits atomically unite presentation, retain reads and stop only the old endpoint execution', async () => {
    await withIsolatedCampaignMysql(async ({ sql, models, report }) => {
        const S = require('sequelize'), T = S.DataTypes;
        models.Sequelize = S;
        models.Paciente = sql.define('Paciente', { id_paciente: { type: T.INTEGER, primaryKey: true }, telefono_movil: T.STRING }, { tableName: 'Pacientes', timestamps: false });
        models.Conversation = sql.define('Conversation', { id: { type: T.INTEGER, autoIncrement: true, primaryKey: true }, clinic_id: T.INTEGER, channel: T.STRING, contact_id: T.STRING, patient_id: T.INTEGER, lead_id: T.INTEGER, unread_count: T.INTEGER, last_message_at: T.DATE, last_inbound_at: T.DATE }, { tableName: 'Conversations' });
        models.PatientOperationalEvent = sql.define('PatientOperationalEvent', { patient_id: T.INTEGER, clinic_id: T.INTEGER, actor_user_id: T.INTEGER, event_type: T.STRING, source: T.STRING, channel: T.STRING, occurred_at: T.DATE, metadata: T.JSON }, { tableName: 'PatientOperationalEvents', timestamps: false });
        models.FlowExecutionV2 = sql.define('FlowExecutionV2', { clinic_id: T.INTEGER, status: T.STRING, context: T.JSON, last_error: T.STRING, wait_until: T.DATE }, { tableName: 'FlowExecutionsV2', timestamps: false });
        models.ConversationAutomationState = sql.define('ConversationAutomationState', { clinic_id: T.INTEGER, conversation_id: { type: T.INTEGER, unique: true }, source_message_id: T.INTEGER, execution_id: T.INTEGER, stage: T.STRING, status: T.STRING, manual_action_required: T.BOOLEAN, needs_response: T.BOOLEAN, failure_code: T.STRING, deadline_at: T.DATE, appointment_id: T.INTEGER, appointment_status: T.STRING, intent: T.STRING, possible_urgency: T.BOOLEAN }, { tableName: 'ConversationAutomationStates', timestamps: false });
        await sql.sync();
        await sql.query('CREATE TABLE Clinicas(id_clinica INT PRIMARY KEY)');
        await sql.query('INSERT INTO Clinicas VALUES(71),(72)');
        await sql.query('CREATE TABLE Messages(id INT PRIMARY KEY,conversation_id INT,content TEXT,status VARCHAR(20),metadata JSON)');
        await sql.query('CREATE TABLE ConversationReads(conversation_id INT,user_id INT,last_read_at DATETIME(3),PRIMARY KEY(conversation_id,user_id))');
        for (const schema of IDENTITY_SCHEMA)
            await sql.query(schema);
        await models.Paciente.create({ id_paciente: 1, telefono_movil: '+19995550101' });
        const old = await models.Conversation.create({ clinic_id: 71, channel: 'whatsapp', contact_id: '+19995550101', patient_id: 1, unread_count: 2, last_inbound_at: new Date(), last_message_at: new Date() });
        const other = await models.Conversation.create({ clinic_id: 72, channel: 'whatsapp', contact_id: '+19995550101', patient_id: 1, unread_count: 0 });
        await sql.query('INSERT INTO Messages VALUES(1,?,\'Fictitious message\',\'delivered\',?)', { replacements: [old.id, JSON.stringify({ wamid: 'wamid.FICTITIOUS', to: '+19995550101' })] });
        await sql.query("INSERT INTO ConversationReads VALUES(?,44,'2026-11-10 09:00:00')", { replacements: [old.id] });
        const execution = await models.FlowExecutionV2.create({ clinic_id: 71, status: 'waiting', context: { conversation: { id: old.id, patient_id: 1 }, appointment: { id_cita: 99 } }, wait_until: new Date(Date.now() + 3600000) });
        const unrelated = await models.FlowExecutionV2.create({ clinic_id: 72, status: 'waiting', context: { conversation: { id: other.id, patient_id: 1 } } });
        await models.ConversationAutomationState.create({ clinic_id: 71, conversation_id: old.id, execution_id: execution.id, stage: 'waiting', status: 'active' });
        const record = require('../../services/patientWhatsappContactChange.service').record, service = require('../../services/whatsappContactIdentity.service');
        let emitted = 0;
        await sql.transaction(async (transaction) => {
            await models.Paciente.update({ telefono_movil: '+19995550102' }, { where: { id_paciente: 1 }, transaction });
            await record({ db: models, patientId: 1, clinicId: 71, previousPhone: '+19995550101', nextPhone: '+19995550102', actorId: 44, transaction, emit: () => emitted++ });
        });
        assert.equal(emitted, 1);
        const destination = await models.Conversation.findOne({ where: { clinic_id: 71, contact_id: '+19995550102' } });
        assert(destination);
        assert.equal((await service.canonical(old)).id, destination.id);
        assert.deepEqual(await service.memberIds(destination), [old.id, destination.id]);
        assert.deepEqual(await service.windowMemberIds(destination), [destination.id], 'the old phone cannot open the new phone window');
        const firstWindow = await service.windowContext(destination);
        assert(firstWindow.notBefore instanceof Date);
        assert.equal(firstWindow.allowLegacy, false);
        await sql.transaction(async (transaction) => {
            const replay = await service.reconcilePatientChange({ patientId: 1, clinicId: 71, previousPhone: '+19995550101', nextPhone: '+19995550102', actorId: 44, transaction, database: models });
            assert.equal(replay.replayed, true);
        });
        assert.equal(+(await service.windowContext(destination)).notBefore, +firstWindow.notBefore, 'a repeated edit cannot move the service window cutoff');
        assert.equal((await models.FlowExecutionV2.findByPk(execution.id)).status, 'cancelled');
        assert.equal((await models.FlowExecutionV2.findByPk(unrelated.id)).status, 'waiting');
        assert.equal((await models.ConversationAutomationState.findOne()).stage, 'review');
        assert.equal((await sql.query('SELECT conversation_id FROM Messages WHERE id=1'))[0][0].conversation_id, old.id);
        assert.equal((await sql.query('SELECT COUNT(*) n FROM ConversationReads'))[0][0].n, 1);
        const enriched = (await service.enrich([destination.toJSON()], { searchQuery: '19995550101' }))[0];
        assert.equal(enriched.whatsapp_identity.phone, '19995550102');
        assert.equal(enriched.whatsapp_identity.matched_previous_phone, true);
        assert.deepEqual(await service.searchClause('19995550101', [71]), [destination.id]);
        assert.deepEqual(await service.searchClause('19995550101', [72]), [], 'another clinic is never disclosed through aliases');
        const joined=await service.aggregatePending([destination],async()=>new Map([
          [old.id,{automationProcessingStatus:'review',automationManualActionRequired:true,automationNeedsResponse:true,automationResponseProcessingMessageId:1,requiresAutomationAttention:true,automationAttentionCount:2,automationAttentionMessageId:1}],
          [destination.id,{automationProcessingStatus:null,automationManualActionRequired:false,requiresAutomationAttention:true,automationAttentionCount:3,automationAttentionMessageId:2}]
        ]),44);
        assert.equal(joined.get(destination.id).automationProcessingStatus,'review');
        assert.equal(joined.get(destination.id).automationManualActionRequired,true,'the old endpoint review survives the visible union');
        assert.equal(joined.get(destination.id).automationAttentionCount,5,'the chosen review cannot overwrite the combined attention count');
        const late = { id: 1, metadata: { fresh_realtime_status: 'received' }, async update(patch, { transaction }) { await sql.query('UPDATE Messages SET metadata=? WHERE id=?', { replacements: [JSON.stringify(patch.metadata), this.id], transaction }); Object.assign(this, patch); } };
        await sql.transaction(async (transaction) => assert.equal(await service.reviewSupersededInbound({ message: late, conversation: old, transaction }), true));
        assert.equal(late.metadata.automatic_actions_allowed, false);
        assert.equal(late.metadata.recovery_without_automation, true);
        assert.equal(late.metadata.fresh_realtime_status, undefined);
        const review = await models.ConversationAutomationState.findOne();
        assert.equal(review.failure_code, 'previous_contact_identity_review');
        assert.equal(review.source_message_id, 1);
        assert.equal(review.manual_action_required, true);
        assert.equal(await service.reviewSupersededInbound({ message: late, conversation: destination }), false, 'the current endpoint is unaffected');
        await sql.transaction(async transaction=>{
          await I.bind(service.queryFor(transaction),{clinicId:71,businessId:'301',type:'bsuid',value:'ES.RestrictedProfile',conversationId:old.id,wabaId:'101',phoneId:'201'});
        });
        await service.restrict({conversation:{clinic_id:71,contact_id:'bsuid:301:ES.RestrictedProfile'},inboundMessage:{id:1},scope:'all'});
        await assert.rejects(service.assertPhoneEndpointCurrent('+19995550102',{clinicId:71}),e=>e.code==='WHATSAPP_RECIPIENT_NUMBER_RESTRICTED','a phone change never drops the identity channel refusal');
        // A failed edit rolls back its profile, new endpoint, event and presentation.
        await assert.rejects(sql.transaction(async (transaction) => {
            await models.Paciente.update({ telefono_movil: '+19995550103' }, { where: { id_paciente: 1 }, transaction });
            await record({ db: models, patientId: 1, clinicId: 71, previousPhone: '+19995550102', nextPhone: '+19995550103', actorId: 44, transaction, emit: () => emitted++ });
            throw Error('fictitious_rollback');
        }), /fictitious_rollback/);
        assert.equal((await models.Paciente.findByPk(1)).telefono_movil, '+19995550102');
        assert.equal(await models.Conversation.count({ where: { contact_id: '+19995550103' } }), 0);
        assert.equal(emitted, 1);
        // A→B→A reuses the immutable original endpoint and all links, not a new chat.
        await sql.transaction(async (transaction) => { await models.Paciente.update({ telefono_movil: '+19995550101' }, { where: { id_paciente: 1 }, transaction }); await record({ db: models, patientId: 1, clinicId: 71, previousPhone: '+19995550102', nextPhone: '+19995550101', actorId: 44, transaction, emit: () => emitted++ }); });
        assert.equal((await service.canonical(destination)).id, old.id);
        assert.equal(await models.Conversation.count(), 3);
        assert.equal(await models.PatientOperationalEvent.count(), 2);
        // Deleting the phone leaves one history but cannot fall back to the old number.
        await sql.transaction(async (transaction) => { await models.Paciente.update({ telefono_movil: null }, { where: { id_paciente: 1 }, transaction }); await record({ db: models, patientId: 1, clinicId: 71, previousPhone: '+19995550101', nextPhone: null, actorId: 44, transaction, emit: () => emitted++ }); });
        const withoutPhone = await service.canonical(old);
        assert.equal(withoutPhone.contact_id, null);
        assert.equal((await service.enrich([withoutPhone.toJSON()]))[0].whatsapp_identity.phone, null);
        // A clinic-owned BSUID conversation can acquire its first phone through an
        // accepted patient edit, without matching another patient's alias or name.
        await models.Paciente.create({ id_paciente: 2, telefono_movil: null });
        const opaque = await models.Conversation.create({ clinic_id: 71, channel: 'whatsapp', contact_id: 'bsuid:301:ES.ProfileOnly', patient_id: 2 });
        await sql.transaction(async (transaction) => {
            await models.Paciente.update({ telefono_movil: '+19995550104' }, { where: { id_paciente: 2 }, transaction });
            await record({ db: models, patientId: 2, clinicId: 71, previousPhone: null, nextPhone: '+19995550104', actorId: 44, transaction, emit: () => emitted++ });
        });
        const firstPhone = await service.canonical(opaque);
        assert.equal(firstPhone.contact_id, '+19995550104');
        assert.equal(firstPhone.patient_id, 2);
        assert.deepEqual(await service.memberIds(firstPhone), [opaque.id, firstPhone.id]);
        Object.assign(report, { atomicEdits: true, rollbackVerified: true, oldProviderRecipientPreserved: true, otherClinicUntouched: true, sends: 0 });
    });
});
