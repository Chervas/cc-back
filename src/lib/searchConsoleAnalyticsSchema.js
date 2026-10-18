'use strict';

// Only additive, independently named tables. Importing this module never opens SQL.
const metric = { clicks: 'BIGINT UNSIGNED NOT NULL', impressions: 'BIGINT UNSIGNED NOT NULL',
  position_weighted: 'DECIMAL(38,9) NOT NULL', position_sum: 'DECIMAL(38,9) NOT NULL', position_count: 'BIGINT UNSIGNED NOT NULL' };
const definitions = {
  ScAnalyticsProperties: { columns: { id: 'BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY', site_hash: 'BINARY(32) NOT NULL',
    site_url: 'VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL', revision: 'BIGINT UNSIGNED NOT NULL DEFAULT 0' }, keys: ['UNIQUE KEY sca_property_hash(site_hash)'] },
  ScAnalyticsQueries: { columns: { id: 'BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY', value_hash: 'BINARY(32) NOT NULL', value_text: 'MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL' }, keys: ['UNIQUE KEY sca_query_hash(value_hash)'] },
  ScAnalyticsPages: { columns: { id: 'BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY', value_hash: 'BINARY(32) NOT NULL', value_text: 'MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL' }, keys: ['UNIQUE KEY sca_page_hash(value_hash)'] },
  ScAnalyticsIngestBatches: { columns: { batch_id: 'CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY',
    property_id: 'BIGINT UNSIGNED NOT NULL', start_date: 'DATE NOT NULL', end_date: 'DATE NOT NULL', base_revision: 'BIGINT UNSIGNED NOT NULL',
    kind: 'VARCHAR(16) NOT NULL', totals_included: 'TINYINT UNSIGNED NOT NULL DEFAULT 0', state: "VARCHAR(16) NOT NULL DEFAULT 'staging'", created_at: 'DATETIME(3) NOT NULL', committed_at: 'DATETIME(3) NULL',
    source_digest: 'BINARY(32) NULL', row_count: 'BIGINT UNSIGNED NULL' }, keys: ['KEY sca_ingest_property(property_id,state)'] },
  ScAnalyticsStagedRows: { columns: { batch_id: 'CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL', date: 'DATE NOT NULL',
    query_id: 'BIGINT UNSIGNED NOT NULL', page_id: 'BIGINT UNSIGNED NOT NULL', ...metric, row_digest: 'BINARY(32) NOT NULL' },
  keys: ['PRIMARY KEY(batch_id,date,query_id,page_id)'] },
  ScAnalyticsStagedTotals: { columns: { batch_id: 'CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL', date: 'DATE NOT NULL', ...metric,
    row_digest: 'BINARY(32) NOT NULL' }, keys: ['PRIMARY KEY(batch_id,date)'] },
  ScAnalyticsDaily: { columns: { property_id: 'BIGINT UNSIGNED NOT NULL', date: 'DATE NOT NULL', query_id: 'BIGINT UNSIGNED NOT NULL',
    page_id: 'BIGINT UNSIGNED NOT NULL', ...metric, row_digest: 'BINARY(32) NOT NULL', updated_at: 'DATETIME(3) NOT NULL' },
  keys: ['PRIMARY KEY(property_id,date,query_id,page_id)'] },
  ScAnalyticsPropertyDaily: { columns: { property_id: 'BIGINT UNSIGNED NOT NULL', date: 'DATE NOT NULL', ...metric,
    row_digest: 'BINARY(32) NOT NULL', updated_at: 'DATETIME(3) NOT NULL' },
  keys: ['PRIMARY KEY(property_id,date)'] },
  ScAnalyticsRankingDaily: { columns: { property_id: 'BIGINT UNSIGNED NOT NULL', date: 'DATE NOT NULL',
    queries_top3: 'INT UNSIGNED NOT NULL', queries_top10: 'INT UNSIGNED NOT NULL', updated_at: 'DATETIME(3) NOT NULL' },
  keys: ['PRIMARY KEY(property_id,date)'] },
  ScAnalyticsCoverageDaily: { columns: { property_id: 'BIGINT UNSIGNED NOT NULL', date: 'DATE NOT NULL',
    detail_complete: 'TINYINT UNSIGNED NOT NULL DEFAULT 0', totals_complete: 'TINYINT UNSIGNED NOT NULL DEFAULT 0' },
  keys: ['PRIMARY KEY(property_id,date)'] },
  ScAnalyticsMonthly: { columns: { property_id: 'BIGINT UNSIGNED NOT NULL', month: 'DATE NOT NULL', query_id: 'BIGINT UNSIGNED NOT NULL',
    page_id: 'BIGINT UNSIGNED NOT NULL', ...metric, source_rows: 'BIGINT UNSIGNED NOT NULL', source_days: 'INT UNSIGNED NOT NULL' },
  keys: ['PRIMARY KEY(property_id,month,query_id,page_id)'] },
  ScAnalyticsArchiveBatches: { columns: { property_id: 'BIGINT UNSIGNED NOT NULL', month: 'DATE NOT NULL', batch_id: 'CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL',
    source_revision: 'BIGINT UNSIGNED NOT NULL', source_digest: 'BINARY(32) NOT NULL', source_rows: 'BIGINT UNSIGNED NOT NULL',
    state: 'VARCHAR(16) NOT NULL', archive_receipt: 'JSON NOT NULL', verified_at: 'DATETIME(3) NOT NULL', purged_rows: 'BIGINT UNSIGNED NOT NULL DEFAULT 0' },
  keys: ['PRIMARY KEY(property_id,month)', 'UNIQUE KEY sca_archive_id(batch_id)'] },
};
function statements() { return Object.entries(definitions).map(([table, spec]) =>
  `CREATE TABLE IF NOT EXISTS \`${table}\` (${Object.entries(spec.columns).map(([key, type]) => `\`${key}\` ${type}`).concat(spec.keys).join(',')}) ENGINE=InnoDB`); }
function defineModel(sequelize, D, name) {
  const spec = definitions[name]; if (!spec) throw Error('sc_analytics_unknown_model');
  const columns = Object.fromEntries(Object.entries(spec.columns).map(([key, type]) => {
    let value = type.startsWith('BIGINT') ? D.BIGINT.UNSIGNED : type.startsWith('TINYINT') ? D.TINYINT.UNSIGNED : type.startsWith('INT') ? D.INTEGER.UNSIGNED
      : type.startsWith('DECIMAL') ? D.DECIMAL(38, 9) : type.startsWith('DATETIME') ? D.DATE(3)
        : type.startsWith('DATE') ? D.DATEONLY : type.startsWith('BINARY') ? 'BINARY(32)'
          : type.startsWith('JSON') ? D.JSON : type.startsWith('MEDIUMTEXT') ? D.TEXT('medium')
            : D.STRING(Number(type.match(/\((\d+)\)/)?.[1] || 255));
    return [key, { type: value, allowNull: !type.includes('NOT NULL'), primaryKey: type.includes('PRIMARY KEY')
      || spec.keys.some(item => item.startsWith('PRIMARY KEY(') && item.slice(12, -1).split(',').includes(key)),
    ...(type.includes('AUTO_INCREMENT') ? { autoIncrement: true } : {}) }];
  }));
  return sequelize.define(name, columns, { tableName: name, timestamps: false });
}
module.exports = { definitions, statements, defineModel };
