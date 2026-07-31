'use strict';

require('dotenv').config();

const assert = require('node:assert/strict');
const { Op } = require('sequelize');
const db = require('../../../models');
const { __testing } = require('../../controllers/conversation.controller');

function collectLiteralSql(value, out = []) {
  if (!value || typeof value !== 'object') return out;
  if (value.constructor?.name === 'Literal' && typeof value.val === 'string') {
    out.push(value.val);
    return out;
  }

  for (const key of Reflect.ownKeys(value)) {
    const child = value[key];
    if (Array.isArray(child)) {
      child.forEach((item) => collectLiteralSql(item, out));
    } else {
      collectLiteralSql(child, out);
    }
  }
  return out;
}

function collectStringValues(value, out = []) {
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (!value || typeof value !== 'object') return out;
  for (const key of Reflect.ownKeys(value)) {
    const child = value[key];
    if (Array.isArray(child)) {
      child.forEach((item) => collectStringValues(item, out));
    } else {
      collectStringValues(child, out);
    }
  }
  return out;
}

async function run() {
  assert.equal(__testing.normalizeSearchQuery('  Jose   Miguel  MOD  '), 'Jose Miguel MOD');
  assert.equal(__testing.normalizeTextSearchValue('Iñigo García'), 'inigo garcia');
  assert.ok(
    __testing.buildPhoneSearchCandidates('654695552').includes('+34654695552'),
    'Spanish local mobile searches must include the E.164 candidate used by WhatsApp conversations'
  );

  const clause = await __testing.buildConversationSearchClause('Jose Miguel MOD');
  assert.ok(
    collectStringValues(clause).includes('jose%'),
    'Conversation name searches must preserve prefix matching for every name token'
  );

  const numericNameClause = await __testing.buildConversationSearchClause('test 3');
  assert.ok(
    collectStringValues(numericNameClause).includes('3%'),
    'Numeric name tokens must not be discarded, otherwise "test 3" matches every "test" conversation'
  );

  const phoneClause = await __testing.buildConversationSearchClause('654695552');
  const phoneLiteralSql = collectLiteralSql(phoneClause).join('\n');
  assert.match(phoneLiteralSql, /\+34654695552/);
  assert.match(phoneLiteralSql, /mpli\.phone IN/);
  assert.doesNotMatch(
    phoneLiteralSql,
    /mpli\.phone[\s\S]*LIKE/,
    'Phone-only QuickChat searches must not scan MarketingPatientListItems with LIKE'
  );
  assert.doesNotMatch(
    phoneLiteralSql,
    /JSON_EXTRACT\(mpli\.custom_fields/,
    'Phone-only QuickChat searches must avoid the broad marketing custom_fields fallback'
  );

  assert.equal(
    __testing.getQuickChatConversationCategory({ channel: 'internal', patient_id: 123, contact_id: 'team' }),
    'team'
  );
  assert.equal(
    __testing.getQuickChatConversationCategory({ channel: 'whatsapp', patient_id: 123 }),
    'patients'
  );
  assert.equal(
    __testing.getQuickChatConversationCategory({ channel: 'whatsapp', lead_id: 456 }),
    'leads'
  );
  assert.equal(
    __testing.getQuickChatConversationCategory({ channel: 'whatsapp', contact_id: '+34600111222' }),
    'leads'
  );

  const categoryWhere = __testing.buildQuickChatCategoryWhere({
    patients: [1, 2],
    team: [3],
    leads: [],
  });
  assert.equal(categoryWhere[Op.or].length, 2);
  assert.deepEqual(categoryWhere[Op.or][0][Op.and][0].clinic_id[Op.in], [1, 2]);
  assert.equal(categoryWhere[Op.or][0][Op.and][2].patient_id[Op.not], null);
  assert.equal(categoryWhere[Op.or][1][Op.and][0].clinic_id, 3);
  assert.equal(categoryWhere[Op.or][1][Op.and][1].channel, 'internal');
  assert.equal(__testing.buildQuickChatCategoryWhere({ patients: [], team: [], leads: [] }), null);

  const replacements = {};
  const categorySql = __testing.buildQuickChatCategorySql({ patients: [1], team: [], leads: [2] }, replacements);
  assert.match(categorySql, /c\.patient_id IS NOT NULL/);
  assert.match(categorySql, /c\.patient_id IS NULL/);
  assert.deepEqual(replacements.quickchatReadPatientsClinicIds, [1]);
  assert.deepEqual(replacements.quickchatReadLeadsClinicIds, [2]);

  console.log('conversation_search.test.js OK');
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.sequelize.close();
    process.exit(process.exitCode || 0);
  });
