'use strict';

const assert = require('node:assert/strict');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const migration = require('../../../migrations/20261127140000-enforce-inbound-claim-uniqueness');

withIsolatedCampaignMysql(async ({ sql, report }) => {
  const qi = sql.getQueryInterface();
  const table = 'AutomationInboundMessageClaims';
  await sql.query(`CREATE TABLE ${table} (id INT PRIMARY KEY AUTO_INCREMENT, claim_key VARCHAR(255) NOT NULL, message_id INT NOT NULL, INDEX(message_id))`);
  await sql.query(`INSERT INTO ${table} (claim_key,message_id) VALUES ('provider:a',1),('provider:a',2)`);
  await assert.rejects(() => migration.up(qi), error => error.original?.code === 'ER_DUP_ENTRY');
  const [retained] = await sql.query(`SELECT COUNT(*) n FROM ${table}`);
  assert.equal(retained[0].n, 2);
  await sql.query(`UPDATE ${table} SET claim_key='provider:b' WHERE message_id=2`);
  await qi.addIndex(table, ['message_id'], {unique:true,name:'fixture_existing_unique_message'});
  await migration.up(qi);
  await migration.up(qi);
  const unique = (await qi.showIndex(table)).filter(index => index.unique && !index.primary);
  assert.deepEqual(unique.map(index=>index.fields[0].attribute).sort(), ['claim_key','message_id']);
  for (const [key,msg] of [['provider:a',3],['provider:c',2]]) {
    await assert.rejects(() => sql.query(`INSERT INTO ${table} (claim_key,message_id) VALUES (?,?)`,
      {replacements:[key,msg]}), error => error.original?.code === 'ER_DUP_ENTRY');
  }
  report.indexes = { existingUniquePreserved:true, duplicateRowsPreserved:true, replay:true };
}).catch(e => { console.error(e); process.exitCode=1; });
