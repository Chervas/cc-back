'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('LeadIntakes', 'callback_reminder_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });
    await queryInterface.addColumn('LeadIntakes', 'callback_reminder_reason', {
      type: Sequelize.STRING(512),
      allowNull: true,
    });
    await queryInterface.addColumn('LeadIntakes', 'callback_reminder_notes', {
      type: Sequelize.TEXT,
      allowNull: true,
    });
    await queryInterface.addColumn('LeadIntakes', 'callback_reminder_created_by', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
    await queryInterface.addColumn('LeadIntakes', 'callback_reminder_job_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
    await queryInterface.addColumn('LeadIntakes', 'callback_reminder_notified_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });

    await queryInterface.addIndex('LeadIntakes', ['callback_reminder_at'], {
      name: 'idx_leadintakes_callback_reminder_at',
    });
    await queryInterface.addIndex('LeadIntakes', ['callback_reminder_created_by'], {
      name: 'idx_leadintakes_callback_reminder_user',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('LeadIntakes', 'idx_leadintakes_callback_reminder_user');
    await queryInterface.removeIndex('LeadIntakes', 'idx_leadintakes_callback_reminder_at');
    await queryInterface.removeColumn('LeadIntakes', 'callback_reminder_notified_at');
    await queryInterface.removeColumn('LeadIntakes', 'callback_reminder_job_id');
    await queryInterface.removeColumn('LeadIntakes', 'callback_reminder_created_by');
    await queryInterface.removeColumn('LeadIntakes', 'callback_reminder_notes');
    await queryInterface.removeColumn('LeadIntakes', 'callback_reminder_reason');
    await queryInterface.removeColumn('LeadIntakes', 'callback_reminder_at');
  },
};
