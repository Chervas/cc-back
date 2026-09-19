'use strict';
// Schema only; no legacy credential is copied, removed or activated by migration.
module.exports = {
  async up(qi) {
    await qi.sequelize.query("ALTER TABLE `MetaConnections` MODIFY COLUMN `accessToken` VARCHAR(512) NULL, ADD COLUMN `credentials_external` TINYINT(1) NOT NULL DEFAULT 0, ADD COLUMN `broker_app_id` VARCHAR(30) NULL, ADD CONSTRAINT `cc_meta_credential_storage` CHECK ((`credentials_external`=0 AND `broker_app_id` IS NULL AND `accessToken` IS NOT NULL) OR (`credentials_external`=1 AND `broker_app_id` IS NOT NULL AND `broker_app_id` REGEXP '^[1-9][0-9]{0,29}$' AND `accessToken` IS NULL))");
    await qi.sequelize.query("CREATE TABLE `MetaMarketingBrokerBindings` (`mapping_id` INT NOT NULL, `asset_ref` VARCHAR(128) NOT NULL, `meta_connection_id` INT NOT NULL, `meta_user_id` VARCHAR(30) NOT NULL, `app_id` VARCHAR(30) NOT NULL, `connection_ref` VARCHAR(128) NOT NULL, `scope_key` VARCHAR(64) NOT NULL, `tenant_clinic_id` INT NOT NULL, `parent_page_id` VARCHAR(30) NULL, `state` ENUM('staged','active','blocked') NOT NULL DEFAULT 'staged', PRIMARY KEY (`mapping_id`), INDEX `cc_meta_marketing_asset` (`asset_ref`), INDEX `cc_meta_marketing_connection` (`meta_connection_id`), INDEX `cc_meta_marketing_subject` (`meta_user_id`,`app_id`)) ENGINE=InnoDB DEFAULT CHARSET=ascii COLLATE=ascii_bin");
  },
  async down(qi) {
    const [bindings] = await qi.sequelize.query('SELECT COUNT(*) AS n FROM `MetaMarketingBrokerBindings`');
    const [connections] = await qi.sequelize.query('SELECT COUNT(*) AS n FROM `MetaConnections` WHERE `credentials_external`<>0 OR `broker_app_id` IS NOT NULL OR `accessToken` IS NULL');
    if (Number(bindings[0].n) || Number(connections[0].n)) throw Error('Preserve Meta vault exclusions and independent security registry');
    await qi.sequelize.query('DROP TABLE `MetaMarketingBrokerBindings`');
    await qi.sequelize.query('ALTER TABLE `MetaConnections` DROP CHECK `cc_meta_credential_storage`, DROP COLUMN `credentials_external`, DROP COLUMN `broker_app_id`, MODIFY COLUMN `accessToken` VARCHAR(512) NOT NULL');
  },
};
