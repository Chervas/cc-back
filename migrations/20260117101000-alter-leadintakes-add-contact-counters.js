'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('LeadIntakes', 'num_contactos', {
      type: Sequelize.INTEGER,
      allowNull: false,
      defaultValue: 0
    });

    await queryInterface.addColumn('LeadIntakes', 'ultimo_contacto', {
      type: Sequelize.DATE,
      allowNull: true
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('LeadIntakes', 'num_contactos');
    await queryInterface.removeColumn('LeadIntakes', 'ultimo_contacto');
  }
};
