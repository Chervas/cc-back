'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class Campaign extends Model {
    static associate(models) {
      Campaign.belongsTo(models.Clinica, { foreignKey: 'clinica_id', targetKey: 'id_clinica', as: 'clinica' });
      Campaign.belongsTo(models.GrupoClinica, { foreignKey: 'grupo_clinica_id', targetKey: 'id_grupo', as: 'grupoClinica' });
    }
  }

  Campaign.init({
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    nombre: { type: DataTypes.STRING(255), allowNull: false },
    tipo: { type: DataTypes.ENUM('meta_ads', 'google_ads', 'web_snippet', 'local_services'), allowNull: false },
    clinica_id: { type: DataTypes.INTEGER, allowNull: true },
    grupo_clinica_id: { type: DataTypes.INTEGER, allowNull: true },
    campaign_id_externo: { type: DataTypes.STRING(128), allowNull: true },
    gestionada: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    activa: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    fecha_inicio: { type: DataTypes.DATE, allowNull: true },
    fecha_fin: { type: DataTypes.DATE, allowNull: true },
    presupuesto: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    total_leads: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    gasto: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    cpl: { type: DataTypes.DECIMAL(12, 2), allowNull: true }
  }, {
    sequelize,
    modelName: 'Campaign',
    tableName: 'Campaigns',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

  return Campaign;
};
