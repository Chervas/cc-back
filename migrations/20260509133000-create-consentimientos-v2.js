'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('ConsentTemplateCatalogs', {
      id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
      public_id: { type: Sequelize.STRING(80), allowNull: false, unique: true },
      catalog_key: { type: Sequelize.STRING(160), allowNull: true },
      name: { type: Sequelize.STRING(255), allowNull: false },
      description: { type: Sequelize.TEXT, allowNull: true },
      purpose: {
        type: Sequelize.ENUM(
          'clinical',
          'data_protection',
          'clinical_image',
          'marketing_image',
          'commercial_communications',
          'financial',
          'revocation',
          'other'
        ),
        allowNull: false,
        defaultValue: 'clinical',
      },
      status: {
        type: Sequelize.ENUM('draft', 'active', 'archived'),
        allowNull: false,
        defaultValue: 'draft',
      },
      blocking_policy: {
        type: Sequelize.ENUM('hard', 'soft', 'optional'),
        allowNull: false,
        defaultValue: 'hard',
      },
      validity_mode: {
        type: Sequelize.ENUM('single_act', 'treatment_episode', 'treatment_plan', 'until_date', 'manual'),
        allowNull: false,
        defaultValue: 'single_act',
      },
      is_generic: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      requires_patient_signature: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      requires_representative_when_minor: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      requires_professional_signature: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      created_by: { type: Sequelize.INTEGER, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });

    await queryInterface.createTable('ConsentTemplateCatalogVersions', {
      id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
      catalog_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'ConsentTemplateCatalogs', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      locale: { type: Sequelize.STRING(12), allowNull: false, defaultValue: 'es' },
      title: { type: Sequelize.STRING(255), allowNull: false },
      body_json: { type: Sequelize.JSON, allowNull: true },
      body_html: { type: Sequelize.TEXT, allowNull: true },
      variable_schema: { type: Sequelize.JSON, allowNull: true },
      status: {
        type: Sequelize.ENUM('draft', 'published', 'archived'),
        allowNull: false,
        defaultValue: 'published',
      },
      published_at: { type: Sequelize.DATE, allowNull: true },
      created_by: { type: Sequelize.INTEGER, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });

    await queryInterface.createTable('ConsentTemplateCatalogDisciplines', {
      id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
      catalog_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'ConsentTemplateCatalogs', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      disciplina_code: { type: Sequelize.STRING(80), allowNull: false },
      createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });

    await queryInterface.createTable('ConsentTemplateCatalogTreatments', {
      id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
      catalog_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'ConsentTemplateCatalogs', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      tratamiento_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Tratamientos', key: 'id_tratamiento' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });

    await queryInterface.createTable('ClinicConsentTemplates', {
      id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
      public_id: { type: Sequelize.STRING(80), allowNull: false, unique: true },
      clinic_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Clinicas', key: 'id_clinica' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      source_catalog_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'ConsentTemplateCatalogs', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      source_catalog_version_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'ConsentTemplateCatalogVersions', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      catalog_key: { type: Sequelize.STRING(160), allowNull: true },
      name: { type: Sequelize.STRING(255), allowNull: false },
      description: { type: Sequelize.TEXT, allowNull: true },
      purpose: {
        type: Sequelize.ENUM(
          'clinical',
          'data_protection',
          'clinical_image',
          'marketing_image',
          'commercial_communications',
          'financial',
          'revocation',
          'other'
        ),
        allowNull: false,
        defaultValue: 'clinical',
      },
      status: {
        type: Sequelize.ENUM('draft', 'active', 'archived'),
        allowNull: false,
        defaultValue: 'draft',
      },
      blocking_policy: {
        type: Sequelize.ENUM('hard', 'soft', 'optional'),
        allowNull: false,
        defaultValue: 'hard',
      },
      validity_mode: {
        type: Sequelize.ENUM('single_act', 'treatment_episode', 'treatment_plan', 'until_date', 'manual'),
        allowNull: false,
        defaultValue: 'single_act',
      },
      is_default: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      requires_patient_signature: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      requires_representative_when_minor: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      requires_professional_signature: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      created_by: { type: Sequelize.INTEGER, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });

    await queryInterface.createTable('ClinicConsentTemplateVersions', {
      id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
      clinic_template_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'ClinicConsentTemplates', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      source_catalog_version_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'ConsentTemplateCatalogVersions', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      locale: { type: Sequelize.STRING(12), allowNull: false, defaultValue: 'es' },
      title: { type: Sequelize.STRING(255), allowNull: false },
      body_json: { type: Sequelize.JSON, allowNull: true },
      body_html: { type: Sequelize.TEXT, allowNull: true },
      variable_schema: { type: Sequelize.JSON, allowNull: true },
      status: {
        type: Sequelize.ENUM('draft', 'published', 'archived'),
        allowNull: false,
        defaultValue: 'published',
      },
      published_at: { type: Sequelize.DATE, allowNull: true },
      created_by: { type: Sequelize.INTEGER, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });

    await queryInterface.createTable('TreatmentConsentRequirements', {
      id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
      tratamiento_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Tratamientos', key: 'id_tratamiento' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      clinica_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Clinicas', key: 'id_clinica' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      clinic_template_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'ClinicConsentTemplates', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      catalog_template_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'ConsentTemplateCatalogs', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      requirement_scope: {
        type: Sequelize.ENUM('area', 'treatment', 'conditional'),
        allowNull: false,
        defaultValue: 'treatment',
      },
      condition_key: { type: Sequelize.STRING(120), allowNull: true },
      required: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      blocking_policy: {
        type: Sequelize.ENUM('hard', 'soft', 'optional'),
        allowNull: false,
        defaultValue: 'hard',
      },
      sort_order: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });

    await queryInterface.createTable('ConsentSignaturePackages', {
      id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
      public_id: { type: Sequelize.STRING(80), allowNull: false, unique: true },
      paciente_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Pacientes', key: 'id_paciente' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      clinica_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Clinicas', key: 'id_clinica' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      cita_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'CitasPacientes', key: 'id_cita' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      tratamiento_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Tratamientos', key: 'id_tratamiento' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      status: {
        type: Sequelize.ENUM('draft', 'pending', 'sent', 'viewed', 'signed', 'expired', 'cancelled'),
        allowNull: false,
        defaultValue: 'pending',
      },
      required_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      signed_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      due_at: { type: Sequelize.DATE, allowNull: true },
      expires_at: { type: Sequelize.DATE, allowNull: true },
      trigger_source: { type: Sequelize.STRING(80), allowNull: true },
      created_by: { type: Sequelize.INTEGER, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });

    await queryInterface.createTable('PatientConsentDocuments', {
      id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
      public_id: { type: Sequelize.STRING(80), allowNull: false, unique: true },
      package_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'ConsentSignaturePackages', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      paciente_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Pacientes', key: 'id_paciente' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      clinica_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Clinicas', key: 'id_clinica' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      cita_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'CitasPacientes', key: 'id_cita' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      tratamiento_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Tratamientos', key: 'id_tratamiento' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      clinic_template_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'ClinicConsentTemplates', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      clinic_template_version_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'ClinicConsentTemplateVersions', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      catalog_template_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'ConsentTemplateCatalogs', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      catalog_template_version_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'ConsentTemplateCatalogVersions', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      purpose: {
        type: Sequelize.ENUM(
          'clinical',
          'data_protection',
          'clinical_image',
          'marketing_image',
          'commercial_communications',
          'financial',
          'revocation',
          'other'
        ),
        allowNull: false,
        defaultValue: 'clinical',
      },
      status: {
        type: Sequelize.ENUM('pending', 'sent', 'viewed', 'signed', 'rejected', 'revoked', 'expired', 'cancelled', 'superseded', 'voided'),
        allowNull: false,
        defaultValue: 'pending',
      },
      required: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      blocking_policy: {
        type: Sequelize.ENUM('hard', 'soft', 'optional'),
        allowNull: false,
        defaultValue: 'hard',
      },
      locale: { type: Sequelize.STRING(12), allowNull: false, defaultValue: 'es' },
      title: { type: Sequelize.STRING(255), allowNull: false },
      snapshot_json: { type: Sequelize.JSON, allowNull: true },
      snapshot_html: { type: Sequelize.TEXT, allowNull: true },
      snapshot_hash: { type: Sequelize.STRING(128), allowNull: true },
      signed_by_patient_id: { type: Sequelize.INTEGER, allowNull: true },
      signed_by_representative_id: { type: Sequelize.INTEGER, allowNull: true },
      signed_at: { type: Sequelize.DATE, allowNull: true },
      revoked_at: { type: Sequelize.DATE, allowNull: true },
      expires_at: { type: Sequelize.DATE, allowNull: true },
      channel: { type: Sequelize.STRING(40), allowNull: true },
      delivery_status: { type: Sequelize.STRING(40), allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });

    await queryInterface.createTable('ConsentDeliveryEvents', {
      id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
      package_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'ConsentSignaturePackages', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      patient_consent_document_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'PatientConsentDocuments', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      channel: {
        type: Sequelize.ENUM('tablet', 'email', 'whatsapp', 'internal'),
        allowNull: false,
        defaultValue: 'internal',
      },
      status: {
        type: Sequelize.ENUM('queued', 'mock_sent', 'sent', 'failed', 'viewed'),
        allowNull: false,
        defaultValue: 'queued',
      },
      recipient: { type: Sequelize.STRING(255), allowNull: true },
      event_payload: { type: Sequelize.JSON, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });

    await queryInterface.addIndex('ConsentTemplateCatalogDisciplines', ['catalog_id', 'disciplina_code'], {
      name: 'uniq_consent_catalog_disciplina',
      unique: true,
    });
    await queryInterface.addIndex('ConsentTemplateCatalogTreatments', ['catalog_id', 'tratamiento_id'], {
      name: 'uniq_consent_catalog_tratamiento',
      unique: true,
    });
    await queryInterface.addIndex('ConsentTemplateCatalogVersions', ['catalog_id', 'version', 'locale'], {
      name: 'uniq_consent_catalog_version_locale',
      unique: true,
    });
    await queryInterface.addIndex('ClinicConsentTemplates', ['clinic_id', 'status'], {
      name: 'idx_clinic_consent_templates_scope',
    });
    await queryInterface.addIndex('ClinicConsentTemplateVersions', ['clinic_template_id', 'version', 'locale'], {
      name: 'uniq_clinic_consent_version_locale',
      unique: true,
    });
    await queryInterface.addIndex('TreatmentConsentRequirements', ['tratamiento_id', 'clinica_id'], {
      name: 'idx_treatment_consent_requirements_scope',
    });
    await queryInterface.addIndex('PatientConsentDocuments', ['paciente_id', 'status'], {
      name: 'idx_patient_consent_documents_patient_status',
    });
    await queryInterface.addIndex('PatientConsentDocuments', ['cita_id', 'status'], {
      name: 'idx_patient_consent_documents_cita_status',
    });
    await queryInterface.addIndex('ConsentSignaturePackages', ['cita_id', 'status'], {
      name: 'idx_consent_signature_packages_cita_status',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('ConsentDeliveryEvents');
    await queryInterface.dropTable('PatientConsentDocuments');
    await queryInterface.dropTable('ConsentSignaturePackages');
    await queryInterface.dropTable('TreatmentConsentRequirements');
    await queryInterface.dropTable('ClinicConsentTemplateVersions');
    await queryInterface.dropTable('ClinicConsentTemplates');
    await queryInterface.dropTable('ConsentTemplateCatalogTreatments');
    await queryInterface.dropTable('ConsentTemplateCatalogDisciplines');
    await queryInterface.dropTable('ConsentTemplateCatalogVersions');
    await queryInterface.dropTable('ConsentTemplateCatalogs');
  },
};
