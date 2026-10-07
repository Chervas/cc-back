'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { Op, Sequelize } = require('sequelize');
const {
  isTemporaryQuickChatFocusUser, temporaryQuickChatListSql,
  attachTemporaryQuickChatEligibility,
} = require('../../lib/temporary-quickchat-focus');

const graci = { userId: 44, email: 'maria.gonzalez@modmarketing.net' };

test('the temporary account filter does not become a role/admin-wide policy', () => {
  assert.equal(isTemporaryQuickChatFocusUser(graci), true);
  assert.equal(isTemporaryQuickChatFocusUser({ ...graci, email: ' Maria.Gonzalez@Modmarketing.net ' }), true);
  for (const actor of [null, {}, { ...graci, userId: 1 }, { userId: 44, email: 'another@example.invalid' }]) {
    assert.equal(isTemporaryQuickChatFocusUser(actor), false);
    assert.equal(temporaryQuickChatListSql(actor), null);
  }
});

test('habitual search/pagination matches creator AND patient AND clinic; explicit contact reads are exempt', () => {
  const sql = temporaryQuickChatListSql(graci);
  assert.match(sql, /`created_by` = 44/);
  assert.match(sql, /`clinica_id` = `Conversation`\.`clinic_id`/);
  assert.match(sql, /`paciente_id` = `Conversation`\.`patient_id`/);
  assert.match(sql, /`patient_id` IS NULL/);
  assert.match(sql, /`channel` = 'internal'/);
  assert.match(sql, /NOT IN \(66,72,77\)/);
  assert.match(sql, /temporary_patient_direction_handoff/);
  assert.match(sql, /patient\.created/);
  assert.doesNotMatch(sql, /ADMIN_USER_IDS/);
  assert.equal(temporaryQuickChatListSql(graci, { patientId: 123 }), null);
  assert.equal(temporaryQuickChatListSql(graci, { leadId: 456 }), null);
  assert.equal(temporaryQuickChatListSql(graci, { q: 'other patient', offset: 50 }), sql);
  const sequelize = new Sequelize('test', 'test', 'test', { dialect: 'mysql', logging: false });
  const query = sequelize.getQueryInterface().queryGenerator.selectQuery('Conversations', {
    tableAs: 'Conversation', where: { [Op.and]: [sequelize.literal(sql)] }, limit: 51, offset: 50,
  });
  assert.match(query, /FROM `Conversations` AS `Conversation` WHERE/);
  assert(query.indexOf('EXISTS') < query.indexOf('LIMIT'), 'filter must precede pagination');
});

test('contextual chats are annotated in one batched lookup without restricting their reads', async () => {
  const conversations = [
    { id: 1, clinic_id: 72, patient_id: 10, channel: 'whatsapp' },
    { id: 2, clinic_id: 73, patient_id: 10, channel: 'whatsapp' },
    { id: 3, clinic_id: 72, patient_id: 11, channel: 'whatsapp' },
    { id: 4, clinic_id: 72, patient_id: null, lead_id: 20, channel: 'whatsapp' },
    { id: 5, clinic_id: 72, patient_id: 12, channel: 'internal' },
    { id: 6, clinic_id: 72, patient_id: 10, channel: 'instagram' },
  ];
  let calls = 0;
  const model = { sequelize: { async query(query, options) {
    calls++;
    assert.match(query, /temporary_patient_direction_handoff/);
    assert.deepEqual(options.replacements.ids, [1, 3, 4, 6]);
    return [[{ id: 1, eligible: 1 }, { id: 3, eligible: 0 }, { id: 4, eligible: 1 }, { id: 6, eligible: 1 }]];
  } } };
  const payload = await attachTemporaryQuickChatEligibility(conversations, graci, model);
  assert.equal(calls, 1);
  assert.deepEqual(payload.map(c => c.quickchat_list_eligible), [true, true, false, true, true, true]);
  assert.equal(payload.length, conversations.length, 'contextual access must not be filtered out');
  assert.equal(conversations[0].quickchat_list_eligible, undefined, 'do not mutate shared/socket payloads');
  assert.strictEqual(await attachTemporaryQuickChatEligibility(conversations, { userId: 1 }, model), conversations);
  await attachTemporaryQuickChatEligibility([conversations[1]], graci, model);
  assert.equal(calls, 1, 'other clinics need no attention lookup');
});

test('controller applies the filter before querying, and keeps the existing access checks', () => {
  const source = fs.readFileSync(require.resolve('../../controllers/conversation.controller'), 'utf8');
  const list = source.slice(source.indexOf('exports.listConversations ='), source.indexOf('exports.getPermissions ='));
  assert(list.indexOf('temporaryQuickChatListSql') < list.indexOf('Conversation.findAll'));
  assert.match(list, /getAllowedQuickChatClinicIdsByCategory/);
  assert.match(list, /where\[Op\.and\]\.push\(db\.sequelize\.literal\(temporaryFocusSql\)\)/);
  assert.match(list, /attachTemporaryQuickChatEligibility\(withRouting, req\.userData, CitaPaciente\)/);
  for (const name of ['getMessages', 'getConversationByPatient', 'getConversationByLead']) {
    const start = source.indexOf(`exports.${name} =`);
    const end = source.indexOf('\nexports.', start + 1);
    const endpoint = source.slice(start, end);
    assert.match(endpoint, /ensureQuickChatConversationReadAccess/);
    assert.match(endpoint, /attachTemporaryQuickChatEligibility/);
    assert.doesNotMatch(endpoint, /temporaryQuickChatListSql/);
  }
});
