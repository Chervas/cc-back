'use strict';

// Selected additive migration. Reconciliation is an auditable link, never a
// second payment, an expense mutation or a fiscal document mutation.
module.exports = {
  async up(q, S) {
    const id = () => ({type:S.STRING(36),primaryKey:true,allowNull:false});
    const clinic = () => ({type:S.INTEGER,allowNull:false,references:{model:'Clinicas',key:'id_clinica'},onDelete:'RESTRICT',onUpdate:'RESTRICT'});
    const ref = (model, type=S.STRING(36)) => ({type,allowNull:false,references:{model,key:'id'},onDelete:'RESTRICT',onUpdate:'RESTRICT'});
    await q.createTable('AccountingBankImports', {
      id:id(),clinic_id:clinic(),account_ref:{type:S.STRING(80),allowNull:false},
      content_hash:{type:S.STRING(64),allowNull:false},configuration:{type:S.JSON,allowNull:false},
      source_line_ids:{type:S.JSON,allowNull:false},
      source_asset_id:ref('ClinicalPrivateAssets',S.INTEGER),currency:{type:S.STRING(3),allowNull:false},
      row_count:{type:S.INTEGER.UNSIGNED,allowNull:false},created_count:{type:S.INTEGER.UNSIGNED,allowNull:false},
      duplicate_count:{type:S.INTEGER.UNSIGNED,allowNull:false},created_by:{type:S.INTEGER,allowNull:false},created_at:{type:S.DATE,allowNull:false},
    });
    await q.addIndex('AccountingBankImports',['clinic_id','account_ref','content_hash'],{name:'accounting_bank_import_content',unique:true});
    await q.createTable('AccountingBankLines', {
      id:id(),clinic_id:clinic(),import_id:ref('AccountingBankImports'),account_ref:{type:S.STRING(80),allowNull:false},
      row_key:{type:S.STRING(64),allowNull:false},source_row:{type:S.INTEGER.UNSIGNED,allowNull:false},
      date:{type:S.DATEONLY,allowNull:false},description:{type:S.STRING(500),allowNull:false},currency:{type:S.STRING(3),allowNull:false},
      direction:{type:S.STRING(8),allowNull:false},amount:{type:S.DECIMAL(12,2),allowNull:false},
      version:{type:S.INTEGER.UNSIGNED,allowNull:false,defaultValue:1},created_at:{type:S.DATE,allowNull:false},updated_at:{type:S.DATE,allowNull:false},
    });
    await q.addIndex('AccountingBankLines',['clinic_id','account_ref','row_key'],{name:'accounting_bank_line_identity',unique:true});
    await q.addIndex('AccountingBankLines',['clinic_id','date','id'],{name:'accounting_bank_line_page'});
    await q.createTable('AccountingBankMatches', {
      id:id(),clinic_id:clinic(),line_id:ref('AccountingBankLines'),target_type:{type:S.STRING(16),allowNull:false},
      target_id:{type:S.STRING(36),allowNull:false},amount:{type:S.DECIMAL(12,2),allowNull:false},
      target_snapshot:{type:S.JSON,allowNull:false},status:{type:S.STRING(12),allowNull:false},
      reason:{type:S.STRING(500),allowNull:true},created_by:{type:S.INTEGER,allowNull:false},created_at:{type:S.DATE,allowNull:false},
      reversed_by:{type:S.INTEGER,allowNull:true},reversed_at:{type:S.DATE,allowNull:true},reversal_reason:{type:S.STRING(500),allowNull:true},
    });
    await q.addIndex('AccountingBankMatches',['clinic_id','target_type','target_id','status'],{name:'accounting_bank_target_coverage'});
    await q.addIndex('AccountingBankMatches',['line_id','created_at','id'],{name:'accounting_bank_match_line'});
    await q.createTable('AccountingBankCommands', {
      id:id(),clinic_id:clinic(),actor_id:{type:S.INTEGER,allowNull:false},idempotency_key:{type:S.STRING(120),allowNull:false},
      command_type:{type:S.STRING(16),allowNull:false},request_hash:{type:S.STRING(64),allowNull:false},
      result:{type:S.JSON,allowNull:false},created_at:{type:S.DATE,allowNull:false},
    });
    await q.addIndex('AccountingBankCommands',['clinic_id','actor_id','idempotency_key'],{name:'accounting_bank_command_identity',unique:true});
  },
  async down() { throw Error('accounting_bank_reconciliation_forward_only'); },
};
