'use strict';

module.exports = (sequelize, DataTypes) => {
  const IntakeConfig = sequelize.define('IntakeConfig', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    clinic_id: {
      type: DataTypes.INTEGER,
      // Puede ser null cuando la configuración es a nivel de grupo
      allowNull: true,
      references: { model: 'Clinicas', key: 'id_clinica' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE'
    },
    group_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'GruposClinicas', key: 'id_grupo' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE'
    },
    assignment_scope: {
      type: DataTypes.ENUM('clinic', 'group'),
      allowNull: false,
      defaultValue: 'clinic'
    },
    domains: { type: DataTypes.JSON, allowNull: true },
    config: { type: DataTypes.JSON, allowNull: true },
    hmac_key: { type: DataTypes.STRING(256), allowNull: true }
  }, {
    tableName: 'IntakeConfigs',
    timestamps: true,
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

  IntakeConfig.associate = function(models) {
    IntakeConfig.belongsTo(models.Clinica, { foreignKey: 'clinic_id', targetKey: 'id_clinica', as: 'clinica' });
    IntakeConfig.belongsTo(models.GrupoClinica, { foreignKey: 'group_id', targetKey: 'id_grupo', as: 'grupo' });
  };

  return IntakeConfig;
};
