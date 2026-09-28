'use strict';

// Reconcile databases whose group-support migration is recorded but the old
// mandatory clinic column remains. Keep all account data, indexes and FKs intact.
module.exports = {
  async up(qi) {
    const [columns] = await qi.sequelize.query(`SELECT COLUMN_TYPE, IS_NULLABLE FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ClinicGoogleAdsAccounts' AND COLUMN_NAME='clinicaId'`);
    if (columns.length !== 1 || !/^int(?:\(11\))?$/.test(columns[0].COLUMN_TYPE)) throw Error('UNEXPECTED_GOOGLE_ADS_CLINIC_COLUMN');
    if (columns[0].IS_NULLABLE === 'YES') return;
    if (columns[0].IS_NULLABLE !== 'NO') throw Error('UNEXPECTED_GOOGLE_ADS_CLINIC_NULLABILITY');
    await qi.sequelize.query('ALTER TABLE `ClinicGoogleAdsAccounts` MODIFY COLUMN `clinicaId` INT NULL DEFAULT NULL');
  },
  async down() {
    throw Error('GROUP_ACCOUNTS_REQUIRE_NULLABLE_CLINIC_DO_NOT_REVERT');
  },
};
