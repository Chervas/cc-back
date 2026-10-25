'use strict';
module.exports = (sequelize,D) => sequelize.define('AccountingBankMatch', {
  id:{type:D.STRING(36),primaryKey:true},clinic_id:D.INTEGER,line_id:D.STRING(36),target_type:D.STRING(16),target_id:D.STRING(36),amount:D.DECIMAL(12,2),target_snapshot:D.JSON,status:D.STRING(12),reason:D.STRING(500),created_by:D.INTEGER,created_at:D.DATE,reversed_by:D.INTEGER,reversed_at:D.DATE,reversal_reason:D.STRING(500)
}, {tableName:'AccountingBankMatches',timestamps:false});
