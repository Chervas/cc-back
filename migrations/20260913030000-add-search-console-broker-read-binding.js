'use strict';
// No credentials/rows are moved. Apply only in the separately approved DB cut.
module.exports = {
  async up(qi) {
    await qi.sequelize.query('ALTER TABLE `ClinicWebAssets` ADD COLUMN `broker_read_connection_ref` VARCHAR(128) NULL DEFAULT NULL, ADD COLUMN `broker_read_asset_ref` VARCHAR(128) NULL DEFAULT NULL, ADD CONSTRAINT `cc_sc_broker_read_pair` CHECK ((`broker_read_connection_ref` IS NULL AND `broker_read_asset_ref` IS NULL) OR (`broker_read_connection_ref` IS NOT NULL AND `broker_read_asset_ref` IS NOT NULL))');
    // No FK/cascade: removing a mapping or connection must not reopen legacy access.
    await qi.sequelize.query("CREATE TABLE `SearchConsoleBrokerBindings` (`site_hash` CHAR(64) NOT NULL PRIMARY KEY, `site_url` VARCHAR(512) NOT NULL, `mapping_id` INT NOT NULL, `connection_ref` VARCHAR(128) NOT NULL, `asset_ref` VARCHAR(128) NOT NULL, `clinica_id` INT NOT NULL, `google_connection_id` INT NOT NULL, `google_user_id` VARCHAR(128) NOT NULL, `state` ENUM('active','blocked') NOT NULL DEFAULT 'blocked', INDEX `cc_sc_broker_connection` (`google_connection_id`), INDEX `cc_sc_broker_subject` (`google_user_id`)) ENGINE=InnoDB");
  },
  async down(qi) {
    const [bindings] = await qi.sequelize.query('SELECT COUNT(*) AS n FROM `SearchConsoleBrokerBindings`');
    const [mappings] = await qi.sequelize.query('SELECT COUNT(*) AS n FROM `ClinicWebAssets` WHERE `broker_read_connection_ref` IS NOT NULL OR `broker_read_asset_ref` IS NOT NULL');
    if (Number(bindings[0].n) || Number(mappings[0].n)) throw Error('Managed Search Console requires an approved rollback; preserve the credential boundary');
    await qi.sequelize.query('ALTER TABLE `ClinicWebAssets` DROP CHECK `cc_sc_broker_read_pair`, DROP COLUMN `broker_read_asset_ref`, DROP COLUMN `broker_read_connection_ref`');
    await qi.sequelize.query('DROP TABLE `SearchConsoleBrokerBindings`');
  },
};
