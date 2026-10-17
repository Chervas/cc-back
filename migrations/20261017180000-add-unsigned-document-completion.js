'use strict';

// Additive only: no document/template/configuration or historical evidence is
// rewritten. Rollback refuses to discard a real completed receipt.
module.exports = {
  async up(queryInterface) {
    const types = { PatientConsentDocuments: "enum('pending','sent','viewed','signed','rejected','revoked','expired','cancelled','superseded','voided')",
      ConsentSignaturePackages: "enum('draft','pending','sent','viewed','signed','expired','cancelled')" };
    const [columns] = await queryInterface.sequelize.query("SELECT TABLE_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,EXTRA,CHARACTER_SET_NAME,COLLATION_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('PatientConsentDocuments','ConsentSignaturePackages') AND COLUMN_NAME='status'");
    for (const [table, type] of Object.entries(types)) {
      const column = columns.find(row => row.TABLE_NAME === table), extended = type.slice(0, -1) + ",'completed')";
      if (!column || ![type, extended].includes(column.COLUMN_TYPE) || column.IS_NULLABLE !== 'NO' || column.COLUMN_DEFAULT !== 'pending'
        || column.EXTRA !== '' || !/^[a-zA-Z0-9_]+$/.test(column.CHARACTER_SET_NAME || '') || !/^[a-zA-Z0-9_]+$/.test(column.COLLATION_NAME || '')) throw Error('unsigned_document_completion_schema_review_required');
      if (column.COLUMN_TYPE === extended) continue;
      await queryInterface.sequelize.query('ALTER TABLE `' + table + '` MODIFY COLUMN `status` ' + extended
        + ' CHARACTER SET `' + column.CHARACTER_SET_NAME + '` COLLATE `' + column.COLLATION_NAME + "` NOT NULL DEFAULT 'pending', ALGORITHM=INPLACE, LOCK=NONE");
    }
  },
  async down(queryInterface) {
    const [rows] = await queryInterface.sequelize.query("SELECT (SELECT COUNT(*) FROM `PatientConsentDocuments` WHERE `status`='completed') + (SELECT COUNT(*) FROM `ConsentSignaturePackages` WHERE `status`='completed') AS `total`");
    if (Number(rows[0]?.total)) throw Error('unsigned_document_completion_rollback_requires_review');
    await queryInterface.sequelize.query("ALTER TABLE `PatientConsentDocuments` MODIFY COLUMN `status` ENUM('pending','sent','viewed','signed','rejected','revoked','expired','cancelled','superseded','voided') NOT NULL DEFAULT 'pending'");
    await queryInterface.sequelize.query("ALTER TABLE `ConsentSignaturePackages` MODIFY COLUMN `status` ENUM('draft','pending','sent','viewed','signed','expired','cancelled') NOT NULL DEFAULT 'pending'");
  },
};
