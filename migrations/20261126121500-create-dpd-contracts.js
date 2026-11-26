'use strict';
module.exports = {
  async up(q,S) {
    await q.createTable('DpdContracts',{
      id:{type:S.UUID,primaryKey:true},target:{type:S.STRING,allowNull:false},email:{type:S.STRING,allowNull:false},
      status:{type:S.STRING(24),allowNull:false},secret_hash:{type:S.STRING(64),allowNull:false},
      expires:{type:S.DATE,allowNull:false},issued:{type:S.DATE,allowNull:false},dossier:{type:S.JSON,allowNull:false},pdf:S.BLOB('medium'),
    });
  },
  async down(q){await q.dropTable('DpdContracts');},
};
