'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class EmailMessage extends Model {
    static associate(models) {
      if (models.Clinica) {
        EmailMessage.belongsTo(models.Clinica, { foreignKey: 'clinica_id', as: 'clinica' });
      }
      if (models.Paciente) {
        EmailMessage.belongsTo(models.Paciente, { foreignKey: 'paciente_id', as: 'paciente' });
      }
      if (models.Usuario) {
        EmailMessage.belongsTo(models.Usuario, { foreignKey: 'usuario_id', as: 'usuario' });
      }
      if (models.JobRequest) {
        EmailMessage.belongsTo(models.JobRequest, { foreignKey: 'job_request_id', as: 'jobRequest' });
      }
      if (models.EmailProviderEvent) {
        EmailMessage.hasMany(models.EmailProviderEvent, { foreignKey: 'email_message_id', as: 'events' });
      }
    }
  }

  EmailMessage.init({
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    public_id: { type: DataTypes.STRING(64), allowNull: false, unique: true },
    stream: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'transactional' },
    provider: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'ses' },
    provider_region: DataTypes.STRING(32),
    provider_message_id: DataTypes.STRING(255),
    configuration_set: DataTypes.STRING(120),
    status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'queued' },
    priority: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'normal' },
    dedupe_key: { type: DataTypes.STRING(191), unique: true },
    template_key: { type: DataTypes.STRING(120), allowNull: false },
    template_version: DataTypes.STRING(32),
    subject_key: DataTypes.STRING(120),
    from_email: DataTypes.STRING(320),
    reply_to: DataTypes.STRING(320),
    recipient_email_envelope: DataTypes.TEXT('long'),
    recipient_hash: { type: DataTypes.CHAR(64), allowNull: false },
    recipient_domain: DataTypes.STRING(255),
    recipient_kind: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'external' },
    clinica_id: DataTypes.INTEGER,
    paciente_id: DataTypes.INTEGER,
    usuario_id: DataTypes.INTEGER,
    related_type: DataTypes.STRING(80),
    related_id: DataTypes.STRING(80),
    job_request_id: DataTypes.INTEGER.UNSIGNED,
    event_count: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    last_event_type: DataTypes.STRING(64),
    last_error_code: DataTypes.STRING(120),
    last_error_message: DataTypes.TEXT,
    template_context: DataTypes.JSON,
    metadata: DataTypes.JSON,
    queued_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    sent_at: DataTypes.DATE,
    delivered_at: DataTypes.DATE,
    rejected_at: DataTypes.DATE,
    bounced_at: DataTypes.DATE,
    complained_at: DataTypes.DATE,
    suppressed_at: DataTypes.DATE,
    completed_at: DataTypes.DATE,
  }, {
    sequelize,
    modelName: 'EmailMessage',
    tableName: 'EmailMessages',
    timestamps: true,
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });

  return EmailMessage;
};
