'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.changeColumn('Pacientes', 'telefono_movil', {
      type: Sequelize.STRING,
      allowNull: true
    });
  },

  async down(queryInterface, Sequelize) {
    // WARNING: If there are nulls this will fail; best-effort to align with the previous constraint.
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(
        'UPDATE `Pacientes` SET `telefono_movil` = "" WHERE `telefono_movil` IS NULL',
        { transaction }
      );
      await queryInterface.changeColumn('Pacientes', 'telefono_movil', {
        type: Sequelize.STRING,
        allowNull: false
      }, { transaction });
    });
  }
};
