'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { ownedMysqlTestEntry } = require('./fixtures/owned_mysql_test_entry.fixture');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const enabled = ownedMysqlTestEntry(process.env, { allowSkip: true });

test('email progress counts only the scoped audience, with separate confirmed delivery and incident counts', { skip: !enabled }, async () => {
  await withIsolatedCampaignMysql(async ({ sql, models, report }) => {
    const { getEmailDispatchProgress, getEmailCampaignReport, getEmailRecipientStates } = require('../../services/marketingEmailDispatch.service');
    await sql.query(`CREATE TABLE MarketingPatientListItems (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, list_id BIGINT NOT NULL,
      selected BOOLEAN NOT NULL, status VARCHAR(40) NOT NULL,
      email VARCHAR(100), channel_status JSON, email_message_id BIGINT, opt_out_at DATETIME, INDEX (list_id)
    )`);
    await sql.query(`CREATE TABLE EmailMessages (id BIGINT PRIMARY KEY, stream VARCHAR(32), related_type VARCHAR(80),
      related_id VARCHAR(80), status VARCHAR(24), sent_at DATETIME, delivered_at DATETIME, metadata JSON)`);
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

    await sql.query(`CREATE TABLE EmailProviderEvents (id BIGINT AUTO_INCREMENT PRIMARY KEY, email_message_id BIGINT,
      event_type VARCHAR(64), payload_summary JSON, INDEX (email_message_id))`);
    await sql.query(`CREATE TABLE MarketingEmailUnsubscribes (item_id BIGINT, list_id BIGINT, scope_key VARCHAR(64),
      status VARCHAR(24), INDEX (scope_key))`);
    const list = { id: 5, clinica_id: 1 };
    const historical = await getEmailCampaignReport(list);
    assert.equal(historical.totals.sent, 4);
    assert.equal(historical.totals.delivered, 2);
    assert.equal(historical.totals.pending_send, 3);
    assert.equal(historical.totals.awaiting_delivery, 1);
    assert.equal(historical.tracking.available, false);
    assert.deepEqual(historical.links, []);

    await sql.query(`UPDATE MarketingPatientListItems SET email_message_id = id WHERE id IN (1, 2, 4, 10)`);
    await sql.query(`UPDATE MarketingPatientListItems SET opt_out_at = NOW() WHERE id IN (2, 4)`);
    await sql.query(`INSERT INTO MarketingEmailUnsubscribes VALUES
      (2, 5, 'clinic:1', 'unsubscribed'), (4, 5, 'clinic:2', 'unsubscribed')`);
    await sql.query(`INSERT INTO EmailMessages VALUES
      (1, 'marketing', 'marketing_bulk_send', '5:1', 'delivered', NOW(), NOW(), NULL),
      (2, 'marketing', 'marketing_bulk_send', '5:2', 'delivered', NOW(), NOW(), JSON_OBJECT('email_engagement', 'v1')),
      (4, 'marketing', 'marketing_bulk_send', '5:4', 'complained', NOW(), NOW(), JSON_OBJECT('email_engagement', 'v1')),
      (10, 'marketing', 'marketing_bulk_send', '6:10', 'delivered', NOW(), NOW(), JSON_OBJECT('email_engagement', 'v1'))`);
    await sql.query(`INSERT INTO EmailProviderEvents(email_message_id, event_type, payload_summary) VALUES
      (1, 'open', NULL), (2, 'open', NULL), (2, 'open', NULL), (10, 'open', NULL),
      (2, 'click', JSON_OBJECT('click_url', 'https://example.test/menu')),
      (2, 'click', JSON_OBJECT('click_url', 'https://example.test/menu')),
      (4, 'click', JSON_OBJECT('click_url', 'https://example.test/menu'))`);
    const current = await getEmailCampaignReport(list);
    assert.equal(current.totals.delivered, 3, 'a receipt on the durable email counts before projection to the list item');
    assert.equal(current.totals.unsubscribed, 1);
    assert.deepEqual(current.tracking, { available: true, tracked_sent: 2, tracked_delivered: 2, opened_unique: 1, clicked_unique: 2 });
    assert.deepEqual(current.links, [{ url: 'https://example.test/menu', clicks: 3, unique_clicks: 2 }]);
    report.checks.push('Historical coverage, distinct opens and clicks, scope and counts by URL come from native MySQL.');

    await sql.query(`ALTER TABLE EmailMessages ADD bounced_at DATETIME, ADD complained_at DATETIME,
      ADD rejected_at DATETIME, ADD last_error_code VARCHAR(80)`);
    const { DataTypes } = require('sequelize');
    models.EmailMessage = sql.define('EmailMessage', {
      id: { type: DataTypes.INTEGER, primaryKey: true }, stream: DataTypes.STRING, related_type: DataTypes.STRING,
      related_id: DataTypes.STRING, status: DataTypes.STRING, sent_at: DataTypes.DATE, delivered_at: DataTypes.DATE,
      bounced_at: DataTypes.DATE, complained_at: DataTypes.DATE, rejected_at: DataTypes.DATE, last_error_code: DataTypes.STRING,
    }, { tableName: 'EmailMessages', timestamps: false });
    const states = await getEmailRecipientStates(5, [
      { id: 1, email_message_id: 1, channel_status: { email: { status: 'sent' } } },
      { id: 3, email_message_id: 10 },
    ]);
    assert.equal(states.get(1).status, 'delivered');
    assert.ok(states.get(1).delivered_at);
    assert.equal(states.has(3), false, 'a corrupt cross-campaign pointer must not leak delivery');
    report.checks.push('The recipient report overlays authoritative delivery and rejects cross-campaign pointers.');
  });
});
