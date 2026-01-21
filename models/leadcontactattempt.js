'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class LeadContactAttempt extends Model {
    static associate(models) {
      if (models.LeadIntake) {
        LeadContactAttempt.belongsTo(models.LeadIntake, { foreignKey: 'lead_intake_id', as: 'lead' });
      }
      if (models.Usuario) {
        LeadContactAttempt.belongsTo(models.Usuario, { foreignKey: 'usuario_id', targetKey: 'id_usuario', as: 'usuario' });
      }
    }
  }

  LeadContactAttempt.init({
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    lead_intake_id: { type: DataTypes.INTEGER, allowNull: false },
    usuario_id: { type: DataTypes.INTEGER, allowNull: true },
    canal: {
      type: DataTypes.ENUM('llamada', 'whatsapp', 'email', 'dm', 'otro'),
      allowNull: false,
      defaultValue: 'llamada'
    },
    motivo: { type: DataTypes.STRING(128), allowNull: true },
    notas: { type: DataTypes.TEXT, allowNull: true }
  }, {
    sequelize,
    modelName: 'LeadContactAttempt',
    tableName: 'LeadContactAttempts',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

  return LeadContactAttempt;
};
