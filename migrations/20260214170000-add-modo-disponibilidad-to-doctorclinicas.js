'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Transicional: persistimos "modo_disponibilidad" en DoctorClinicas
    // (alias semantico PersonalClinica). El valor se valida en backend.
    const table = 'DoctorClinicas';

    const [rows] = await queryInterface.sequelize.query(`SHOW COLUMNS FROM \`${table}\` LIKE 'modo_disponibilidad'`);
    if (Array.isArray(rows) && rows.length > 0) {
      return;
    }

    await queryInterface.addColumn(table, 'modo_disponibilidad', {
      type: Sequelize.STRING(16),
      allowNull: false,
      defaultValue: 'avanzado',
    });
  },

  async down(queryInterface) {
    const table = 'DoctorClinicas';
    const [rows] = await queryInterface.sequelize.query(`SHOW COLUMNS FROM \`${table}\` LIKE 'modo_disponibilidad'`);
    if (!Array.isArray(rows) || rows.length === 0) {
      return;
    }

    await queryInterface.removeColumn(table, 'modo_disponibilidad');
  },
};

