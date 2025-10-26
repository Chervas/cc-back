'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const [results] = await queryInterface.sequelize.query(
      "SHOW COLUMNS FROM `Usuarios` LIKE 'ultimo_login';"
    );

    if (!results.length) {
      await queryInterface.addColumn('Usuarios', 'ultimo_login', {
        type: Sequelize.DATE,
        allowNull: true,
        defaultValue: null
      });
    }
  },

  async down(queryInterface) {
    const [results] = await queryInterface.sequelize.query(
      "SHOW COLUMNS FROM `Usuarios` LIKE 'ultimo_login';"
    );

    if (results.length) {
      await queryInterface.removeColumn('Usuarios', 'ultimo_login');
    }
  }
};
