'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Sequelize = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { instagramPostMedia } = require('../../lib/social-post-original-media');
const migration = require('../../../migrations/20261118113000-add-social-post-original-media-url');
const creativeMigration = require('../../../migrations/20261118123000-add-social-ad-creative-payload');
const { socialAdCreativeSnapshot } = require('../../lib/social-ad-creative-snapshot');

test('owned MySQL: original media migration preserves thumbnail rows, adds nullable storage, and normal sync recovers video once', async () => {
  await withIsolatedCampaignMysql(async ({ sql, report }) => {
    await sql.query('CREATE TABLE Clinicas (id_clinica INT PRIMARY KEY) ENGINE=InnoDB');
    await sql.query('INSERT INTO Clinicas (id_clinica) VALUES (66)');
    await sql.query('CREATE TABLE ClinicMetaAssets (id INT PRIMARY KEY) ENGINE=InnoDB');
    await sql.query('INSERT INTO ClinicMetaAssets (id) VALUES (1)');
    const Posts = require('../../../models/socialpost')(sql, Sequelize.DataTypes);
    const originalAttribute = Posts.rawAttributes.original_media_url;
    Posts.removeAttribute('original_media_url');
    await Posts.sync();
    const old = await Posts.create({ clinica_id: 66, asset_id: 1, asset_type: 'instagram_business', post_id: 'synthetic-reel',
      post_type: 'video', title: 'Synthetic vertical reel', content: 'Synthetic only', media_url: 'https://scontent.fbcdn.net/thumbnail.jpg' });
    // Compare persisted precision, not the INSERT instance's millisecond clock.
    const before = (await Posts.findByPk(old.id)).get({ plain: true });
    const q = sql.getQueryInterface();
    await migration.up(q, Sequelize);
    const columns = await q.describeTable('SocialPosts');
    assert.equal(columns.original_media_url.type, 'TEXT'); assert.equal(columns.original_media_url.allowNull, true);
    await migration.up(q, Sequelize);
    Posts.rawAttributes.original_media_url = originalAttribute; Posts.refreshAttributes();
    const after = (await Posts.findByPk(old.id)).get({ plain: true });
    assert.equal(after.original_media_url, null);
    for (const key of Object.keys(before)) assert.deepEqual(after[key], before[key], key);
    const media = instagramPostMedia({ media_type: 'VIDEO', thumbnail_url: before.media_url,
      media_url: 'https://video.cdninstagram.com/vertical-original.mp4' });
    await Posts.update(media, { where: { id: old.id } });
    const restored = (await Posts.findByPk(old.id)).get({ plain: true });
    assert.equal(restored.media_url, before.media_url);
    assert.equal(restored.original_media_url, 'https://video.cdninstagram.com/vertical-original.mp4');
    const [[column]] = await sql.query("SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,EXTRA,CHARACTER_SET_NAME,COLLATION_NAME,GENERATION_EXPRESSION FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='SocialPosts' AND COLUMN_NAME='original_media_url'");
    report.originalMediaColumn = column;
    const [[table]] = await sql.query("SELECT ENGINE,TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='SocialPosts'");
    report.originalMediaTable = table;
    report.checks.push('Real nullable TEXT addition and idempotence', 'All pre-existing columns/values preserved',
      'Normal sync persists original URL and preserves existing thumbnail', 'No host database, Redis, Meta, or WhatsApp connection');

    const Ads = require('../../../models/socialadsentity')(sql, Sequelize.DataTypes);
    const creativeAttribute = Ads.rawAttributes.creative_payload;
    Ads.removeAttribute('creative_payload'); await Ads.sync();
    await Ads.create({ ad_account_id: '123', level: 'ad', entity_id: '700', parent_id: '800', name: 'Synthetic only', status: 'ACTIVE' });
    const oldAd = (await Ads.findOne()).get({ plain: true });
    await creativeMigration.up(q, Sequelize); await creativeMigration.up(q, Sequelize);
    Ads.rawAttributes.creative_payload = creativeAttribute; Ads.refreshAttributes();
    const migratedAd = (await Ads.findOne()).get({ plain: true });
    assert.equal(migratedAd.creative_payload, null);
    for (const key of Object.keys(oldAd)) assert.deepEqual(migratedAd[key], oldAd[key], key);
    const ad = { id: '700', campaign_id: '456', adset_id: '800', creative: { sharing: { version: 1,
      body: 'Synthetic canonical conditions', title: 'Synthetic original', kind: 'VIDEO', image_url: null,
      thumbnail_url: before.media_url, video_id: '900', original_media_url: restored.original_media_url,
      source_issue: null, has_variants: false } } };
    const payload = socialAdCreativeSnapshot({ accountId: '123', ad });
    await Ads.upsert({ ad_account_id: '123', level: 'ad', entity_id: '700', parent_id: '800', creative_payload: payload });
    assert.equal(await Ads.count(), 1); assert.deepEqual((await Ads.findOne()).creative_payload, payload);
    const [[creativeColumn]] = await sql.query("SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,EXTRA,CHARACTER_SET_NAME,COLLATION_NAME,GENERATION_EXPRESSION FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='SocialAdsEntities' AND COLUMN_NAME='creative_payload'");
    report.creativePayloadColumn = creativeColumn;
    report.checks.push('Real nullable JSON creative payload migration and idempotence', 'All pre-existing ad columns preserved',
      'Normal ad upsert persists the exact creative reference, copy and original video without duplicate ad rows');
  });
});
