'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { ownedMysqlTestEntry } = require('./fixtures/owned_mysql_test_entry.fixture');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const enabled = ownedMysqlTestEntry(process.env, { allowSkip: true });

test('email progress counts only the scoped audience, with separate confirmed delivery and incident counts', { skip: !enabled }, async () => {
  await withIsolatedCampaignMysql(async ({ sql, report }) => {
    const { getEmailDispatchProgress } = require('../../services/marketingEmailDispatch.service');
    await sql.query(`CREATE TABLE MarketingPatientListItems (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, list_id BIGINT NOT NULL,
      selected BOOLEAN NOT NULL, status VARCHAR(40) NOT NULL,
      email VARCHAR(100), channel_status JSON, INDEX (list_id)
    )`);
    const date = '2026-11-19T20:30:00.000Z';
    const fixtures = [
      { status: 'sent' },
      { status: 'delivered' },
      { status: 'bounced', sent_at: date },
      { status: 'complained', sent_at: date, delivered_at: date },
      { status: 'queued', sent_at: null },
      { status: 'sending', delivered_at: null },
      { status: 'suppressed' },
      { status: 'failed' },
      null,
    ];
    async function insert(emailState, { listId = 5, selected = true, status = 'ready', email = 'fictitious@example.test' } = {}) {
      await sql.query(`INSERT INTO MarketingPatientListItems(list_id, selected, status, email, channel_status)
        VALUES (:listId, :selected, :status, :email, :channels)`, {
        replacements: { listId, selected, status, email, channels: JSON.stringify({ email: emailState, whatsapp: { status: 'sent' } }) },
      });
    }
    for (const state of fixtures) await insert(state);
    await insert({ status: 'sent' }, { listId: 6 });
    await insert({ status: 'sent' }, { selected: false });
    await insert({ status: 'sent' }, { status: 'excluded' });
    await insert({ status: 'sent' }, { email: null });

    const email_dispatch = { status: 'waiting_next_batch', next_allowed_at: date };
    assert.deepEqual(await getEmailDispatchProgress({ id: 5, email_dispatch }), {
      ...email_dispatch, channel: 'email', total_to_send: 9, sent: 4, delivered: 2, failed: 4, progress_percent: 44,
    });
    assert.deepEqual(await getEmailDispatchProgress({ id: 7, email_dispatch }), {
      ...email_dispatch, channel: 'email', total_to_send: 0, sent: 0, delivered: 0, failed: 0, progress_percent: 0,
    });
    report.checks.push('The native aggregate excludes foreign lists and non-recipients, and separates provider sends, deliveries and incidents.');
  });
});
