'use strict';
module.exports = (sequelize, D) => {
  const model = sequelize.define('BookingEquipment', {
    id: { type: D.INTEGER, primaryKey: true, autoIncrement: true },
    owner_clinic_id: { type: D.INTEGER, allowNull: false }, group_id: D.INTEGER,
    name: { type: D.STRING(120), allowNull: false }, family_key: { type: D.STRING(64), allowNull: false },
    aliases: D.JSON, mobility: { type: D.STRING(12), allowNull: false }, status: { type: D.STRING(16), allowNull: false },
    turnaround_minutes: { type: D.INTEGER, allowNull: false, defaultValue: 0 }, home_installation_id: D.INTEGER,
    revision: { type: D.INTEGER, allowNull: false, defaultValue: 1 },
  }, { tableName: 'BookingEquipment', underscored: true, createdAt: 'created_at', updatedAt: 'updated_at' });
  model.associate = db => model.belongsTo(db.Clinica, { as: 'owner_clinic', foreignKey: 'owner_clinic_id', targetKey: 'id_clinica' });
  return model;
};
