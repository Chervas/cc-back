'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('LeadIntakes', 'call_initiated', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false
    });

    await queryInterface.addColumn('LeadIntakes', 'call_initiated_at', {
      type: Sequelize.DATE,
      allowNull: true
    });

    await queryInterface.addColumn('LeadIntakes', 'call_outcome', {
      type: Sequelize.ENUM('citado', 'informacion', 'no_contactado'),
      allowNull: true
    });

    await queryInterface.addColumn('LeadIntakes', 'call_outcome_at', {
      type: Sequelize.DATE,
      allowNull: true
    });

    await queryInterface.addColumn('LeadIntakes', 'call_outcome_notes', {
      type: Sequelize.TEXT,
      allowNull: true
    });

    await queryInterface.addColumn('LeadIntakes', 'call_outcome_appointment_id', {
      type: Sequelize.INTEGER,
      allowNull: true
    });

    await queryInterface.addIndex('LeadIntakes', {
      name: 'idx_leadintakes_call_initiated',
      fields: ['call_initiated', 'call_initiated_at']
    });

    await queryInterface.addIndex('LeadIntakes', {
      name: 'idx_leadintakes_call_outcome',
      fields: ['call_outcome', 'call_outcome_at']
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeIndex('LeadIntakes', 'idx_leadintakes_call_outcome');
    await queryInterface.removeIndex('LeadIntakes', 'idx_leadintakes_call_initiated');

    await queryInterface.removeColumn('LeadIntakes', 'call_outcome_appointment_id');
    await queryInterface.removeColumn('LeadIntakes', 'call_outcome_notes');
    await queryInterface.removeColumn('LeadIntakes', 'call_outcome_at');
    await queryInterface.removeColumn('LeadIntakes', 'call_outcome');
    await queryInterface.removeColumn('LeadIntakes', 'call_initiated_at');
    await queryInterface.removeColumn('LeadIntakes', 'call_initiated');

    // En MySQL no aplica DROP TYPE. En PG sí, pero este entorno usa MySQL.
    if (queryInterface.sequelize.getDialect() === 'postgres') {
      await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_LeadIntakes_call_outcome";');
    }
  }
};

