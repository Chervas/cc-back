'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const nutritionSpecialties = [
      'Nutrición clínica',
      'Nutrición deportiva',
      'Nutrición digestiva',
      'Antropometría avanzada'
    ];
    const existingRows = await queryInterface.sequelize.query(
      `SELECT nombre
       FROM EspecialidadesMedicasSistema
       WHERE disciplina = 'nutricion'`,
      { type: Sequelize.QueryTypes.SELECT }
    );
    const existingNames = new Set(existingRows.map((row) => row.nombre));
    const now = new Date();
    const missingRows = nutritionSpecialties
      .filter((nombre) => !existingNames.has(nombre))
      .map((nombre) => ({
        nombre,
        disciplina: 'nutricion',
        activo: true,
        createdAt: now,
        updatedAt: now
      }));

    if (missingRows.length > 0) {
      await queryInterface.bulkInsert('EspecialidadesMedicasSistema', missingRows);
    }
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.bulkDelete('EspecialidadesMedicasSistema', {
      disciplina: 'nutricion',
      nombre: {
        [Sequelize.Op.in]: [
          'Nutrición clínica',
          'Nutrición deportiva',
          'Nutrición digestiva',
          'Antropometría avanzada'
        ]
      }
    });
  }
};
