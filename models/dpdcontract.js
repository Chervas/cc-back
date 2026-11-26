'use strict';
module.exports = (sequelize, D) => sequelize.define('DpdContract', {
  id: {type:D.UUID,primaryKey:true}, target: D.STRING, email: D.STRING, status:D.STRING(24),
  secret_hash:D.STRING(64), expires:D.DATE, issued:D.DATE, dossier:D.JSON, pdf:D.BLOB('medium'),
}, {tableName:'DpdContracts',timestamps:false});
