'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('EspecialidadesMedicasSistema', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      nombre: { type: Sequelize.STRING(100), allowNull: false },
      disciplina: { type: Sequelize.STRING(50), allowNull: false },
      activo: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP') }
    });

    await queryInterface.createTable('EspecialidadesMedicasClinica', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      id_clinica: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Clinicas', key: 'id_clinica' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      nombre: { type: Sequelize.STRING(100), allowNull: false },
      disciplina: { type: Sequelize.STRING(50), allowNull: false },
      activo: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP') }
    });
    await queryInterface.addIndex('EspecialidadesMedicasClinica', ['id_clinica', 'nombre'], { unique: true });

    await queryInterface.createTable('UsuarioEspecialidades', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      id_usuario: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Usuarios', key: 'id_usuario' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      id_especialidad_sistema: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'EspecialidadesMedicasSistema', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      id_especialidad_clinica: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'EspecialidadesMedicasClinica', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP') }
    });
    await queryInterface.addIndex('UsuarioEspecialidades', ['id_usuario']);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeIndex('UsuarioEspecialidades', ['id_usuario']);
    await queryInterface.dropTable('UsuarioEspecialidades');
    await queryInterface.removeIndex('EspecialidadesMedicasClinica', ['id_clinica', 'nombre']);
    await queryInterface.dropTable('EspecialidadesMedicasClinica');
    await queryInterface.dropTable('EspecialidadesMedicasSistema');
  }
};
