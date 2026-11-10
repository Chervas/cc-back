'use strict';
const db = require('../../models');
const I = require('../lib/whatsapp-contact-identity');
const caches = new WeakMap();
function queryFor(transaction = null, database = db) { return async (sql, values = []) => { const [result] = await database.sequelize.query(sql, { replacements: values, transaction }); return typeof result === 'number' ? { insertId: result } : result; }; }
async function enabled(transaction = null, database = db) {
    if (process.env.WHATSAPP_CONTACT_IDENTITIES_ENABLED !== 'true')
        return false;
    const cached = caches.get(database.sequelize);
    if (cached && cached.until > Date.now())
        return cached.value;
    const value = await I.available(queryFor(transaction, database));
    caches.set(database.sequelize, { value, until: Date.now() + 5000 });
    return value;
}
async function cluster(conversation, { transaction = null } = {}) {
    if (!conversation || conversation.channel !== 'whatsapp' || !await enabled(transaction))
        return { canonicalId: Number(conversation?.id), ids: [Number(conversation?.id)] };
    return I.members(queryFor(transaction), conversation.id, conversation.clinic_id);
}
async function canonical(conversation, options = {}) {
    const { canonicalId } = await cluster(conversation, options);
    if (canonicalId === Number(conversation.id))
        return conversation;
    const row = await db.Conversation.findByPk(canonicalId, { transaction: options.transaction });
    if (!row || row.channel !== 'whatsapp' || Number(row.clinic_id) !== Number(conversation.clinic_id)
        || conversation.patient_id && Number(row.patient_id) !== Number(conversation.patient_id))
        throw Error('whatsapp_identity_conflict');
    return row;
}
async function memberIds(conversation, options = {}) { return (await cluster(conversation, options)).ids; }
async function enrich(rows, { searchQuery = '' } = {}) {
    if (!rows.length || !await enabled())
        return rows;
    const ids = rows.map(r => Number(r.id)), marks = ids.map(() => '?').join(',');
    const q = queryFor();
    const links = await q(`SELECT conversation_id,canonical_id,clinic_id FROM WhatsappConversationLinks WHERE canonical_id IN (${marks})`, ids);
    const identities = await q(`SELECT i.*,COALESCE(l.canonical_id,i.conversation_id) canonical_id FROM WhatsappContactIdentities i LEFT JOIN WhatsappConversationLinks l ON l.conversation_id=i.conversation_id AND l.clinic_id=i.clinic_id WHERE COALESCE(l.canonical_id,i.conversation_id) IN (${marks}) ORDER BY i.updated_at DESC`, ids);
    return rows.map(row => {
        const own = identities.filter(i => Number(i.canonical_id) === Number(row.id) && Number(i.clinic_id) === Number(row.clinic_id));
        const bsuid = own.find(i => i.identity_type === 'bsuid');
        const current = I.phone(row.contact_id), opaque = I.parseContact(row.contact_id);
        const previous = own.filter(i => i.identity_type === 'phone' && i.identity_value !== current).map(i => i.identity_value);
        const digits = I.BSUID.test(searchQuery) ? null : String(searchQuery).replace(/[^0-9]/g, '');
        const bans = own.map(i => typeof i.restrictions === 'string' ? JSON.parse(i.restrictions) : i.restrictions || {});
        const channel = bans.some(r => r.channel), wrong = bans.some(r => r.wrong_recipient), marketing = bans.some(r => r.marketing), care = bans.some(r => r.care);
        const restrictions = row.contact_restrictions || {};
        return { ...row, ...(channel || wrong || marketing || care ? { contact_restrictions: { ...restrictions, active: true, whatsapp_channel_opt_out: channel || restrictions.whatsapp_channel_opt_out, whatsapp_number_invalid: wrong || restrictions.whatsapp_number_invalid, marketing_opt_out: marketing || restrictions.marketing_opt_out, care_communications_opt_out: care || restrictions.care_communications_opt_out, items: [...(restrictions.items || []), ...[channel ? 'whatsapp_channel' : wrong ? 'whatsapp_number' : marketing ? 'marketing' : 'care'].map(scope => ({ scope, source: 'whatsapp_identity', reason_text: 'Preferencia de comunicación registrada por WhatsApp' }))] } } : {}), whatsapp_identity: { phone: current, bsuid: bsuid?.identity_value || opaque?.bsuid || null,
                business_id: bsuid?.business_id || opaque?.businessId || null, conversation_ids: links.filter(l => Number(l.canonical_id) === Number(row.id) && Number(l.clinic_id) === Number(row.clinic_id)).map(l => Number(l.conversation_id)), display_name: bsuid?.display_name || null, username: bsuid?.username || null,
                previous_phones: [...new Set(previous)], matched_previous_phone: !!digits && previous.some(p => p === digits || digits.length === 9 && p.endsWith(digits)) } };
    });
}
async function searchClause(term, clinicIds) {
    if (!term || !await enabled())
        return null;
    const q = queryFor(), bsuid = I.BSUID.test(term), digits = bsuid ? null : String(term).replace(/[^0-9]/g, '');
    const phoneQuery = !!digits && /^[+0-9 ()-]+$/.test(term);
    let predicate, values;
    if (bsuid) {
        predicate = "i.identity_type='bsuid' AND i.identity_value=?";
        values = [term];
    }
    else if (phoneQuery) {
        predicate = "i.identity_type='phone' AND (i.identity_value=? OR (LENGTH(?)=9 AND RIGHT(i.identity_value,9)=?))";
        values = [digits, digits, digits];
    }
    else {
        predicate = '(i.username LIKE ? ESCAPE \'!\' OR i.display_name LIKE ? ESCAPE \'!\')';
        const like = '%' + term.replace(/[!%_]/g, c => '!' + c).replace(/^@/, '') + '%';
        values = [like, like];
    }
    const scope = clinicIds?.length ? ` AND i.clinic_id IN (${clinicIds.map(() => '?').join(',')})` : '';
    const rows = await q(`SELECT DISTINCT COALESCE(l.canonical_id,i.conversation_id) id FROM WhatsappContactIdentities i LEFT JOIN WhatsappConversationLinks l ON l.conversation_id=i.conversation_id AND l.clinic_id=i.clinic_id WHERE (${predicate})${scope} LIMIT 1000`, [...values, ...(clinicIds || [])]);
    return rows.map(r => Number(r.id));
}
async function recentMessages(conversations) {
    if (!conversations.length || !await enabled())
        return new Map();
    const ids = conversations.map(c => Number(c.id));
    const rows = await queryFor()(`SELECT * FROM (
    SELECT m.id,m.conversation_id,m.direction,m.content,m.message_type,m.status,m.sent_at,m.createdAt,m.metadata,
      l.canonical_id,ROW_NUMBER() OVER(PARTITION BY l.canonical_id ORDER BY COALESCE(m.sent_at,m.createdAt) DESC,m.id DESC) history_rank
    FROM WhatsappConversationLinks l JOIN Messages m ON m.conversation_id=l.conversation_id
    WHERE l.canonical_id IN (${ids.map(() => '?').join(',')})
  ) history WHERE history_rank<=6 ORDER BY canonical_id,history_rank`, ids);
    const result = new Map();
    for (const row of rows) {
        const { canonical_id, history_rank, ...message } = row;
        if (typeof message.metadata === 'string')
            message.metadata = JSON.parse(message.metadata);
        if (!result.has(Number(canonical_id)))
            result.set(Number(canonical_id), []);
        result.get(Number(canonical_id)).push(message);
    }
    return result;
}
async function reconcilePatientChange({ patientId, clinicId, previousPhone, nextPhone, actorId, transaction, database = db }) {
    if (!transaction)
        throw Error('whatsapp_identity_transaction_required');
    if (!await enabled(transaction, database))
        return { unified: false, reason: 'schema_unavailable' };
    const previous = require('../lib/phone').normalizePhoneE164(previousPhone), current = require('../lib/phone').normalizePhoneE164(nextPhone);
    if (previous === current)
        return { unified: false };
    const q = queryFor(transaction, database);
    await I.lockClinic(q, clinicId);
    const patient = await database.Paciente.findByPk(patientId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!patient || require('../lib/phone').normalizePhoneE164(patient.telefono_movil) !== current)
        throw Error('whatsapp_identity_patient_changed');
    const candidates = await database.Conversation.findAll({ where: { clinic_id: clinicId, channel: 'whatsapp', patient_id: patientId,
            ...(previous ? { contact_id: { [database.Sequelize.Op.in]: [previous, previous.slice(1)] } } : {}) }, transaction, lock: transaction.LOCK.UPDATE });
    const old = previous ? candidates : candidates.filter(c => I.parseContact(c.contact_id) || c.contact_id === null);
    if (!old.length)
        return { unified: false };
    const targets = await database.Conversation.findAll({ where: { clinic_id: clinicId, channel: 'whatsapp', ...(current ? { contact_id: { [database.Sequelize.Op.in]: [current, current.slice(1)] } } : { contact_id: null, patient_id: patientId }) }, transaction, lock: transaction.LOCK.UPDATE });
    if (targets.length > 1 || targets.some(c => Number(c.patient_id) !== Number(patientId)))
        return { unified: false, reason: 'identity_conflict' };
    const target = targets[0] || await database.Conversation.create({ clinic_id: clinicId, channel: 'whatsapp', contact_id: current, patient_id: patientId, unread_count: 0, last_message_at: old[0].last_message_at }, { transaction });
    const result = await I.unite(q, { ids: [...old.map(c => c.id), target.id], canonicalId: target.id, clinicId, source: 'patient_phone_edit', patientId, actorId });
    if (result.changed === false)
        return { unified: true, replayed: true, ...result };
    if (database.FlowExecutionV2) {
        const oldIds = result.ids.filter(id => id !== Number(target.id));
        if (oldIds.length) {
            const executions = await database.FlowExecutionV2.findAll({ where: { clinic_id: clinicId, status: { [database.Sequelize.Op.in]: ['running', 'waiting', 'paused'] } }, transaction, lock: transaction.LOCK.UPDATE });
            for (const execution of executions) {
                const context = execution.context || {};
                const endpoint = Number(context.conversation?.id || context.conversation_id || context.trigger?.data?.conversation_id);
                if (!oldIds.includes(endpoint) || context.conversation?.patient_id && Number(context.conversation.patient_id) !== Number(patientId))
                    continue;
                await execution.update({ status: 'cancelled', last_error: 'patient_phone_changed_review_required', wait_until: null,
                    context: { ...context, contact_identity_review: { reason: 'patient_phone_changed', actor_user_id: actorId || null, at: new Date().toISOString(), canonical_conversation_id: target.id } } }, { transaction });
                if (database.ConversationAutomationState)
                    await database.ConversationAutomationState.update({ stage: 'review', status: 'review', manual_action_required: true, needs_response: true, failure_code: 'patient_phone_changed_review_required', deadline_at: null }, { where: { clinic_id: clinicId, conversation_id: endpoint, execution_id: execution.id }, transaction });
            }
        }
    }
    // Patient-edit aliases have no provider portfolio. They cannot be used as a
    // BSUID proof or to send via another business; the internal scope is explicit.
    for (const value of [previous?.slice(1), current?.slice(1)].filter(Boolean))
        await I.bind(q, { clinicId, businessId: 'patient', type: 'phone', value, conversationId: value === current?.slice(1) ? target.id : old[0].id, source: 'patient_phone_edit' });
    return { unified: true, ...result };
}
async function aggregatePending(rows, getPending, userId) {
    if (!rows.length || !await enabled())
        return getPending(rows.map(c => Number(c.id)), { userId });
    const groups = await Promise.all(rows.map(c => cluster(c)));
    const all = [...new Set(groups.flatMap(g => g.ids))];
    const pending = await getPending(all, { userId });
    const result = new Map();
    rows.forEach((row, index) => {
        const states = groups[index].ids.map(id => pending.get(id)).filter(Boolean);
        let base = { ...pending.get(Number(row.id)) };
        base.count = states.reduce((n, s) => n + Number(s.count || 0), 0);
        base.unreadCount = states.reduce((n, s) => n + Number(s.unreadCount || 0), 0);
        base.requiresAutomationAttention = states.some(s => s.requiresAutomationAttention);
        base.automationAttentionCount = states.reduce((n, s) => n + Number(s.automationAttentionCount || 0), 0);
        const attention = states.find(s => s.requiresAutomationAttention);
        if (attention)
            base.automationAttentionMessageId = attention.automationAttentionMessageId;
        // Preserve a live analysis on its actual endpoint instead of inventing a
        // completed result for the presentation root.
        const processing = states.find(s => s.isAutomationResponseProcessing);
        if (processing) {
            for (const [k, v] of Object.entries(processing))
                if (k.startsWith('automation') || k === 'isAutomationResponseProcessing')
                    base[k] = v;
        }
        result.set(Number(row.id), base);
    });
    return result;
}
async function assertDestination(contact, clinicConfig, { commercial = false } = {}) {
    const identity = I.parseContact(contact);
    if (!identity)
        return null;
    const clinicId = Number(clinicConfig.clinicId || clinicConfig.clinicaId);
    if (!clinicId || !await enabled())
        throw Error('whatsapp_identity_scope_required');
    const q = queryFor();
    const businessId = await I.businessForScope(q, { phoneId: clinicConfig.phoneNumberId, wabaId: clinicConfig.wabaId });
    if (businessId !== identity.businessId)
        throw Error('whatsapp_identity_scope_changed');
    const found = await q("SELECT conversation_id,restrictions FROM WhatsappContactIdentities WHERE identity_key=?", [I.key(clinicId, businessId, 'bsuid', identity.bsuid)]);
    if (found.length !== 1)
        throw Error('whatsapp_identity_not_verified');
    const restrictions = typeof found[0].restrictions === 'string' ? JSON.parse(found[0].restrictions) : found[0].restrictions || {};
    if (restrictions.channel || restrictions.wrong_recipient || commercial && restrictions.marketing)
        throw Object.assign(Error('whatsapp_recipient_restricted'), { code: 'WHATSAPP_RECIPIENT_NUMBER_RESTRICTED', status: 409, retryable: false });
    // Unknown-phone contacts can receive service replies. Patient campaigns keep
    // their existing phone/patient eligibility instead of treating BSUID as a phone.
    if (commercial)
        throw Object.assign(Error('whatsapp_identity_marketing_review_required'), { code: 'WHATSAPP_IDENTITY_MARKETING_REVIEW_REQUIRED', status: 409, retryable: false });
    return { recipient: identity.bsuid, conversationId: Number(found[0].conversation_id) };
}
async function restrict({ conversation, inboundMessage, scope }) {
    const identity = I.parseContact(conversation?.contact_id);
    if (!identity || !await enabled())
        return { applied: false, reason: 'identity_unavailable' };
    if (!['marketing', 'care', 'all', 'wrong_recipient'].includes(scope))
        throw Error('whatsapp_identity_restriction_invalid');
    const field = scope === 'all' ? 'channel' : scope;
    const [rows] = await db.sequelize.query("UPDATE WhatsappContactIdentities SET restrictions=JSON_SET(COALESCE(restrictions,JSON_OBJECT()),?,CAST(? AS JSON)),updated_at=NOW(3) WHERE identity_key=?", { replacements: ['$.' + field, JSON.stringify({ message_id: Number(inboundMessage.id), at: new Date().toISOString() }), I.key(conversation.clinic_id, identity.businessId, 'bsuid', identity.bsuid)] });
    return { applied: true, scope, identity: 'bsuid' };
}
async function windowContext(conversation, { transaction = null } = {}) {
    const group = await cluster(conversation, { transaction });
    if (group.ids.length < 2)
        return { ids: [Number(conversation.id)], notBefore: null, allowLegacy: true };
    const links = await queryFor(transaction)('SELECT source,updated_at FROM WhatsappConversationLinks WHERE canonical_id=? AND clinic_id=?', [group.canonicalId, conversation.clinic_id]);
    const edited = links.filter(l => l.source === 'patient_phone_edit');
    return { ids: links.length && links.every(l => l.source === 'provider_phone' || l.source === 'duplicate_phone') ? group.ids : [Number(conversation.id)],
        notBefore: edited.length ? new Date(Math.max(...edited.map(l => +new Date(l.updated_at)))) : null, allowLegacy: false };
}
async function windowMemberIds(conversation, options) { return (await windowContext(conversation, options)).ids; }
async function assertPhoneEndpointCurrent(to, clinicConfig, { commercial = false } = {}) {
    if (!I.phone(to))
        return;
    const clinicId = Number(clinicConfig.clinicId || clinicConfig.clinicaId);
    if (!clinicId || !await enabled())
        return;
    const candidates = require('../lib/phone').getPhoneIdentityCandidates(to);
    if (!candidates.length)
        return;
    const rows = await queryFor()(`SELECT c.id,root.contact_id current_contact FROM Conversations c JOIN WhatsappConversationLinks l ON l.conversation_id=c.id AND l.clinic_id=c.clinic_id JOIN Conversations root ON root.id=l.canonical_id AND root.clinic_id=c.clinic_id WHERE c.clinic_id=? AND c.channel='whatsapp' AND c.contact_id IN (${candidates.map(() => '?').join(',')})`, [clinicId, ...candidates]);
    if (rows.some(r => require('../lib/phone').normalizePhoneE164(r.current_contact) !== require('../lib/phone').normalizePhoneE164(to)))
        throw Object.assign(Error('whatsapp_contact_identity_conflict'), { code: 'whatsapp_contact_identity_conflict', status: 409, retryable: false });
    const restrictions = await queryFor()(`SELECT i.restrictions FROM WhatsappContactIdentities i JOIN Conversations c ON c.id=i.conversation_id AND c.clinic_id=i.clinic_id WHERE i.clinic_id=? AND c.contact_id IN (${candidates.map(() => '?').join(',')}) AND i.restrictions IS NOT NULL`, [clinicId, ...candidates]);
    if (restrictions.some(row => { const r = typeof row.restrictions === 'string' ? JSON.parse(row.restrictions) : row.restrictions || {}; return r.channel || r.wrong_recipient || commercial && r.marketing; }))
        throw Object.assign(Error('whatsapp_recipient_restricted'), { code: 'WHATSAPP_RECIPIENT_NUMBER_RESTRICTED', status: 409, retryable: false });
}
async function reviewSupersededInbound({ message, conversation, transaction }) {
    const group = await cluster(conversation, { transaction });
    if (group.canonicalId === Number(conversation.id))
        return false;
    const q = queryFor(transaction);
    const links = await q('SELECT source FROM WhatsappConversationLinks WHERE conversation_id=? AND clinic_id=?', [conversation.id, conversation.clinic_id]);
    if (!links.some(l => l.source === 'patient_phone_edit'))
        return false;
    const metadata = { ...message.metadata, recovery_without_automation: true, automatic_actions_allowed: false,
        contact_identity_review: { reason: 'previous_contact', canonical_conversation_id: group.canonicalId, at: new Date().toISOString() } };
    delete metadata.fresh_realtime_status;
    await message.update({ metadata }, { transaction });
    await require('./conversationAutomationState.service').setState({ clinicId: conversation.clinic_id, conversationId: conversation.id,
        sourceMessageId: message.id, stage: 'review', status: 'review', manualActionRequired: true, needsResponse: true,
        appointmentId: null, appointmentStatus: null, intent: 'otra', failureCode: 'previous_contact_identity_review', deadlineAt: null }, { transaction });
    return true;
}
module.exports = { queryFor, enabled, cluster, canonical, memberIds, enrich, searchClause, recentMessages, reconcilePatientChange, aggregatePending, assertDestination, restrict, windowMemberIds, windowContext, assertPhoneEndpointCurrent, reviewSupersededInbound };
