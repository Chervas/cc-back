'use strict';

module.exports = (sequelize, DataTypes) => {
  const WhatsappAccountHealthEvent = sequelize.define('WhatsappAccountHealthEvent', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    dedupe_key: { type: DataTypes.STRING(64), allowNull: false, unique: true },
    asset_id: { type: DataTypes.INTEGER, allowNull: true },
    clinic_id: { type: DataTypes.INTEGER, allowNull: true },
    group_id: { type: DataTypes.INTEGER, allowNull: true },
    waba_id: { type: DataTypes.STRING(255), allowNull: true },
    phone_number_id: { type: DataTypes.STRING(255), allowNull: true },
    phone_number: { type: DataTypes.STRING(64), allowNull: true },
    event_type: { type: DataTypes.STRING(64), allowNull: false },
    source: { type: DataTypes.STRING(96), allowNull: false },
    previous_state: { type: DataTypes.STRING(32), allowNull: true },
    state: { type: DataTypes.STRING(32), allowNull: false },
    severity: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'info' },
    can_send: { type: DataTypes.BOOLEAN, allowNull: true },
    reason_code: { type: DataTypes.STRING(128), allowNull: true },
    provider_status: { type: DataTypes.STRING(64), allowNull: true },
    provider_error_code: { type: DataTypes.STRING(32), allowNull: true },
    details: { type: DataTypes.JSON, allowNull: true },
    observed_at: { type: DataTypes.DATE, allowNull: false },
  }, {
    tableName: 'WhatsappAccountHealthEvents',
    underscored: true,
    timestamps: true,
    updatedAt: false,
  });

  WhatsappAccountHealthEvent.associate = function(models) {
    WhatsappAccountHealthEvent.belongsTo(models.ClinicMetaAsset, {
      foreignKey: 'asset_id',
      targetKey: 'id',
      as: 'asset',
    });
    WhatsappAccountHealthEvent.belongsTo(models.Clinica, {
      foreignKey: 'clinic_id',
      targetKey: 'id_clinica',
      as: 'clinic',
    });
    WhatsappAccountHealthEvent.belongsTo(models.GrupoClinica, {
      foreignKey: 'group_id',
      targetKey: 'id_grupo',
      as: 'group',
    });
  };

  return WhatsappAccountHealthEvent;
};
