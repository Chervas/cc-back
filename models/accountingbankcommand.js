'use strict';
module.exports = (sequelize,D) => sequelize.define('AccountingBankCommand', {
  id:{type:D.STRING(36),primaryKey:true},clinic_id:D.INTEGER,actor_id:D.INTEGER,idempotency_key:D.STRING(120),command_type:D.STRING(16),request_hash:D.STRING(64),result:D.JSON,created_at:D.DATE
}, {tableName:'AccountingBankCommands',timestamps:false,hooks:{
  beforeUpdate(){throw Error('accounting_bank_audit_immutable');},beforeDestroy(){throw Error('accounting_bank_audit_immutable');},
  beforeBulkUpdate(){throw Error('accounting_bank_audit_immutable');},beforeBulkDestroy(){throw Error('accounting_bank_audit_immutable');},
}});
