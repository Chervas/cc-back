'use strict';

// Preserve complete source pages and signed snapshots, not lossy/truncated HTML.
// No row update, publication, requirement, signature or delivery is performed.
const COLUMNS = Object.freeze([
  ['ClinicConsentTemplateVersions', 'body_html'],
  ['ConsentTemplateCatalogVersions', 'body_html'],
  ['PatientConsentDocuments', 'snapshot_html'],
]);

async function inspect(queryInterface) {
  if (queryInterface.sequelize.getDialect() !== 'mysql') throw Error('CONSENT_HTML_MYSQL_SCHEMA_REQUIRED');
  const [rows] = await queryInterface.sequelize.query(`
    SELECT TABLE_NAME,COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,
           CHARACTER_SET_NAME,COLLATION_NAME,EXTRA,COLUMN_COMMENT
      FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA=DATABASE()
       AND ((TABLE_NAME IN ('ClinicConsentTemplateVersions','ConsentTemplateCatalogVersions') AND COLUMN_NAME='body_html')
         OR (TABLE_NAME='PatientConsentDocuments' AND COLUMN_NAME='snapshot_html'))
     ORDER BY TABLE_NAME`);
  if (rows.length !== COLUMNS.length) throw Error('CONSENT_HTML_SCHEMA_INCOMPLETE');
  return COLUMNS.map(([table, column]) => {
    const found = rows.filter(row => row.TABLE_NAME === table && row.COLUMN_NAME === column);
    if (found.length !== 1) throw Error('CONSENT_HTML_COLUMN_IDENTITY_CHANGED');
    const row = found[0];
    if (!['text', 'mediumtext'].includes(row.COLUMN_TYPE) || row.IS_NULLABLE !== 'YES'
      || row.COLUMN_DEFAULT !== null || row.EXTRA !== '' || row.COLUMN_COMMENT !== ''
      || row.CHARACTER_SET_NAME !== 'utf8mb4' || !/^utf8mb4_[a-z0-9_]+$/.test(row.COLLATION_NAME)) {
      throw Error('CONSENT_HTML_COLUMN_CONTRACT_CHANGED');
    }
    return row;
  });
}

async function alter(queryInterface, row, targetType) {
  // All identifiers/types are fixed or allowlisted. Explicitly retain the
  // existing column collation; a table default must not silently replace it.
  await queryInterface.sequelize.query(`ALTER TABLE \`${row.TABLE_NAME}\`
    MODIFY COLUMN \`${row.COLUMN_NAME}\` ${targetType} CHARACTER SET utf8mb4 COLLATE ${row.COLLATION_NAME} NULL`);
}

module.exports = {
  async up(queryInterface) {
    const rows = await inspect(queryInterface); // Validate all 3 before first DDL.
    for (const row of rows) if (row.COLUMN_TYPE === 'text') await alter(queryInterface, row, 'MEDIUMTEXT');
  },
  async down(queryInterface) {
    const rows = await inspect(queryInterface);
    // Rollback never implicitly truncates a legal document or source page.
    for (const row of rows) {
      const [lengths] = await queryInterface.sequelize.query(`SELECT MAX(OCTET_LENGTH(\`${row.COLUMN_NAME}\`)) AS maximum_bytes FROM \`${row.TABLE_NAME}\``);
      if (!Array.isArray(lengths) || lengths.length !== 1 || Number(lengths[0].maximum_bytes || 0) > 65535) {
        throw Error('CONSENT_HTML_DOWNGRADE_WOULD_TRUNCATE');
      }
    }
    for (const row of rows) if (row.COLUMN_TYPE === 'mediumtext') await alter(queryInterface, row, 'TEXT');
  },
};
