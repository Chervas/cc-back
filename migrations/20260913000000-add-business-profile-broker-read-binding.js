'use strict';
// Apply only in the approved shared-DB cut. No credentials or rows are migrated here.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query('ALTER TABLE `ClinicBusinessLocations` ADD COLUMN `broker_read_connection_ref` VARCHAR(128) NULL DEFAULT NULL, ADD COLUMN `broker_read_asset_ref` VARCHAR(128) NULL DEFAULT NULL, ADD CONSTRAINT `cc_gbp_broker_read_pair` CHECK ((`broker_read_connection_ref` IS NULL AND `broker_read_asset_ref` IS NULL) OR (`broker_read_connection_ref` IS NOT NULL AND `broker_read_asset_ref` IS NOT NULL))');
    await queryInterface.sequelize.query('CREATE TABLE `BusinessProfileBrokerBindings` (`external_location_id` VARCHAR(30) NOT NULL PRIMARY KEY, `connection_ref` VARCHAR(128) NOT NULL, `asset_ref` VARCHAR(128) NOT NULL, `clinica_id` INT NOT NULL, `google_connection_id` INT NOT NULL) ENGINE=InnoDB');
  },
  async down(queryInterface) {
    const [rows] = await queryInterface.sequelize.query('SELECT COUNT(*) AS managed FROM `ClinicBusinessLocations` WHERE `broker_read_connection_ref` IS NOT NULL OR `broker_read_asset_ref` IS NOT NULL');
    if (Number(rows[0].managed)) throw Error('Managed GBP bindings require an approved rollback; keep reads paused');
    const [bindings] = await queryInterface.sequelize.query('SELECT COUNT(*) AS managed FROM `BusinessProfileBrokerBindings`');
    if (Number(bindings[0].managed)) throw Error('Managed GBP bindings require an approved rollback; keep reads paused');
    await queryInterface.sequelize.query('ALTER TABLE `ClinicBusinessLocations` DROP CHECK `cc_gbp_broker_read_pair`, DROP COLUMN `broker_read_asset_ref`, DROP COLUMN `broker_read_connection_ref`');
    await queryInterface.sequelize.query('DROP TABLE `BusinessProfileBrokerBindings`');
  },
};
