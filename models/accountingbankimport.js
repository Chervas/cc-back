'use strict';
module.exports = (sequelize,D) => sequelize.define('AccountingBankImport', {
  id:{type:D.STRING(36),primaryKey:true},clinic_id:D.INTEGER,account_ref:D.STRING(80),content_hash:D.STRING(64),configuration:D.JSON,source_line_ids:D.JSON,source_asset_id:D.INTEGER,currency:D.STRING(3),row_count:D.INTEGER.UNSIGNED,created_count:D.INTEGER.UNSIGNED,duplicate_count:D.INTEGER.UNSIGNED,created_by:D.INTEGER,created_at:D.DATE
}, {tableName:'AccountingBankImports',timestamps:false,hooks:{
  beforeUpdate(){throw Error('accounting_bank_audit_immutable');},beforeDestroy(){throw Error('accounting_bank_audit_immutable');},
  beforeBulkUpdate(){throw Error('accounting_bank_audit_immutable');},beforeBulkDestroy(){throw Error('accounting_bank_audit_immutable');},
}});
