'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('LeadIntakes', 'notas_internas', {
      type: Sequelize.TEXT,
      allowNull: true,
      after: 'notas'
    });
    await queryInterface.addColumn('LeadIntakes', 'asignado_a', {
      type: Sequelize.INTEGER,
      allowNull: true,
      after: 'notas_internas'
    });
    await queryInterface.addColumn('LeadIntakes', 'motivo_descarte', {
      type: Sequelize.STRING(512),
      allowNull: true,
      after: 'asignado_a'
    });
    await queryInterface.addIndex('LeadIntakes', { name: 'idx_leadintakes_asignado', fields: ['asignado_a'] });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('LeadIntakes', 'idx_leadintakes_asignado');
    await queryInterface.removeColumn('LeadIntakes', 'motivo_descarte');
    await queryInterface.removeColumn('LeadIntakes', 'asignado_a');
    await queryInterface.removeColumn('LeadIntakes', 'notas_internas');
  }
};
