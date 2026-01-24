'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.changeColumn('ClinicMetaAssets', 'clinicaId', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: {
        model: 'Clinicas',
        key: 'id_clinica',
      },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.changeColumn('ClinicMetaAssets', 'clinicaId', {
      type: Sequelize.INTEGER,
      allowNull: false,
      references: {
        model: 'Clinicas',
        key: 'id_clinica',
      },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    });
  },
};
