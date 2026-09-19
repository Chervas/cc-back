'use strict';
const before = "enum('active','blocked')";
const after = "enum('active','blocked','staged')";
async function inspect(qi, expected) {
  const [rows] = await qi.sequelize.query("SHOW COLUMNS FROM `GoogleAdsBrokerBindings` LIKE 'state'");
  if (rows.length !== 1 || rows[0].Type !== expected || rows[0].Null !== 'NO' || rows[0].Default !== 'blocked') {
    throw Error('google_ads_mapping_schema_mismatch');
  }
}
module.exports = {
  async up(qi) {
    await inspect(qi, before);
    await qi.sequelize.query('ALTER TABLE `GoogleAdsBrokerBindings` MODIFY COLUMN state ' + after + " NOT NULL DEFAULT 'blocked'");
  },
  async down(qi) {
    await inspect(qi, after);
    const [rows] = await qi.sequelize.query("SELECT COUNT(*) AS n FROM `GoogleAdsBrokerBindings` WHERE state='staged'");
    if (!rows.length || Number(rows[0].n) !== 0) throw Error('Preserve staged Ads mappings; rollback requires an approved cut');
    await qi.sequelize.query('ALTER TABLE `GoogleAdsBrokerBindings` MODIFY COLUMN state ' + before + " NOT NULL DEFAULT 'blocked'");
  },
};
