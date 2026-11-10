'use strict';
// A conversation link is a presentation union. Transport rows, messages, reads,
// provider recipients, execution contexts and inbox bindings keep their IDs.
// This prevents a phone change from redirecting an old delivery or wait.
const { createHash } = require('node:crypto');
const BSUID = /^[A-Z]{2}\.[A-Za-z0-9]{1,128}$/;
const providerId = value => typeof value === 'string' && /^[1-9][0-9]{0,29}$/.test(value);
const phone = value => typeof value === 'string' && /^\+?[1-9][0-9]{6,14}$/.test(value) ? value.replace(/^\+/, '') : null;
const parseContact = value => {
    const match = typeof value === 'string' && /^bsuid:([1-9][0-9]{0,29}):([A-Z]{2}\.[A-Za-z0-9]{1,128})$/.exec(value);
    return match ? { businessId: match[1], bsuid: match[2] } : null;
};
const contactFor = (businessId, bsuid) => {
    if (!providerId(businessId) || !BSUID.test(bsuid || ''))
        throw Error('whatsapp_identity_scope_required');
    return `bsuid:${businessId}:${bsuid}`;
};
const key = (clinicId, businessId, type, value) => createHash('sha256').update(JSON.stringify([Number(clinicId), businessId, type, value])).digest('hex');
const cleanDisplay = v => typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 160) : null;
function providerIdentity(message, contacts, direction = 'inbound') {
    const bsuid = message?.[direction === 'inbound' ? 'from_user_id' : 'to_user_id'];
    const number = message?.[direction === 'inbound' ? 'from' : 'to'];
    if (!bsuid)
        return { phone: phone(number), bsuid: null };
    if (!BSUID.test(bsuid))
        throw Error('whatsapp_identity_invalid');
    const matches = (contacts || []).filter(c => c?.user_id === bsuid);
    const profile = matches[0] || {};
    if (matches.length > 1 || number && !phone(number) || profile.wa_id && !phone(profile.wa_id)
        || number && profile.wa_id && phone(number) !== phone(profile.wa_id)
        || phone(number) && (contacts || []).some(c => c.user_id && c.user_id !== bsuid && phone(c.wa_id) === phone(number)))
        throw Error('whatsapp_identity_conflict');
    // The signed message's own from_user_id/to_user_id is authoritative even
    // when Meta supplies no optional profile/contact card. Never borrow a name
    // or phone from a different contact in the same envelope.
    let ownPhone = phone(number) || phone(profile.wa_id);
    // A third-party vCard is not proof that this is the sender's phone.
    if (!ownPhone && message?.type === 'contacts' && message.contacts?.length === 1
        && message.contacts[0].origin === 'contact_request' && message.contacts[0].phones?.length === 1) {
        const shared = message.contacts[0].phones[0];
        if (phone(shared.wa_id) && (!shared.phone || phone(shared.phone) === phone(shared.wa_id)))
            ownPhone = phone(shared.wa_id);
    }
    return { phone: ownPhone, bsuid,
        displayName: cleanDisplay(profile.profile?.name), username: cleanDisplay(profile.profile?.username || profile.username), profileObserved: matches.length === 1 };
}
function assertUnion(rows, clinicId, { patientId = null, providerPhone = null } = {}) {
    if (!rows.length || rows.some(c => c.channel !== 'whatsapp' || Number(c.clinic_id) !== Number(clinicId)))
        throw Error('whatsapp_identity_conflict');
    const patients = new Set(rows.map(c => Number(c.patient_id)).filter(Boolean));
    if (patients.size > 1 || patientId && [...patients].some(id => id !== Number(patientId)))
        throw Error('whatsapp_identity_conflict');
    if (patientId && (!Number.isSafeInteger(Number(patientId)) || !patients.has(Number(patientId))) || !patientId && !phone(providerPhone))
        throw Error('whatsapp_identity_proof_required');
    // Never absorb an unowned lead into another person's clinical conversation.
    const leads = new Set(rows.map(c => Number(c.lead_id)).filter(Boolean));
    if (leads.size > 1 || rows.some(c => c.lead_id && !c.patient_id) && patients.size)
        throw Error('whatsapp_identity_conflict');
}
async function available(query) {
    const rows = await query("SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('WhatsappConversationLinks','WhatsappContactIdentities','WhatsappContactIdentityLocks')");
    return Number(rows[0]?.n) === 3;
}
async function lockClinic(query, clinicId) {
    // Own transaction, automatic release on rollback/disconnect. A dedicated row
    // avoids upgrading the reception registry's shared clinical/asset locks.
    await query('INSERT IGNORE INTO WhatsappContactIdentityLocks(clinic_id) VALUES(?)', [Number(clinicId)]);
    await query('SELECT clinic_id FROM WhatsappContactIdentityLocks WHERE clinic_id=? FOR UPDATE', [Number(clinicId)]);
}
async function members(query, conversationId, clinicId) {
    const links = await query('SELECT canonical_id FROM WhatsappConversationLinks WHERE conversation_id=? AND clinic_id=?', [Number(conversationId), Number(clinicId)]);
    if (!links.length)
        return { canonicalId: Number(conversationId), ids: [Number(conversationId)] };
    const rows = await query('SELECT conversation_id FROM WhatsappConversationLinks WHERE canonical_id=? AND clinic_id=? ORDER BY conversation_id', [links[0].canonical_id, Number(clinicId)]);
    return { canonicalId: Number(links[0].canonical_id), ids: rows.map(c => Number(c.conversation_id)) };
}
async function unite(query, { ids, canonicalId, clinicId, source, patientId, providerPhone, actorId }) {
    // Caller holds the clinic row and owns the transaction. Sorted locks avoid
    // two concurrent provider links or profile edits selecting different roots.
    await lockClinic(query, clinicId);
    const previousRoots = await Promise.all(ids.map(id => members(query, id, clinicId)));
    const alreadyLinked = previousRoots.every(r => r.canonicalId === Number(canonicalId));
    const expanded = new Set(ids.map(Number));
    for (const id of [...expanded])
        for (const member of (await members(query, id, clinicId)).ids)
            expanded.add(member);
    const list = [...expanded].sort((a, b) => a - b), marks = list.map(() => '?').join(',');
    const rows = await query(`SELECT id,clinic_id,channel,patient_id,lead_id,contact_id FROM Conversations WHERE id IN (${marks}) ORDER BY id FOR UPDATE`, list);
    if (rows.length !== list.length || !list.includes(Number(canonicalId)))
        throw Error('whatsapp_identity_conflict');
    assertUnion(rows, clinicId, { patientId, providerPhone });
    if (alreadyLinked)
        return { canonicalId: Number(canonicalId), ids: list, changed: false };
    const owner = rows.find(c => c.patient_id)?.patient_id || null;
    await query(`UPDATE Conversations SET last_message_at=(SELECT latest FROM (SELECT MAX(last_message_at) latest FROM Conversations WHERE id IN (${marks})) existing_history) WHERE id=?`, [...list, canonicalId]);
    if (source === 'provider_phone' && !alreadyLinked && rows.some(c => parseContact(c.contact_id))) {
        const detail = 'Sin teléfono → +' + providerPhone;
        await query("INSERT INTO Messages(conversation_id,direction,content,message_type,status,metadata,sent_at,createdAt,updatedAt) VALUES(?,'inbound',?,'event','sent',?,NOW(3),NOW(3),NOW(3))", [canonicalId, detail, JSON.stringify({ kind: 'patient_activity_event', activity_type: 'whatsapp_phone_added', title: 'Teléfono añadido', detail, icon: 'heroicons_outline:arrows-right-left', identity_source: 'provider_contact_request', automatic_actions_allowed: false })]);
    }
    if (owner)
        await query('UPDATE Conversations SET patient_id=COALESCE(patient_id,?) WHERE id=? AND clinic_id=?', [owner, canonicalId, clinicId]);
    for (const id of list)
        await query(`INSERT INTO WhatsappConversationLinks(conversation_id,canonical_id,clinic_id,source,actor_user_id,created_at,updated_at)
    VALUES(?,?,?,?,?,NOW(3),NOW(3)) ON DUPLICATE KEY UPDATE canonical_id=VALUES(canonical_id),source=IF(source='patient_phone_edit','patient_phone_edit',VALUES(source)),actor_user_id=VALUES(actor_user_id),updated_at=NOW(3)`, [id, canonicalId, clinicId, source, actorId || null]);
    return { canonicalId: Number(canonicalId), ids: list, changed: true };
}
async function bind(query, { clinicId, businessId, type, value, conversationId, wabaId, phoneId, displayName, username, source = 'provider', usernameObserved = false }) {
    if (!(providerId(businessId) || businessId === 'patient' && source === 'patient_phone_edit' && type === 'phone') || !Number.isSafeInteger(Number(clinicId)) || Number(clinicId) <= 0
        || !['phone', 'bsuid'].includes(type) || (type === 'phone' ? !phone(value) : !BSUID.test(value || '')))
        throw Error('whatsapp_identity_scope_required');
    const identityKey = key(clinicId, businessId, type, value);
    if (type === 'bsuid') {
        const other = await query("SELECT identity_key FROM WhatsappContactIdentities WHERE clinic_id=? AND business_id=? AND identity_type='bsuid' AND conversation_id=? AND identity_value<>? LIMIT 1 FOR UPDATE", [clinicId, businessId, conversationId, value]);
        if (other.length)
            throw Error('whatsapp_identity_generation_requires_review');
    }
    const existing = await query('SELECT conversation_id FROM WhatsappContactIdentities WHERE identity_key=? FOR UPDATE', [identityKey]);
    if (existing.length && Number(existing[0].conversation_id) !== Number(conversationId)) {
        const a = await members(query, existing[0].conversation_id, clinicId), b = await members(query, conversationId, clinicId);
        if (a.canonicalId !== b.canonicalId)
            throw Error('whatsapp_identity_conflict');
    }
    await query(`INSERT INTO WhatsappContactIdentities(identity_key,clinic_id,business_id,identity_type,identity_value,conversation_id,waba_id,phone_id,display_name,username,source,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,NOW(3),NOW(3)) ON DUPLICATE KEY UPDATE conversation_id=VALUES(conversation_id),display_name=COALESCE(VALUES(display_name),display_name),username=IF(?,VALUES(username),username),waba_id=VALUES(waba_id),phone_id=VALUES(phone_id),updated_at=NOW(3)`, [identityKey, clinicId, businessId, type, value, conversationId, wabaId || null, phoneId || null, cleanDisplay(displayName), cleanDisplay(username), source, usernameObserved === true ? 1 : 0]);
}
async function businessForScope(query, scope) {
    const rows = await query(`SELECT JSON_UNQUOTE(JSON_EXTRACT(additionalData,'$.businessId')) business_id,
    JSON_UNQUOTE(JSON_EXTRACT(additionalData,'$.businessPortfolioId')) portfolio_id,
    JSON_UNQUOTE(JSON_EXTRACT(additionalData,'$.whatsappBusinessHealth.business_id')) health_id
    FROM ClinicMetaAssets WHERE assetType='whatsapp_phone_number' AND phoneNumberId=? AND wabaId=?`, [scope.phoneId, scope.wabaId]);
    const values = [...new Set(rows.flatMap(r => [r.business_id, r.portfolio_id, r.health_id]).filter(providerId))];
    if (values.length !== 1)
        throw Error('whatsapp_identity_scope_required');
    return values[0];
}
async function resolveInbound(query, scope, identity) {
    if (!await available(query))
        throw Error('whatsapp_identity_schema_required');
    const businessId = await businessForScope(query, scope);
    await lockClinic(query, scope.clinicId);
    const found = await query('SELECT conversation_id FROM WhatsappContactIdentities WHERE identity_key=? FOR UPDATE', [key(scope.clinicId, businessId, 'bsuid', identity.bsuid)]);
    let id = found[0]?.conversation_id;
    let createdHere = false;
    const contact = identity.phone || contactFor(businessId, identity.bsuid);
    const exact = await query("SELECT id,patient_id,lead_id FROM Conversations WHERE clinic_id=? AND channel='whatsapp' AND contact_id IN (?,?) ORDER BY id FOR UPDATE", [scope.clinicId, contact, '+' + contact]);
    if (exact.length > 1)
        throw Error('whatsapp_identity_conflict');
    if (identity.phone && exact[0]?.patient_id) {
        const patient = await query('SELECT telefono_movil FROM Pacientes WHERE id_paciente=?', [exact[0].patient_id]);
        if (patient.length !== 1 || require('./phone').normalizePhoneE164(patient[0].telefono_movil) !== ('+' + identity.phone))
            throw Error('whatsapp_identity_patient_phone_requires_review');
    }
    if (!id)
        id = exact[0]?.id;
    if (!id) {
        const row = await query("INSERT INTO Conversations(clinic_id,channel,contact_id,unread_count,createdAt,updatedAt) VALUES(?,'whatsapp',?,0,NOW(3),NOW(3))", [scope.clinicId, contact]);
        id = row.insertId;
        createdHere = true;
    }
    if (identity.phone) {
        let destination = exact[0]?.id || (createdHere ? id : null);
        if (!destination) {
            const row = await query("INSERT INTO Conversations(clinic_id,channel,contact_id,unread_count,createdAt,updatedAt) VALUES(?,'whatsapp',?,0,NOW(3),NOW(3))", [scope.clinicId, identity.phone]);
            destination = row.insertId;
        }
        if (Number(id) !== Number(destination))
            await unite(query, { ids: [id, destination], canonicalId: destination, clinicId: scope.clinicId, source: 'provider_phone', providerPhone: identity.phone });
        await bind(query, { clinicId: scope.clinicId, businessId, type: 'phone', value: identity.phone, conversationId: destination, wabaId: scope.wabaId, phoneId: scope.phoneId });
        id = destination;
    }
    await bind(query, { clinicId: scope.clinicId, businessId, type: 'bsuid', value: identity.bsuid, conversationId: id, wabaId: scope.wabaId, phoneId: scope.phoneId, displayName: identity.displayName, username: identity.username, usernameObserved: identity.profileObserved === true });
    return { id: Number(id), businessId };
}
module.exports = { BSUID, providerId, phone, parseContact, contactFor, providerIdentity, key, assertUnion, available, lockClinic, members, unite, bind, businessForScope, resolveInbound };
