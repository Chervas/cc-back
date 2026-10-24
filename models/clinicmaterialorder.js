'use strict';
module.exports = (sequelize, D) => {
  const model = sequelize.define('ClinicMaterialOrder', {
    id: { type: D.STRING(36), primaryKey: true }, clinic_id: { type: D.INTEGER, allowNull: false }, supplier_id: D.STRING(36),
    reference: D.STRING(100), status: D.STRING(24), expected_on: D.DATEONLY, notes: D.TEXT,
    version: D.INTEGER.UNSIGNED, created_by: D.INTEGER, updated_by: D.INTEGER,
  }, { tableName: 'ClinicMaterialOrders', underscored: true, createdAt: 'created_at', updatedAt: 'updated_at' });
  model.associate = db => { model.hasMany(db.ClinicMaterialOrderLine, { as: 'lines', foreignKey: 'order_id' }); model.belongsTo(db.ClinicSupplier, { as: 'supplier', foreignKey: 'supplier_id' }); };
  return model;
};
