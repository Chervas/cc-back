'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('ClinicaHorarios', {
      id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true },
      clinica_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Clinicas', key: 'id_clinica' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE'
      },
      dia_semana: { type: Sequelize.INTEGER, allowNull: false },
      activo: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      hora_inicio: { type: Sequelize.STRING(5), allowNull: false },
      hora_fin: { type: Sequelize.STRING(5), allowNull: false },
      created_at: { allowNull: false, type: Sequelize.DATE, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { allowNull: false, type: Sequelize.DATE, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP') }
    });

    await queryInterface.addIndex('ClinicaHorarios', ['clinica_id', 'dia_semana'], {
      name: 'idx_clinica_horarios_clinica_dia'
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('ClinicaHorarios', 'idx_clinica_horarios_clinica_dia');
    await queryInterface.dropTable('ClinicaHorarios');
  }
};
