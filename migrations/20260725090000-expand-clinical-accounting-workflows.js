'use strict';

const crypto = require('crypto');

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('AppointmentClinicalReports', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      public_id: { type: Sequelize.STRING(36), allowNull: false, unique: true },
      clinic_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Clinicas', key: 'id_clinica' },
      },
      patient_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Pacientes', key: 'id_paciente' },
      },
      appointment_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'CitasPacientes', key: 'id_cita' },
        onDelete: 'CASCADE',
      },
      treatment_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Tratamientos', key: 'id_tratamiento' },
        onDelete: 'SET NULL',
      },
      professional_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Usuarios', key: 'id_usuario' },
        onDelete: 'SET NULL',
      },
      status: {
        type: Sequelize.ENUM('draft', 'final'),
        allowNull: false,
        defaultValue: 'draft',
      },
      version_number: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
      reason: { type: Sequelize.STRING(500), allowNull: true },
      summary: { type: Sequelize.TEXT, allowNull: true },
      findings: { type: Sequelize.TEXT, allowNull: true },
      interventions: { type: Sequelize.TEXT, allowNull: true },
      outcome: { type: Sequelize.TEXT, allowNull: true },
      plan: { type: Sequelize.TEXT, allowNull: true },
      next_steps: { type: Sequelize.TEXT, allowNull: true },
      private_notes: { type: Sequelize.TEXT, allowNull: true },
      finalized_at: { type: Sequelize.DATE, allowNull: true },
      finalized_by: { type: Sequelize.INTEGER, allowNull: true },
      created_by: { type: Sequelize.INTEGER, allowNull: true },
      updated_by: { type: Sequelize.INTEGER, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await queryInterface.addIndex('AppointmentClinicalReports', ['appointment_id'], {
      name: 'appointment_clinical_reports_appointment_uq',
      unique: true,
    });
    await queryInterface.addIndex('AppointmentClinicalReports', ['clinic_id', 'patient_id', 'updated_at'], {
      name: 'appointment_clinical_reports_patient_idx',
    });

    await queryInterface.createTable('AppointmentClinicalReportRevisions', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      report_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: false,
        references: { model: 'AppointmentClinicalReports', key: 'id' },
        onDelete: 'CASCADE',
      },
      version_number: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false },
      status: { type: Sequelize.STRING(20), allowNull: false },
      snapshot: { type: Sequelize.JSON, allowNull: false },
      change_type: { type: Sequelize.ENUM('created', 'edited', 'finalized', 'reopened'), allowNull: false },
      actor_id: { type: Sequelize.INTEGER, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await queryInterface.addIndex('AppointmentClinicalReportRevisions', ['report_id', 'version_number'], {
      name: 'appointment_clinical_report_revisions_version_uq',
      unique: true,
    });

    await queryInterface.createTable('AccountingFirms', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      public_id: { type: Sequelize.STRING(36), allowNull: false, unique: true },
      scope_key: { type: Sequelize.STRING(80), allowNull: false, unique: true },
      scope_type: { type: Sequelize.ENUM('clinic', 'group'), allowNull: false },
      group_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'GruposClinicas', key: 'id_grupo' },
        onDelete: 'CASCADE',
      },
      primary_clinic_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Clinicas', key: 'id_clinica' },
        onDelete: 'CASCADE',
      },
      name: { type: Sequelize.STRING(180), allowNull: false },
      active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });

    await queryInterface.createTable('AccountingFirmClinicAssignments', {
      firm_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        primaryKey: true,
        references: { model: 'AccountingFirms', key: 'id' },
        onDelete: 'CASCADE',
      },
      clinic_id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        references: { model: 'Clinicas', key: 'id_clinica' },
        onDelete: 'CASCADE',
      },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await queryInterface.addIndex('AccountingFirmClinicAssignments', ['clinic_id'], {
      name: 'accounting_firm_clinic_assignment_clinic_uq',
      unique: true,
    });

    await queryInterface.createTable('AccountingFirmUsers', {
      firm_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        primaryKey: true,
        references: { model: 'AccountingFirms', key: 'id' },
        onDelete: 'CASCADE',
      },
      user_id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        references: { model: 'Usuarios', key: 'id_usuario' },
        onDelete: 'CASCADE',
      },
      status: { type: Sequelize.ENUM('active', 'revoked'), allowNull: false, defaultValue: 'active' },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await queryInterface.addIndex('AccountingFirmUsers', ['user_id', 'status'], {
      name: 'accounting_firm_users_user_idx',
    });

    await queryInterface.createTable('AccountingIngestionJobs', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      public_id: { type: Sequelize.STRING(36), allowNull: false, unique: true },
      clinic_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Clinicas', key: 'id_clinica' },
      },
      source_asset_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'ClinicalPrivateAssets', key: 'id' },
        onDelete: 'RESTRICT',
      },
      expense_document_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: true,
        references: { model: 'AccountingExpenseDocuments', key: 'id' },
        onDelete: 'SET NULL',
      },
      status: {
        type: Sequelize.ENUM('queued', 'processing', 'review', 'accepted', 'failed'),
        allowNull: false,
        defaultValue: 'queued',
      },
      provider: { type: Sequelize.STRING(40), allowNull: true },
      model: { type: Sequelize.STRING(100), allowNull: true },
      extracted_data: { type: Sequelize.JSON, allowNull: true },
      confidence: { type: Sequelize.DECIMAL(5, 4), allowNull: true },
      error_code: { type: Sequelize.STRING(80), allowNull: true },
      error_message: { type: Sequelize.STRING(1000), allowNull: true },
      attempts: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      created_by: { type: Sequelize.INTEGER, allowNull: true },
      reviewed_by: { type: Sequelize.INTEGER, allowNull: true },
      processed_at: { type: Sequelize.DATE, allowNull: true },
      reviewed_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await queryInterface.addIndex('AccountingIngestionJobs', ['clinic_id', 'status', 'created_at'], {
      name: 'accounting_ingestion_jobs_queue_idx',
    });

    await queryInterface.createTable('AccountingSepaMandates', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      public_id: { type: Sequelize.STRING(36), allowNull: false, unique: true },
      clinic_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Clinicas', key: 'id_clinica' },
      },
      patient_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Pacientes', key: 'id_paciente' },
      },
      reference: { type: Sequelize.STRING(80), allowNull: false },
      account_holder: { type: Sequelize.STRING(180), allowNull: false },
      iban_envelope: { type: Sequelize.TEXT, allowNull: false },
      iban_last4: { type: Sequelize.STRING(4), allowNull: false },
      bic: { type: Sequelize.STRING(11), allowNull: true },
      signature_date: { type: Sequelize.DATEONLY, allowNull: false },
      scheme: { type: Sequelize.ENUM('CORE', 'B2B'), allowNull: false, defaultValue: 'CORE' },
      sequence_type: { type: Sequelize.ENUM('OOFF', 'FRST', 'RCUR', 'FNAL'), allowNull: false, defaultValue: 'RCUR' },
      status: { type: Sequelize.ENUM('active', 'revoked', 'expired'), allowNull: false, defaultValue: 'active' },
      notes: { type: Sequelize.TEXT, allowNull: true },
      created_by: { type: Sequelize.INTEGER, allowNull: true },
      updated_by: { type: Sequelize.INTEGER, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await queryInterface.addIndex('AccountingSepaMandates', ['clinic_id', 'reference'], {
      name: 'accounting_sepa_mandates_reference_uq',
      unique: true,
    });
    await queryInterface.addIndex('AccountingSepaMandates', ['clinic_id', 'patient_id', 'status'], {
      name: 'accounting_sepa_mandates_patient_idx',
    });

    await queryInterface.createTable('AccountingRemittances', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      public_id: { type: Sequelize.STRING(36), allowNull: false, unique: true },
      clinic_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Clinicas', key: 'id_clinica' },
      },
      reference: { type: Sequelize.STRING(80), allowNull: false },
      requested_collection_date: { type: Sequelize.DATEONLY, allowNull: false },
      status: { type: Sequelize.ENUM('draft', 'exported', 'submitted', 'settled', 'cancelled'), allowNull: false, defaultValue: 'draft' },
      creditor_snapshot: { type: Sequelize.JSON, allowNull: false },
      total_amount: { type: Sequelize.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
      item_count: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      exported_at: { type: Sequelize.DATE, allowNull: true },
      created_by: { type: Sequelize.INTEGER, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await queryInterface.addIndex('AccountingRemittances', ['clinic_id', 'reference'], {
      name: 'accounting_remittances_reference_uq',
      unique: true,
    });

    await queryInterface.createTable('AccountingRemittanceItems', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      remittance_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: false,
        references: { model: 'AccountingRemittances', key: 'id' },
        onDelete: 'CASCADE',
      },
      mandate_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: false,
        references: { model: 'AccountingSepaMandates', key: 'id' },
        onDelete: 'RESTRICT',
      },
      patient_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Pacientes', key: 'id_paciente' },
      },
      budget_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: true,
        references: { model: 'EconomicBudgets', key: 'id' },
        onDelete: 'SET NULL',
      },
      amount: { type: Sequelize.DECIMAL(12, 2), allowNull: false },
      concept: { type: Sequelize.STRING(140), allowNull: false },
      end_to_end_id: { type: Sequelize.STRING(35), allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await queryInterface.addIndex('AccountingRemittanceItems', ['remittance_id', 'end_to_end_id'], {
      name: 'accounting_remittance_items_end_to_end_uq',
      unique: true,
    });

    await queryInterface.addColumn('AccountingCashClosures', 'denomination_breakdown', {
      type: Sequelize.JSON,
      allowNull: true,
      after: 'actual_cash',
    });
    await queryInterface.addColumn('AccountingCashClosures', 'tender_reconciliation', {
      type: Sequelize.JSON,
      allowNull: true,
      after: 'denomination_breakdown',
    });
    await queryInterface.addColumn('PatientFiscalDocuments', 'pdf_asset_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: { model: 'ClinicalPrivateAssets', key: 'id' },
      onDelete: 'SET NULL',
      after: 'template_snapshot',
    });

    const [groups] = await queryInterface.sequelize.query(
      'SELECT id_grupo, nombre_grupo FROM GruposClinicas ORDER BY id_grupo'
    );
    const [clinics] = await queryInterface.sequelize.query(
      'SELECT id_clinica, nombre_clinica, grupoClinicaId FROM Clinicas ORDER BY id_clinica'
    );
    const now = new Date();
    const firms = [];
    const firmKeyByScope = new Map();
    for (const group of groups) {
      const scopeKey = `group:${group.id_grupo}`;
      const publicId = crypto.randomUUID();
      firms.push({
        public_id: publicId,
        scope_key: scopeKey,
        scope_type: 'group',
        group_id: group.id_grupo,
        primary_clinic_id: null,
        name: `Gestoría · ${group.nombre_grupo}`,
        active: true,
        created_at: now,
        updated_at: now,
      });
      firmKeyByScope.set(scopeKey, publicId);
    }
    for (const clinic of clinics.filter((item) => !item.grupoClinicaId)) {
      const scopeKey = `clinic:${clinic.id_clinica}`;
      const publicId = crypto.randomUUID();
      firms.push({
        public_id: publicId,
        scope_key: scopeKey,
        scope_type: 'clinic',
        group_id: null,
        primary_clinic_id: clinic.id_clinica,
        name: `Gestoría · ${clinic.nombre_clinica}`,
        active: true,
        created_at: now,
        updated_at: now,
      });
      firmKeyByScope.set(scopeKey, publicId);
    }
    if (firms.length) await queryInterface.bulkInsert('AccountingFirms', firms);
    const [storedFirms] = await queryInterface.sequelize.query(
      'SELECT id, scope_key FROM AccountingFirms'
    );
    const firmIdByScope = new Map(storedFirms.map((firm) => [firm.scope_key, firm.id]));
    const assignments = clinics.map((clinic) => ({
      firm_id: firmIdByScope.get(
        clinic.grupoClinicaId ? `group:${clinic.grupoClinicaId}` : `clinic:${clinic.id_clinica}`
      ),
      clinic_id: clinic.id_clinica,
      created_at: now,
    })).filter((item) => item.firm_id);
    if (assignments.length) await queryInterface.bulkInsert('AccountingFirmClinicAssignments', assignments);
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('PatientFiscalDocuments', 'pdf_asset_id');
    await queryInterface.removeColumn('AccountingCashClosures', 'tender_reconciliation');
    await queryInterface.removeColumn('AccountingCashClosures', 'denomination_breakdown');
    await queryInterface.dropTable('AccountingRemittanceItems');
    await queryInterface.dropTable('AccountingRemittances');
    await queryInterface.dropTable('AccountingSepaMandates');
    await queryInterface.dropTable('AccountingIngestionJobs');
    await queryInterface.dropTable('AccountingFirmUsers');
    await queryInterface.dropTable('AccountingFirmClinicAssignments');
    await queryInterface.dropTable('AccountingFirms');
    await queryInterface.dropTable('AppointmentClinicalReportRevisions');
    await queryInterface.dropTable('AppointmentClinicalReports');
  },
};
