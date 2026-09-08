'use strict';

module.exports = (sequelize, DataTypes) => {
  const WhatsappChannelBinding = sequelize.define('WhatsappChannelBinding', {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    clinic_id: { type: DataTypes.INTEGER, allowNull: false },
    asset_id: { type: DataTypes.INTEGER, allowNull: false },
    role: { type: DataTypes.STRING(16), allowNull: false },
    purposes: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },
    unavailable_action: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'pause' },
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    created_by: { type: DataTypes.INTEGER, allowNull: true },
    updated_by: { type: DataTypes.INTEGER, allowNull: true },
  }, {
    tableName: 'WhatsappChannelBindings',
    timestamps: true,
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });

  WhatsappChannelBinding.associate = function associate(models) {
    WhatsappChannelBinding.belongsTo(models.Clinica, {
      foreignKey: 'clinic_id',
      targetKey: 'id_clinica',
      as: 'clinic',
    });
    WhatsappChannelBinding.belongsTo(models.ClinicMetaAsset, {
      foreignKey: 'asset_id',
      as: 'asset',
    });
  };

  return WhatsappChannelBinding;
};
