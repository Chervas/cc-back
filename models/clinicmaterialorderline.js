'use strict';
module.exports = (sequelize, D) => {
  const model = sequelize.define('ClinicMaterialOrderLine', {
    id: { type: D.STRING(36), primaryKey: true }, clinic_id: { type: D.INTEGER, allowNull: false }, order_id: D.STRING(36),
    product_id: D.STRING(36), product_name: D.STRING(160), unit: D.STRING(40), quantity: D.DECIMAL(14, 3), received_quantity: D.DECIMAL(14, 3),
  }, { tableName: 'ClinicMaterialOrderLines', underscored: true, createdAt: 'created_at', updatedAt: 'updated_at' });
  model.associate = db => model.belongsTo(db.ClinicMaterialOrder, { as: 'order', foreignKey: 'order_id' });
  return model;
};
