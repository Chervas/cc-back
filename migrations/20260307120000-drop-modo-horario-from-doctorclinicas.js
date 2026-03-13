'use strict';

/**
 * Hard cut del eje `modo_horario`.
 * El horario por clínica pasa a ser siempre explícito/personalizado.
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    const table = 'DoctorClinicas';

    const [hasModoHorario] = await queryInterface.sequelize.query(
      `SHOW COLUMNS FROM \`${table}\` LIKE 'modo_horario'`
    );

    if (Array.isArray(hasModoHorario) && hasModoHorario.length > 0) {
      await queryInterface.removeColumn(table, 'modo_horario');
    }
  },

  async down(queryInterface, Sequelize) {
    const table = 'DoctorClinicas';

    const [hasModoHorario] = await queryInterface.sequelize.query(
      `SHOW COLUMNS FROM \`${table}\` LIKE 'modo_horario'`
    );

    if (!Array.isArray(hasModoHorario) || hasModoHorario.length === 0) {
      await queryInterface.addColumn(table, 'modo_horario', {
        type: Sequelize.STRING(32),
        allowNull: false,
        defaultValue: 'citas_personalizadas',
      });
    }
  },
};
