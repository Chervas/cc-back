'use strict';
module.exports = {
  async up(qi, S) {
    const table = 'GoogleCloudCostCaches';
    const columns = {
      cache_key: { type: S.STRING(96), primaryKey: true, allowNull: false },
      snapshot: { type: S.JSON, allowNull: false },
      collected_at: { type: S.DATE, allowNull: false },
      created_at: { type: S.DATE, allowNull: false },
      updated_at: { type: S.DATE, allowNull: false },
    };
    const tables = await qi.showAllTables();
    if (!tables.some(value => (typeof value === 'string' ? value : value.tableName) === table)) await qi.createTable(table, columns);
    const description = await qi.describeTable(table);
    if (Object.keys(columns).some(key => !description[key]) || !description.cache_key.primaryKey) throw Error('google_cost_cache_schema_mismatch');
  },
  async down(qi) { await qi.dropTable('GoogleCloudCostCaches'); },
};
