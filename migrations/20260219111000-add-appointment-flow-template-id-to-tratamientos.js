'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('Tratamientos', 'appointment_flow_template_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: {
        model: 'AppointmentFlowTemplates',
        key: 'id',
      },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    });

    await queryInterface.addIndex('Tratamientos', ['appointment_flow_template_id']);
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('Tratamientos', ['appointment_flow_template_id']);
    await queryInterface.removeColumn('Tratamientos', 'appointment_flow_template_id');
  },
};
