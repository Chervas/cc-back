'use strict';

/**
 * Añade disciplina_codes a ChatFlowTemplates para poder activar plantillas
 * por sector/disciplinas (además de "general").
 *
 * Nota:
 * - Se guarda como JSON array de strings (['dental','estetica',...]).
 * - null o [] => visible para todas las clínicas.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('ChatFlowTemplates', 'disciplina_codes', {
      type: Sequelize.JSON,
      allowNull: true,
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('ChatFlowTemplates', 'disciplina_codes');
  },
};

