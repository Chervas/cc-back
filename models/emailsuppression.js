'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class EmailSuppression extends Model {
    static associate(models) {
      if (models.Clinica) {
        EmailSuppression.belongsTo(models.Clinica, { foreignKey: 'clinica_id', as: 'clinica' });
      }
      if (models.EmailProviderEvent) {
        EmailSuppression.belongsTo(models.EmailProviderEvent, { foreignKey: 'provider_event_id', as: 'providerEvent' });
      }
    }
  }

  EmailSuppression.init({
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    email_hash: { type: DataTypes.CHAR(64), allowNull: false },
    email_domain: DataTypes.STRING(255),
    stream: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'all' },
    scope: { type: DataTypes.STRING(64), allowNull: false, defaultValue: 'global' },
    status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'active' },
    reason: { type: DataTypes.STRING(64), allowNull: false },
    source: { type: DataTypes.STRING(64), allowNull: false, defaultValue: 'provider_event' },
    provider_event_id: DataTypes.INTEGER.UNSIGNED,
    clinica_id: DataTypes.INTEGER,
    notes: DataTypes.TEXT,
    suppressed_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  }, {
    sequelize,
    modelName: 'EmailSuppression',
    tableName: 'EmailSuppressions',
    timestamps: true,
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });

  return EmailSuppression;
};
