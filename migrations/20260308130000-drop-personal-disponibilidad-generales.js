'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS `PersonalDisponibilidadGenerales`;');
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.createTable('PersonalDisponibilidadGenerales', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true,
        allowNull: false,
      },
      doctor_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      dia_semana: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      activo: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      hora_inicio: {
        type: Sequelize.TIME,
        allowNull: false,
      },
      hora_fin: {
        type: Sequelize.TIME,
        allowNull: false,
      },
      created_at: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.fn('NOW'),
      },
      updated_at: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.fn('NOW'),
      },
    });

    await queryInterface.addIndex('PersonalDisponibilidadGenerales', ['doctor_id'], {
      name: 'idx_personal_disponibilidad_generales_doctor_id',
    });
    await queryInterface.addIndex('PersonalDisponibilidadGenerales', ['doctor_id', 'dia_semana'], {
      name: 'idx_personal_disponibilidad_generales_doctor_dia',
    });
    await queryInterface.addIndex('PersonalDisponibilidadGenerales', ['doctor_id', 'dia_semana', 'hora_inicio', 'hora_fin'], {
      unique: true,
      name: 'uq_personal_disponibilidad_generales_doctor_dia_horas',
    });
  },
};
