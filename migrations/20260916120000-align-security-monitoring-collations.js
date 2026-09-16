'use strict';
// DEV was created with a different default collation. Match the public schema;
// keep old migration files immutable and preserve every row and key.
const tables = ['AiModelPrices','SecurityMonitoringAlerts','SecurityMonitoringChanges','SecurityMonitoringMeasures','SecurityMonitoringSettings'];
module.exports = {
  async up(q) {
    const [[database]] = await q.sequelize.query('SELECT DATABASE() AS name, @@character_set_database AS charset, @@collation_database AS collation');
    if (!/^[a-zA-Z0-9_]+$/.test(database.name) || database.charset !== 'utf8mb4'
      || !['utf8mb4_unicode_ci','utf8mb4_0900_ai_ci'].includes(database.collation)) throw Error('security_database_default_precheck_failed');
    const [rows] = await q.sequelize.query("SELECT TABLE_NAME,ENGINE,TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (:tables)", { replacements: { tables } });
    if (rows.length !== tables.length || rows.some(r => r.ENGINE !== 'InnoDB'
      || !['utf8mb4_unicode_ci','utf8mb4_0900_ai_ci'].includes(r.TABLE_COLLATION))) throw Error('security_collation_precheck_failed');
    // Align the default before subsequent migrations create tables. Existing
    // column-level ASCII/binary collations elsewhere must remain untouched.
    if (database.collation !== 'utf8mb4_0900_ai_ci') await q.sequelize.query('ALTER DATABASE `' + database.name + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci');
    for (const table of tables) {
      if (rows.find(r => r.TABLE_NAME === table).TABLE_COLLATION === 'utf8mb4_0900_ai_ci') continue;
      await q.sequelize.query('ALTER TABLE `' + table + '` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci');
    }
  },
  async down() { throw Error('Keep the compatible schema; restore application code or review a forward migration.'); },
};
