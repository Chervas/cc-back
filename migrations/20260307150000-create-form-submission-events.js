'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('FormSubmissionEvents', {
      id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
      },
      clinic_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      group_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      lead_intake_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      page_url: {
        type: Sequelize.STRING(1024),
        allowNull: true,
      },
      form_id: {
        type: Sequelize.STRING(255),
        allowNull: true,
      },
      form_name: {
        type: Sequelize.STRING(255),
        allowNull: true,
      },
      form_selector: {
        type: Sequelize.STRING(512),
        allowNull: true,
      },
      match_domain: {
        type: Sequelize.STRING(255),
        allowNull: true,
      },
      source_detail: {
        type: Sequelize.STRING(128),
        allowNull: true,
      },
      email_normalized: {
        type: Sequelize.STRING(255),
        allowNull: true,
      },
      phone_normalized: {
        type: Sequelize.STRING(64),
        allowNull: true,
      },
      fields_json: {
        type: Sequelize.JSON,
        allowNull: true,
      },
      payload_json: {
        type: Sequelize.JSON,
        allowNull: true,
      },
      submitted_at: {
        type: Sequelize.DATE,
        allowNull: false,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });

    await queryInterface.addIndex('FormSubmissionEvents', ['clinic_id', 'submitted_at'], {
      name: 'idx_form_submission_events_clinic_submitted_at',
    });
    await queryInterface.addIndex('FormSubmissionEvents', ['lead_intake_id'], {
      name: 'idx_form_submission_events_lead_id',
    });
    await queryInterface.addIndex('FormSubmissionEvents', ['phone_normalized', 'submitted_at'], {
      name: 'idx_form_submission_events_phone_submitted_at',
    });
    await queryInterface.addIndex('FormSubmissionEvents', ['email_normalized', 'submitted_at'], {
      name: 'idx_form_submission_events_email_submitted_at',
    });
    await queryInterface.addIndex('FormSubmissionEvents', ['form_id'], {
      name: 'idx_form_submission_events_form_id',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('FormSubmissionEvents', 'idx_form_submission_events_form_id');
    await queryInterface.removeIndex('FormSubmissionEvents', 'idx_form_submission_events_email_submitted_at');
    await queryInterface.removeIndex('FormSubmissionEvents', 'idx_form_submission_events_phone_submitted_at');
    await queryInterface.removeIndex('FormSubmissionEvents', 'idx_form_submission_events_lead_id');
    await queryInterface.removeIndex('FormSubmissionEvents', 'idx_form_submission_events_clinic_submitted_at');
    await queryInterface.dropTable('FormSubmissionEvents');
  },
};
