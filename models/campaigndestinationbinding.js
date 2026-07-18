'use strict';

module.exports = (sequelize, DataTypes) => {
  const CampaignDestinationBinding = sequelize.define('CampaignDestinationBinding', {
    id: { type: DataTypes.STRING(36), allowNull: false, primaryKey: true, validate: { isUUID: 4 } },
    strategyId: { type: DataTypes.INTEGER, allowNull: false, field: 'strategy_id' },
    targetKind: { type: DataTypes.ENUM('general', 'treatment'), allowNull: false, field: 'target_kind' },
    treatmentId: { type: DataTypes.INTEGER, allowNull: true, field: 'treatment_id' },
    treatmentIdentity: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, field: 'treatment_identity' },
    mode: { type: DataTypes.ENUM('connect_only', 'guided_improvement', 'managed_service'), allowNull: false },
    scopeType: { type: DataTypes.ENUM('clinic', 'group'), allowNull: false, field: 'scope_type' },
    clinicaId: { type: DataTypes.INTEGER, allowNull: true, field: 'clinica_id' },
    grupoClinicaId: { type: DataTypes.INTEGER, allowNull: true, field: 'grupo_clinica_id' },
    projectId: { type: DataTypes.STRING(36), allowNull: false, field: 'project_id' },
    publicationId: { type: DataTypes.STRING(36), allowNull: false, field: 'publication_id' },
    revisionId: { type: DataTypes.STRING(36), allowNull: false, field: 'revision_id' },
    artifactId: { type: DataTypes.STRING(36), allowNull: false, field: 'artifact_id' },
    destinationUrl: { type: DataTypes.TEXT, allowNull: false, field: 'destination_url' },
    destinationDigest: { type: DataTypes.STRING(64), allowNull: false, field: 'destination_digest', validate: { is: /^[a-f0-9]{64}$/ } },
    activeDestinationUrl: { type: DataTypes.TEXT, allowNull: true, field: 'active_destination_url' },
    activeDestinationDigest: { type: DataTypes.STRING(64), allowNull: true, field: 'active_destination_digest' },
    landingEventId: { type: DataTypes.STRING(80), allowNull: false, field: 'landing_event_id' },
    destinationReadyEventId: { type: DataTypes.STRING(80), allowNull: true, field: 'destination_ready_event_id' },
    publicationStatus: { type: DataTypes.ENUM('verified', 'invalid', 'retired'), allowNull: false, field: 'publication_status', defaultValue: 'verified' },
    destinationStatus: {
      type: DataTypes.ENUM('ready', 'apply_queued', 'applying', 'readback_pending', 'active', 'rollback_queued', 'rolling_back', 'rolled_back', 'blocked', 'failed', 'drifted'),
      allowNull: false,
      field: 'destination_status',
      defaultValue: 'ready',
    },
    capabilityStatus: { type: DataTypes.ENUM('blocked', 'ready', 'active'), allowNull: false, field: 'capability_status', defaultValue: 'ready' },
    authorization: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },
    lastErrorCode: { type: DataTypes.STRING(128), allowNull: true, field: 'last_error_code' },
    lastErrorDetails: { type: DataTypes.JSON, allowNull: true, field: 'last_error_details' },
    version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
    activeAt: { type: DataTypes.DATE, allowNull: true, field: 'active_at' },
  }, {
    tableName: 'CampaignDestinationBindings',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { unique: true, name: 'uniq_campaign_destination_binding_target_nullsafe', fields: ['strategy_id', 'target_kind', 'treatment_identity'] },
      { unique: true, name: 'uniq_campaign_destination_binding_landing_event', fields: ['landing_event_id'] },
      { fields: ['publication_id', 'publication_status'] },
      { fields: ['destination_status', 'updated_at'] },
    ],
    validate: {
      coherentTarget() {
        const treatment = Number(this.treatmentId);
        if (this.targetKind === 'general' && (this.treatmentId != null || Number(this.treatmentIdentity) !== 0)) {
          throw new Error('El target general debe usar treatment_id=null y treatment_identity=0');
        }
        if (this.targetKind === 'treatment' && (!Number.isInteger(treatment) || treatment <= 0 || Number(this.treatmentIdentity) !== treatment)) {
          throw new Error('El target treatment debe proyectar su treatment_id positivo en treatment_identity');
        }
      },
      coherentScope() {
        if (this.scopeType === 'clinic' && (!Number.isInteger(Number(this.clinicaId)) || this.grupoClinicaId != null)) {
          throw new Error('El scope clinic requiere solo clinica_id');
        }
        if (this.scopeType === 'group' && (!Number.isInteger(Number(this.grupoClinicaId)) || this.clinicaId != null)) {
          throw new Error('El scope group requiere solo grupo_clinica_id');
        }
      },
    },
  });

  CampaignDestinationBinding.associate = function associate(models) {
    CampaignDestinationBinding.belongsTo(models.Campaign, { foreignKey: 'strategyId', as: 'strategy', onDelete: 'RESTRICT' });
    if (models.Tratamiento) CampaignDestinationBinding.belongsTo(models.Tratamiento, { foreignKey: 'treatmentId', targetKey: 'id_tratamiento', as: 'treatment', onDelete: 'RESTRICT' });
    if (models.WebProject) CampaignDestinationBinding.belongsTo(models.WebProject, { foreignKey: 'projectId', as: 'project', onDelete: 'RESTRICT' });
    if (models.WebPublication) CampaignDestinationBinding.belongsTo(models.WebPublication, { foreignKey: 'publicationId', as: 'publication', onDelete: 'RESTRICT' });
    if (models.WebRevision) CampaignDestinationBinding.belongsTo(models.WebRevision, { foreignKey: 'revisionId', as: 'revision', onDelete: 'RESTRICT' });
    if (models.WebArtifact) CampaignDestinationBinding.belongsTo(models.WebArtifact, { foreignKey: 'artifactId', as: 'artifact', onDelete: 'RESTRICT' });
    if (models.CampaignDestinationBindingAccount) CampaignDestinationBinding.hasMany(models.CampaignDestinationBindingAccount, { foreignKey: 'bindingId', as: 'accounts' });
    if (models.CampaignDestinationBindingEvent) CampaignDestinationBinding.hasMany(models.CampaignDestinationBindingEvent, { foreignKey: 'bindingId', as: 'events' });
  };

  return CampaignDestinationBinding;
};
