'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('Pacientes', 'numero_historia', { type: Sequelize.STRING(32), allowNull: true });
    await queryInterface.addColumn('Pacientes', 'historia_scope', { type: Sequelize.STRING(64), allowNull: true });
    await queryInterface.addColumn('Pacientes', 'notas_paciente', { type: Sequelize.TEXT, allowNull: true });
    await queryInterface.addIndex('Pacientes', ['historia_scope', 'numero_historia'], {
      name: 'pacientes_historia_scope_numero_unique', unique: true,
    });
    await queryInterface.addIndex('Pacientes', ['numero_historia'], { name: 'pacientes_numero_historia_search' });
    await queryInterface.createTable('PatientHistoryCounters', {
      scope_key: { type: Sequelize.STRING(64), primaryKey: true, allowNull: false },
      next_number: { type: Sequelize.BIGINT.UNSIGNED, allowNull: false, defaultValue: 1 },
    });
  },
  async down(queryInterface) {
    await queryInterface.dropTable('PatientHistoryCounters');
    await queryInterface.removeIndex('Pacientes', 'pacientes_numero_historia_search');
    await queryInterface.removeIndex('Pacientes', 'pacientes_historia_scope_numero_unique');
    for (const column of ['notas_paciente', 'historia_scope', 'numero_historia']) await queryInterface.removeColumn('Pacientes', column);
  },
};
