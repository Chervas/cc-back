'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Migrar configuracion.disciplina -> configuracion.disciplinas (array) donde aplique
    // Sólo toca filas con configuracion JSON y clave "disciplina" definida.
    await queryInterface.sequelize.query(`
      UPDATE Clinicas
      SET configuracion = JSON_REMOVE(
        JSON_SET(
          IFNULL(configuracion, JSON_OBJECT()),
          '$.disciplinas',
          JSON_ARRAY(JSON_EXTRACT(configuracion, '$.disciplina'))
        ),
        '$.disciplina'
      )
      WHERE JSON_EXTRACT(configuracion, '$.disciplina') IS NOT NULL
        AND JSON_EXTRACT(configuracion, '$.disciplinas') IS NULL;
    `);
  },

  async down(queryInterface, Sequelize) {
    // No revertimos para no perder información si se agregaron múltiples disciplinas
  }
};
