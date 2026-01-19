'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('ClinicaEspecialidades', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      id_clinica: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Clinicas', key: 'id_clinica' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      id_especialidad_sistema: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'EspecialidadesMedicasSistema', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      id_especialidad_clinica: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'EspecialidadesMedicasClinica', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      origen: {
        type: Sequelize.ENUM('sistema', 'clinica'),
        allowNull: false
      },
      createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP') }
    });
    await queryInterface.addIndex('ClinicaEspecialidades', ['id_clinica']);
    await queryInterface.addIndex('ClinicaEspecialidades', ['id_especialidad_sistema']);
    await queryInterface.addIndex('ClinicaEspecialidades', ['id_especialidad_clinica']);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeIndex('ClinicaEspecialidades', ['id_especialidad_clinica']);
    await queryInterface.removeIndex('ClinicaEspecialidades', ['id_especialidad_sistema']);
    await queryInterface.removeIndex('ClinicaEspecialidades', ['id_clinica']);
    await queryInterface.dropTable('ClinicaEspecialidades');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_ClinicaEspecialidades_origen";');
  }
};
