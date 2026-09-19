'use strict';
// Independent access boundary and control outbox; no credentials or cascading FK.
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`CREATE TABLE MetaMarketingBrokerRevocations (
      tuple_hash CHAR(64) NOT NULL PRIMARY KEY,
      connection_ref VARCHAR(128) NOT NULL, asset_ref VARCHAR(128) NOT NULL,
      tenant_clinic_id INT NOT NULL, meta_connection_id INT NOT NULL, meta_user_id VARCHAR(30) NOT NULL,
      app_id VARCHAR(30) NOT NULL, parent_page_id VARCHAR(30) NULL, scope_key VARCHAR(64) NOT NULL,
      clinic_ids TEXT NOT NULL, mapping_ids TEXT NOT NULL,
      request_id CHAR(36) NOT NULL UNIQUE, actor_user_id INT NOT NULL,
      requested_at DATETIME(3) NOT NULL, confirmed_at DATETIME(3) NULL,
      state ENUM('pending','confirmed') NOT NULL DEFAULT 'pending',
      attempts INT UNSIGNED NOT NULL DEFAULT 0, next_attempt_at DATETIME(3) NOT NULL,
      lease_token CHAR(36) NULL, lease_until DATETIME(3) NULL, last_error VARCHAR(48) NULL,
      INDEX cc_meta_revoke_delivery (state,next_attempt_at,lease_until),
      INDEX cc_meta_revoke_connection (meta_connection_id),
      INDEX cc_meta_revoke_scope (scope_key), INDEX cc_meta_revoke_asset (asset_ref),
      INDEX cc_meta_revoke_tenant (tenant_clinic_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=ascii COLLATE=ascii_bin`);
    await qi.addIndex('MetaMarketingBrokerBindings',['scope_key','state'],{name:'cc_meta_marketing_scope'});
    await qi.addIndex('ClinicMetaAssets',['assetType','metaAssetId'],{name:'cc_meta_asset_identity'});
  },
  async down(qi) {
    const [rows] = await qi.sequelize.query('SELECT COUNT(*) AS n FROM MetaMarketingBrokerRevocations');
    if (Number(rows[0].n)) throw Error('Preserve durable Meta revocations; populated registry cannot be rolled back');
    await qi.removeIndex('ClinicMetaAssets','cc_meta_asset_identity');
    await qi.removeIndex('MetaMarketingBrokerBindings','cc_meta_marketing_scope');
    await qi.dropTable('MetaMarketingBrokerRevocations');
  },
};
