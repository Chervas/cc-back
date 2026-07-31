'use strict';

function appendOnlyError() {
  const error = new Error('PatientOperationalEvent es append-only');
  error.code = 'PATIENT_OPERATIONAL_EVENT_APPEND_ONLY';
  throw error;
}

module.exports = (sequelize, DataTypes) => {
  const PatientOperationalEvent = sequelize.define('PatientOperationalEvent', {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
    },
    patient_id: { type: DataTypes.INTEGER, allowNull: true },
    clinic_id: { type: DataTypes.INTEGER, allowNull: false },
    actor_user_id: { type: DataTypes.INTEGER, allowNull: true },
    event_type: {
      type: DataTypes.STRING(96),
      allowNull: false,
      validate: { is: /^[a-z][a-z0-9_.-]{2,95}$/ },
    },
    source: { type: DataTypes.STRING(48), allowNull: false },
    channel: { type: DataTypes.STRING(24), allowNull: true },
    metadata: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },
    occurred_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'PatientOperationalEvents',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false,
    hooks: {
      beforeUpdate: appendOnlyError,
      beforeDestroy: appendOnlyError,
      beforeBulkUpdate: appendOnlyError,
      beforeBulkDestroy: appendOnlyError,
    },
    indexes: [
      { fields: ['patient_id', 'clinic_id', 'event_type', 'occurred_at'] },
      { fields: ['clinic_id', 'event_type', 'occurred_at'] },
      { fields: ['actor_user_id', 'occurred_at'] },
    ],
  });

  PatientOperationalEvent.associate = function associate(models) {
    PatientOperationalEvent.belongsTo(models.Paciente, {
      foreignKey: 'patient_id',
      targetKey: 'id_paciente',
      as: 'patient',
    });
    PatientOperationalEvent.belongsTo(models.Clinica, {
      foreignKey: 'clinic_id',
      targetKey: 'id_clinica',
      as: 'clinic',
    });
    PatientOperationalEvent.belongsTo(models.Usuario, {
      foreignKey: 'actor_user_id',
      targetKey: 'id_usuario',
      as: 'actor',
    });
  };

  return PatientOperationalEvent;
};
