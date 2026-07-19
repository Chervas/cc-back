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
    updatedAt: 'updated_at',
    hooks: {
      beforeSave: async (instance, options) => {
        if (options?.skipWebRuntimeReconciliation === true) return;
        // Carga diferida: durante models/index.js todavía no existe el grafo
        // completo de modelos ni el orquestador de JobRequest.
        const reconciliation = require('../src/services/webIntakeRuntimeReconciliation.service');
        await reconciliation.stageIntakeConfigInstanceWrite(instance, options);
      },
      beforeUpsert: async (values, options) => {
        if (options?.skipWebRuntimeReconciliation === true) return;
        const reconciliation = require('../src/services/webIntakeRuntimeReconciliation.service');
        await reconciliation.stageIntakeConfigUpsert(values, options);
      },
      beforeBulkCreate: (_instances, options) => {
        if (options?.skipWebRuntimeReconciliation === true) return;
        // Sequelize omite los hooks de instancia en bulkCreate salvo que se
        // soliciten expresamente. El gate debe ejecutarse fila por fila.
        options.individualHooks = true;
      },
      beforeBulkUpdate: (options) => {
        if (options?.skipWebRuntimeReconciliation === true) return;
        options.individualHooks = true;
      },
      beforeDestroy: async (instance, options) => {
        if (options?.skipWebRuntimeReconciliation === true) return;
        const reconciliation = require('../src/services/webIntakeRuntimeReconciliation.service');
        await reconciliation.assertIntakeConfigDestroyAllowed(instance, options);
      },
      beforeBulkDestroy: (options) => {
        if (options?.skipWebRuntimeReconciliation === true) return;
        if (options?.truncate === true) {
          const error = new Error('No se puede truncar IntakeConfig saltando la reconciliación web.');
          error.code = 'web_intake_runtime_bulk_destroy_forbidden';
          throw error;
        }
        options.individualHooks = true;
      },
    },
  });

  IntakeConfig.associate = function(models) {
    IntakeConfig.belongsTo(models.Clinica, { foreignKey: 'clinic_id', targetKey: 'id_clinica', as: 'clinica' });
    IntakeConfig.belongsTo(models.GrupoClinica, { foreignKey: 'group_id', targetKey: 'id_grupo', as: 'grupo' });
  };

  return IntakeConfig;
};
