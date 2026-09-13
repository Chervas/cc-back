'use strict';
// Schema only. Independent records intentionally survive mapping/connection deletion.
module.exports = {
  async up(qi) {
    await qi.sequelize.query('ALTER TABLE `ClinicGoogleAdsAccounts` ADD COLUMN `broker_read_connection_ref` VARCHAR(128) NULL DEFAULT NULL, ADD COLUMN `broker_read_asset_ref` VARCHAR(128) NULL DEFAULT NULL, ADD CONSTRAINT `cc_ads_broker_read_pair` CHECK ((`broker_read_connection_ref` IS NULL AND `broker_read_asset_ref` IS NULL) OR (`broker_read_connection_ref` IS NOT NULL AND `broker_read_asset_ref` IS NOT NULL))');
    await qi.sequelize.query("CREATE TABLE `GoogleAdsBrokerBindings` (`customer_id` CHAR(10) NOT NULL, `mapping_id` INT NOT NULL, `google_connection_id` INT NOT NULL, `google_user_id` VARCHAR(128) NOT NULL, `connection_ref` VARCHAR(128) NOT NULL, `asset_ref` VARCHAR(128) NOT NULL, `scope_key` VARCHAR(64) NOT NULL, `tenant_clinic_id` INT NOT NULL, `login_customer_id` CHAR(10) NULL, `state` ENUM('active','blocked') NOT NULL DEFAULT 'blocked', PRIMARY KEY (`customer_id`, `mapping_id`), INDEX `cc_ads_broker_mapping` (`mapping_id`), INDEX `cc_ads_broker_connection` (`google_connection_id`), INDEX `cc_ads_broker_subject` (`google_user_id`)) ENGINE=InnoDB");
  },
  async down(qi) {
    const [bindings] = await qi.sequelize.query('SELECT COUNT(*) AS n FROM `GoogleAdsBrokerBindings`');
    const [mappings] = await qi.sequelize.query('SELECT COUNT(*) AS n FROM `ClinicGoogleAdsAccounts` WHERE `broker_read_connection_ref` IS NOT NULL OR `broker_read_asset_ref` IS NOT NULL');
    if (Number(bindings[0].n) || Number(mappings[0].n)) throw Error('Managed Google Ads requires an approved rollback; preserve durable credential exclusions');
    await qi.sequelize.query('ALTER TABLE `ClinicGoogleAdsAccounts` DROP CHECK `cc_ads_broker_read_pair`, DROP COLUMN `broker_read_asset_ref`, DROP COLUMN `broker_read_connection_ref`');
    await qi.sequelize.query('DROP TABLE `GoogleAdsBrokerBindings`');
  },
};
