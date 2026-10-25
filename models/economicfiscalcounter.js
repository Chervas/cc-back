'use strict';
module.exports = (sequelize, D) => sequelize.define('EconomicFiscalCounter', {
  clinic_id: { type: D.INTEGER, primaryKey: true }, document_type: { type: D.STRING(20), primaryKey: true },
  series: { type: D.STRING(30), primaryKey: true }, fiscal_year: { type: D.INTEGER.UNSIGNED, primaryKey: true },
  sequence_number: { type: D.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
}, { tableName: 'EconomicFiscalCounters', timestamps: false });
