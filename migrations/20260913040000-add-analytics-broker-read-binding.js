'use strict';
// Schema only; no real credentials or mappings are moved by this migration.
module.exports = {
  async up(qi) {
    await qi.sequelize.query('ALTER TABLE `ClinicAnalyticsProperties` ADD COLUMN `broker_read_connection_ref` VARCHAR(128) NULL DEFAULT NULL, ADD COLUMN `broker_read_asset_ref` VARCHAR(128) NULL DEFAULT NULL, ADD CONSTRAINT `cc_ga_broker_read_pair` CHECK ((`broker_read_connection_ref` IS NULL AND `broker_read_asset_ref` IS NULL) OR (`broker_read_connection_ref` IS NOT NULL AND `broker_read_asset_ref` IS NOT NULL))');
    await qi.sequelize.query("CREATE TABLE `AnalyticsBrokerBindings` (`property_name` VARCHAR(128) NOT NULL, `mapping_id` INT NOT NULL, `connection_ref` VARCHAR(128) NOT NULL, `asset_ref` VARCHAR(128) NOT NULL, `clinica_id` INT NOT NULL, `google_connection_id` INT NOT NULL, `google_user_id` VARCHAR(128) NOT NULL, `state` ENUM('active','blocked') NOT NULL DEFAULT 'blocked', PRIMARY KEY (`property_name`, `mapping_id`), INDEX `cc_ga_broker_connection` (`google_connection_id`), INDEX `cc_ga_broker_subject` (`google_user_id`)) ENGINE=InnoDB");
  },
  async down(qi) {
    const [bindings] = await qi.sequelize.query('SELECT COUNT(*) AS n FROM `AnalyticsBrokerBindings`');
    const [mappings] = await qi.sequelize.query('SELECT COUNT(*) AS n FROM `ClinicAnalyticsProperties` WHERE `broker_read_connection_ref` IS NOT NULL OR `broker_read_asset_ref` IS NOT NULL');
    if (Number(bindings[0].n) || Number(mappings[0].n)) throw Error('Managed Analytics requires an approved rollback; preserve the credential boundary');
    await qi.sequelize.query('ALTER TABLE `ClinicAnalyticsProperties` DROP CHECK `cc_ga_broker_read_pair`, DROP COLUMN `broker_read_asset_ref`, DROP COLUMN `broker_read_connection_ref`');
    await qi.sequelize.query('DROP TABLE `AnalyticsBrokerBindings`');
  },
};
