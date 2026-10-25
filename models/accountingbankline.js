'use strict';
module.exports = (sequelize,D) => sequelize.define('AccountingBankLine', {
  id:{type:D.STRING(36),primaryKey:true},clinic_id:D.INTEGER,import_id:D.STRING(36),account_ref:D.STRING(80),row_key:D.STRING(64),source_row:D.INTEGER.UNSIGNED,date:D.DATEONLY,description:D.STRING(500),currency:D.STRING(3),direction:D.STRING(8),amount:D.DECIMAL(12,2),version:D.INTEGER.UNSIGNED,created_at:D.DATE,updated_at:D.DATE
}, {tableName:'AccountingBankLines',timestamps:false});
