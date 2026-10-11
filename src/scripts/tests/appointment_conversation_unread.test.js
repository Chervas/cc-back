'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { appointmentConversationUnreadCounts } = require('../../lib/appointment-conversation-unread');

const timestamp = minute => new Date(`2030-01-07T10:${String(minute).padStart(2, '0')}:00.000Z`);
const inbound = (id, minute, patch = {}) => ({ id, conversation_id: 10, direction: 'inbound',
  message_type: 'text', metadata: {}, createdAt: timestamp(minute), ...patch });

function fixture() {
  const conversations = [
    { id: 10, clinic_id: 72, channel: 'whatsapp', patient_id: 1, contact_id: '600000001', last_inbound_at: timestamp(3) },
    { id: 11, clinic_id: 73, channel: 'whatsapp', patient_id: 1, contact_id: '600000001', last_inbound_at: timestamp(4) },
    { id: 12, clinic_id: 72, channel: 'email', patient_id: 1 },
    { id: 13, clinic_id: 72, channel: 'whatsapp', patient_id: 2, last_message_at: timestamp(59) },
  ];
  const reads = [{ conversation_id: 10, user_id: 7, last_read_at: timestamp(3) },
    { conversation_id: 10, user_id: 8, last_read_at: timestamp(1) }];
  const messages = [inbound(1, 1), inbound(2, 2), inbound(3, 3),
    inbound(4, 4, { conversation_id: 11 }), inbound(5, 4, { conversation_id: 12 }),
    inbound(6, 4, { conversation_id: 13 })];
  const queries = [];
  const db = { Sequelize: { QueryTypes: { SELECT: 'SELECT' } }, sequelize: { query: async (sql, options) => {
    queries.push({ sql, options });
    assert.match(sql, /^\s*SELECT\b/);
    assert.doesNotMatch(sql, /\b(?:UPDATE|INSERT|DELETE|last_outbound)\b/);
    assert.match(sql, /conversation_read\.user_id = :userId/);
    assert.match(sql, /base\.clinic_id IN \(:clinicIds\)/);
    assert.match(sql, /base\.channel = 'whatsapp'/);
    assert.match(sql, /inbound\.createdAt > conversation_read\.last_read_at/);
    assert.match(sql, /inbound\.message_type <> 'event'/);
    assert.match(sql, /\$\.qa_cleanup/);
    assert.match(sql, /\$\.hide_from_quickchat/);
    assert.equal(options.type, 'SELECT');
    // Exercise the production SQL predicate against owned, fictional records.
    // The strict SQL contract assertions above keep this fixture from accepting
    // the former pending-response query or an unscoped/shared unread counter.
    const p = options.replacements;
    return conversations.filter(c => p.conversationIds.includes(c.id) && p.clinicIds.includes(c.clinic_id)
      && c.channel === 'whatsapp').map(c => {
      const read = reads.find(r => r.conversation_id === c.id && r.user_id === p.userId);
      return { conversation_id: c.id, unread_count: messages.filter(m => m.conversation_id === c.id
        && m.direction === 'inbound' && m.message_type != null && m.message_type !== 'event'
        && String(m.metadata?.qa_cleanup) !== 'true' && String(m.metadata?.hide_from_quickchat) !== 'true'
        && (!read || +m.createdAt > +read.last_read_at)).length };
    });
  } } };
  const count = (userId, conversationIds = [10], clinicIds = [72]) => appointmentConversationUnreadCounts({
    db, userId, conversationIds, clinicIds });
  return { conversations, reads, messages, queries, db, count };
}

test('blue unread is personal: reading one user does not clear another, and a new inbound reappears', async () => {
  const f = fixture();
  assert.equal((await f.count(7)).get(10), 0, 'messages through the read timestamp are seen');
  assert.equal((await f.count(8)).get(10), 2, 'another user retains their own unread messages');
  assert.equal((await f.count(9)).get(10), 3, 'no personal receipt means inbound remains unread');
  f.messages.push(inbound(7, 4));
  assert.equal((await f.count(7)).get(10), 1, 'a later inbound is new even after opening the conversation');
  assert.equal(f.queries.length, 4);
});

test('outbound reply is not a read receipt and does not clear unread; only the personal receipt does', async () => {
  const f = fixture();
  const before = (await f.count(8)).get(10);
  f.messages.push(inbound(8, 5, { direction: 'outbound', status: 'sent' }));
  assert.equal((await f.count(8)).get(10), before);
  f.reads.find(r => r.user_id === 8).last_read_at = timestamp(5);
  assert.equal((await f.count(8)).get(10), 0);
  f.messages.push(inbound(9, 6));
  assert.equal((await f.count(8)).get(10), 1);
});

test('events, QA cleanup, hidden messages and outbound content do not produce blue dots', async () => {
  const f = fixture();
  f.messages.push(inbound(7, 4, { message_type: 'event' }),
    inbound(8, 4, { metadata: { qa_cleanup: true } }),
    inbound(9, 4, { metadata: { hide_from_quickchat: 'true' } }),
    inbound(10, 4, { direction: 'outbound' }), inbound(11, 4, { message_type: null }));
  assert.equal((await f.count(7)).get(10), 0);
  f.messages.push(inbound(12, 5, { metadata: { hide_from_quickchat: false } }));
  assert.equal((await f.count(7)).get(10), 1);
});

test('unread reads require a valid actor and explicit authorized clinic; invalid input makes no SQL call', async () => {
  const f = fixture();
  for (const userId of [undefined, null, 0, -1, 1.5, NaN, Infinity, 'invalid']) {
    assert.equal((await f.count(userId)).get(10), 0);
  }
  assert.equal((await f.count(8, [10], [])).get(10), 0);
  assert.equal((await f.count(8, [])).size, 0);
  assert.equal(f.queries.length, 0);
  assert.equal((await f.count('8', [10, '10', 0, 'invalid'], [72, '72', -1])).get(10), 2);
  assert.deepEqual(f.queries[0].options.replacements, { conversationIds: [10], clinicIds: [72], userId: 8 });
});

test('foreign-clinic and non-chat conversations cannot contribute unread even when IDs are supplied', async () => {
  const f = fixture();
  const counts = await f.count(9, [10, 11, 12], [72]);
  assert.equal(counts.get(10), 3);
  assert.equal(counts.get(11), 0);
  assert.equal(counts.get(12), 0);
  assert.equal((await f.count(9, [10], [73])).get(10), 0);
});

const controllerSource = fs.readFileSync(require.resolve('../../controllers/citas.controller'), 'utf8');
function controllerFunctions(f, access = async () => true) {
  const start = controllerSource.indexOf('async function attachUnreadCountsToCitas(');
  const end = controllerSource.indexOf('\nfunction isNutritionMeasurementEnabled(', start);
  assert.ok(start >= 0 && end > start);
  const canonicalCalls = [], conversationQueries = [], accessCalls = [];
  const Op = { in: Symbol('in'), or: Symbol('or'), and: Symbol('and'), ne: Symbol('ne') };
  const context = { db: f.db, Message: {}, Op, appointmentConversationUnreadCounts,
    canUserAccessFeature: async args => { accessCalls.push(args); return access(args); },
    Conversation: { findAll: async options => {
      conversationQueries.push(options);
      const clinicIds = options.where.clinic_id[Op.in];
      const matches = options.where[Op.and][0][Op.or];
      const categories = options.where[Op.and][1][Op.or];
      return f.conversations.filter(c => c.channel === options.where.channel && clinicIds.includes(c.clinic_id)
        && categories.some(category => category.clinic_id[Op.in].includes(c.clinic_id)
          && (category.patient_id === null ? c.patient_id == null : c.patient_id != null))
        && matches.some(match => (match.patient_id?.[Op.in] || []).includes(c.patient_id)
          || (match.lead_id?.[Op.in] || []).includes(c.lead_id)
          || (match.contact_id?.[Op.in] || []).includes(c.contact_id)));
    } },
    findCanonicalWhatsappConversation: async args => { canonicalCalls.push(args); throw Error('GET must not repair canonical contacts'); },
    getPhoneLookupCandidates: phone => phone ? [String(phone)] : [],
  };
  vm.createContext(context);
  vm.runInContext(controllerSource.slice(start, end), context);
  return { ...context, canonicalCalls, conversationQueries, accessCalls };
}

const appointment = (patientId, clinicId = 72, id = patientId) => ({ id_cita: id, clinica_id: clinicId,
  paciente_id: patientId, unread_count: 99, paciente: { telefono_movil: patientId === 1 ? '600000001' : '' } });

test('individual card reads forward the authenticated actor and its clinic without marking anything read', async () => {
  const f = fixture(), c = controllerFunctions(f);
  const seen = appointment(1);
  await c.attachUnreadCountsToCitas(seen, 7);
  assert.equal(seen.conversation_id, 10); assert.equal(seen.unread_count, 0);
  await c.attachUnreadCountsToCitas(seen, 8);
  assert.equal(seen.unread_count, 2);
  assert.equal(f.queries[0].options.replacements.userId, 7);
  assert.deepEqual(f.queries[0].options.replacements.clinicIds, [72]);
  assert.equal(c.canonicalCalls.length, 0, 'card GET never calls the contact-repair/merge resolver');
  const foreignFixture = fixture(); foreignFixture.conversations.shift();
  const foreign = controllerFunctions(foreignFixture), row = appointment(1);
  await foreign.attachUnreadCountsToCitas(row, 9);
  assert.equal(row.conversation_id, null);
  assert.equal(row.unread_count, 0, 'another clinic cannot provide a replacement patient chat');
  const nonChat = appointment(null);
  await c.attachUnreadCountsToCitas(nonChat, 8);
  assert.equal(nonChat.conversation_id, null); assert.equal(nonChat.unread_count, 0);
});

test('calendar batch selects exact clinic and actual identity, with no recency-only patient match', async () => {
  const f = fixture(), c = controllerFunctions(f);
  const rows = [appointment(1), appointment(1, 73, 101), appointment(2), appointment(3), appointment(null)];
  await c.attachCalendarUnreadCountsToCitas(rows, 8);
  assert.deepEqual(rows.map(r => [r.conversation_id, r.unread_count]), [[10, 2], [11, 1], [13, 1], [null, 0], [null, 0]]);
  assert.equal(f.queries.length, 1, 'the batch remains a single counter read');
  assert.equal(c.conversationQueries.length, 1);
  assert.equal(c.conversationQueries[0].where.channel, 'whatsapp');
  assert.equal(c.scoreCalendarConversation(f.conversations[3], rows[3], new Map()), 0);
  assert.equal(c.scoreCalendarConversation({ ...f.conversations[3], contact_id: '600000001' }, rows[0],
    new Map([[1, new Set(['600000001'])]])), 0, 'shared phone cannot override another patient owner');
  const allNonChat = [appointment(null), appointment(0)];
  await c.attachCalendarUnreadCountsToCitas(allNonChat, 8);
  assert.deepEqual(allNonChat.map(r => [r.conversation_id, r.unread_count]), [[null, 0], [null, 0]]);
  assert.equal(f.queries.length, 1, 'non-chat rows cause no unread query');
});

test('calendar and individual card counters agree for different readers and after a new inbound', async () => {
  const f = fixture(), c = controllerFunctions(f);
  for (const userId of [7, 8, 9]) {
    const one = appointment(1), batch = [appointment(1)];
    await c.attachUnreadCountsToCitas(one, userId);
    await c.attachCalendarUnreadCountsToCitas(batch, userId);
    assert.equal(one.unread_count, batch[0].unread_count);
  }
  f.messages.push(inbound(9, 5));
  const one = appointment(1), batch = [appointment(1)];
  await c.attachUnreadCountsToCitas(one, 7);
  await c.attachCalendarUnreadCountsToCitas(batch, 7);
  assert.equal(one.unread_count, 1); assert.equal(batch[0].unread_count, 1);
  assert.doesNotMatch(controllerSource.slice(controllerSource.indexOf('async function attachUnreadCountsToCitas('),
    controllerSource.indexOf('\nfunction isNutritionMeasurementEnabled(')), /\.upsert\(|\.update\(|\.create\(|findCanonicalWhatsappConversation\(/);
});

test('card lookup enforces inbox patient/lead category grants per clinic before reading conversations', async () => {
  const f = fixture(), denied = controllerFunctions(f, async () => false), row = appointment(1);
  await denied.attachUnreadCountsToCitas(row, 8);
  assert.equal(row.conversation_id, null); assert.equal(row.unread_count, 0);
  assert.equal(denied.conversationQueries.length, 0); assert.equal(f.queries.length, 0);
  assert.deepEqual(denied.accessCalls.map(a => [a.actorId, a.clinicId, a.featureKey]),
    [[8, 72, 'quickchat.read_patients'], [8, 72, 'quickchat.read_leads']]);

  f.conversations.push({ id: 14, clinic_id: 72, channel: 'whatsapp', patient_id: null, contact_id: '600000001' });
  f.messages.push(inbound(10, 4, { conversation_id: 14 }));
  const leadsOnly = controllerFunctions(f, async args => args.clinicId === 72 && args.featureKey === 'quickchat.read_leads');
  const linkedPhone = appointment(1), foreignClinic = appointment(1, 73);
  await leadsOnly.attachCalendarUnreadCountsToCitas([linkedPhone, foreignClinic], 8);
  assert.equal(linkedPhone.conversation_id, 14, 'an unowned contact requires the leads grant, not the patient grant');
  assert.equal(linkedPhone.unread_count, 1);
  assert.equal(foreignClinic.conversation_id, null); assert.equal(foreignClinic.unread_count, 0);
  assert.deepEqual(f.queries[0].options.replacements.conversationIds, [14]);
});
