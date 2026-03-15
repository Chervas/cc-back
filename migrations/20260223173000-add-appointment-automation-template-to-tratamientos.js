'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('Tratamientos', 'appointment_automation_template_key', {
      type: Sequelize.STRING(120),
      allowNull: true,
    });

    await queryInterface.addColumn('Tratamientos', 'appointment_automation_template_version', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });

    await queryInterface.addIndex('Tratamientos', ['appointment_automation_template_key'], {
      name: 'idx_tratamientos_appointment_automation_template_key',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('Tratamientos', 'idx_tratamientos_appointment_automation_template_key');
    await queryInterface.removeColumn('Tratamientos', 'appointment_automation_template_version');
    await queryInterface.removeColumn('Tratamientos', 'appointment_automation_template_key');
  },
};
