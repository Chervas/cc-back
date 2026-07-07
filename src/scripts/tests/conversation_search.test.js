'use strict';

require('dotenv').config();

const assert = require('node:assert/strict');
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

async function run() {
  assert.equal(__testing.normalizeSearchQuery('  Jose   Miguel  MOD  '), 'Jose Miguel MOD');
  assert.equal(__testing.normalizeTextSearchValue('Iñigo García'), 'inigo garcia');

  const clause = __testing.buildConversationSearchClause('Jose Miguel MOD');
  const literalSql = collectLiteralSql(clause).join('\n');

  assert.match(
    literalSql,
    /SELECT DISTINCT mpli\.conversation_id[\s\S]*WHERE mpli\.conversation_id IS NOT NULL/,
    'Linked marketing contacts must be searchable by conversation_id'
  );
  assert.doesNotMatch(
    literalSql,
    /mpli\.phone IS NULL OR mpli\.phone = ''/,
    'Linked marketing contacts must not require an empty phone to match by name'
  );
  assert.match(literalSql, /JSON_EXTRACT\(mpli\.custom_fields, '\$\.nombre'\)/);
  assert.match(literalSql, /JSON_EXTRACT\(mpli\.custom_fields, '\$\.apellidos'\)/);

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
