'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Sequelize, QueryTypes } = require('sequelize');
const { requestWhere } = require('../../lib/quickchat-image');
const requestId = 'a1234567-1234-4234-8234-123456789abc';
const options = { dialect: 'mysql', logging: false, pool: { max: 1, min: 0 } };
function lookup(sequelize, conversationId, identity = requestId) {
  return sequelize.getQueryInterface().queryGenerator.selectQuery('Messages', {
    tableAs: 'Message', where: requestWhere(sequelize, conversationId, identity), limit: 1,
  });
}
test('photo lookup preserves the MySQL JSON path and scopes the request to its conversation', async () => {
  const sequelize = new Sequelize('synthetic', 'synthetic', 'synthetic', options);
  try {
    const sql = lookup(sequelize, 71);
    assert(!sql.includes('$$'));
    assert(sql.includes('outbound_attachment_request_id'));
    assert(sql.includes('`Message`.`conversation_id` = 71'));
    assert(sql.includes(requestId));
  } finally { await sequelize.close(); }
});
test('the exact generated lookup works in isolated MySQL and the previous expression reproduces ER_INVALID_JSON_PATH', {
  skip: !process.env.QUICKCHAT_IMAGE_MYSQL_ENV_FILE,
}, async () => {
  const envFile = process.env.QUICKCHAT_IMAGE_MYSQL_ENV_FILE;
  assert.equal(envFile, '/etc/clinicaclick-dev/runtime.env');
  const env = require('dotenv').parse(require('node:fs').readFileSync(envFile));
  assert.equal(env.DB_NAME, 'clinicaclick_dev_isolated');
  assert.equal(env.DB_USERNAME, 'cc_dev_api');
  const config = require('../security-database-metadata').configuration(env);
  const sequelize = new Sequelize(env.DB_NAME, env.DB_USERNAME, env.DB_PASSWORD, {
    ...options, dialectOptions: { socketPath: config.socketPath },
  });
  try {
    const [identity] = await sequelize.query('SELECT DATABASE() AS db, CURRENT_USER() AS actor', { type: QueryTypes.SELECT });
    assert.equal(identity.db, 'clinicaclick_dev_isolated'); assert(identity.actor.startsWith('cc_dev_api@'));
    const escape = value => sequelize.getQueryInterface().queryGenerator.escape(value);
    const rows = [[77, 71, requestId], [78, 72, requestId], [79, 71, 'other'], [80, 71, null]].map(([id, conversation, key]) =>
      `SELECT ${id} AS id, ${conversation} AS conversation_id, ${key ? `CAST(${escape(JSON.stringify({ outbound_attachment_request_id: key }))} AS JSON)` : 'NULL'} AS metadata`);
    const inline = sql => sql.replace('`Messages` AS `Message`', `(${rows.join(' UNION ALL ')}) AS \`Message\``);
    await sequelize.transaction({ readOnly: true }, async transaction => {
      const select = sql => sequelize.query(inline(sql), { type: QueryTypes.SELECT, transaction });
      assert.deepEqual((await select(lookup(sequelize, 71))).map(r => r.id), [77]);
      assert.deepEqual((await select(lookup(sequelize, 72))).map(r => r.id), [78]);
      assert.deepEqual(await select(lookup(sequelize, 99)), []);
      assert.deepEqual(await select(lookup(sequelize, 71, 'not-present')), []);
      const old = sequelize.where(sequelize.fn('JSON_UNQUOTE', sequelize.fn('JSON_EXTRACT', sequelize.col('metadata'), '$.outbound_attachment_request_id')), requestId);
      const broken = sequelize.getQueryInterface().queryGenerator.selectQuery('Messages', { tableAs: 'Message', where: old });
      await assert.rejects(select(broken), error => error.original?.code === 'ER_INVALID_JSON_PATH');
    });
  } finally { await sequelize.close(); }
});
