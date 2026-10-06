'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('DoctorClinicas', 'agenda_flexible', {
      type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false,
    });
  },
  async down(queryInterface) {
    await queryInterface.removeColumn('DoctorClinicas', 'agenda_flexible');
  },
};
