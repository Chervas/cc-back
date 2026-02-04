'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('DoctorClinicas', {
      id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true },
      doctor_id: { type: Sequelize.INTEGER, allowNull: false },
      clinica_id: { type: Sequelize.INTEGER, allowNull: false },
      rol_en_clinica: { type: Sequelize.STRING(64), allowNull: true },
      activo: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      created_at: { allowNull: false, type: Sequelize.DATE, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { allowNull: false, type: Sequelize.DATE, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP') }
    });

    await queryInterface.createTable('DoctorHorarios', {
      id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true },
      doctor_clinica_id: { type: Sequelize.INTEGER, allowNull: false, references: { model: 'DoctorClinicas', key: 'id' }, onDelete: 'CASCADE' },
      dia_semana: { type: Sequelize.INTEGER, allowNull: false },
      activo: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      hora_inicio: { type: Sequelize.STRING(5), allowNull: false },
      hora_fin: { type: Sequelize.STRING(5), allowNull: false },
      created_at: { allowNull: false, type: Sequelize.DATE, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { allowNull: false, type: Sequelize.DATE, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP') }
    });

    await queryInterface.createTable('DoctorBloqueos', {
      id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true },
      doctor_id: { type: Sequelize.INTEGER, allowNull: false },
      fecha_inicio: { type: Sequelize.DATE, allowNull: false },
      fecha_fin: { type: Sequelize.DATE, allowNull: false },
      motivo: { type: Sequelize.STRING(255), allowNull: true },
      recurrente: { type: Sequelize.ENUM('none','daily','weekly','monthly'), allowNull: false, defaultValue: 'none' },
      aplica_a_todas_clinicas: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      creado_por: { type: Sequelize.INTEGER, allowNull: true },
      created_at: { allowNull: false, type: Sequelize.DATE, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { allowNull: false, type: Sequelize.DATE, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP') }
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('DoctorBloqueos');
    await queryInterface.dropTable('DoctorHorarios');
    await queryInterface.dropTable('DoctorClinicas');
  }
};
