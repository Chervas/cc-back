'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class ConsentDeliveryEvent extends Model {
    static associate(models) {
      ConsentDeliveryEvent.belongsTo(models.ConsentSignaturePackage, {
        foreignKey: 'package_id',
        as: 'package',
      });
      ConsentDeliveryEvent.belongsTo(models.PatientConsentDocument, {
        foreignKey: 'patient_consent_document_id',
        as: 'document',
      });
    }
  }

  ConsentDeliveryEvent.init({
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    package_id: { type: DataTypes.INTEGER, allowNull: true },
    patient_consent_document_id: { type: DataTypes.INTEGER, allowNull: true },
    channel: {
      type: DataTypes.ENUM('tablet', 'email', 'whatsapp', 'internal'),
      allowNull: false,
      defaultValue: 'internal',
    },
    status: {
      type: DataTypes.ENUM('queued', 'mock_sent', 'sent', 'failed', 'viewed'),
      allowNull: false,
      defaultValue: 'queued',
    },
    recipient: { type: DataTypes.STRING(255), allowNull: true },
    event_payload: { type: DataTypes.JSON, allowNull: true },
  }, {
    sequelize,
    modelName: 'ConsentDeliveryEvent',
    tableName: 'ConsentDeliveryEvents',
    timestamps: true,
  });

  return ConsentDeliveryEvent;
};
