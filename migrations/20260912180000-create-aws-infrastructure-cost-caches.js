'use strict';
module.exports = {
  async up(qi, S) {
    const table = 'AwsInfrastructureCostCaches';
    const columns = {
      cache_key: { type: S.STRING(96), primaryKey: true, allowNull: false },
      snapshot: { type: S.JSON, allowNull: true }, collected_at: { type: S.DATE, allowNull: true },
      last_attempt_at: { type: S.DATE, allowNull: true }, last_error_code: { type: S.STRING(64), allowNull: true },
      lease_token: { type: S.UUID, allowNull: true }, lease_until: { type: S.DATE, allowNull: true },
      created_at: { type: S.DATE, allowNull: false }, updated_at: { type: S.DATE, allowNull: false },
    };
    const tables = await qi.showAllTables();
    if (!tables.some(value => (typeof value === 'string' ? value : value.tableName) === table)) await qi.createTable(table, columns);
    const description = await qi.describeTable(table);
    if (Object.keys(columns).some(key => !description[key]) || !description.cache_key.primaryKey) throw Error('aws_cost_cache_schema_mismatch');
    const indexes = await qi.showIndex(table);
    if (!indexes.some(index => index.name === 'idx_aws_cost_cache_lease')) await qi.addIndex(table, ['lease_until'], { name: 'idx_aws_cost_cache_lease' });
  },
  async down(qi) { await qi.dropTable('AwsInfrastructureCostCaches'); },
};
