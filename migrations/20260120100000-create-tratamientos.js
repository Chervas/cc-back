'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('Tratamientos', {
      id_tratamiento: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false
      },
      nombre: {
        type: Sequelize.STRING(255),
        allowNull: false
      },
      descripcion: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      disciplina: {
        type: Sequelize.STRING(50),
        allowNull: false
      },
      categoria: {
        type: Sequelize.STRING(100),
        allowNull: true
      },
      duracion_min: {
        type: Sequelize.INTEGER,
        allowNull: true
      },
      precio_base: {
        type: Sequelize.DECIMAL(10, 2),
        allowNull: true,
        defaultValue: 0
      },
      color: {
        type: Sequelize.STRING(20),
        allowNull: true
      },
      activo: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true
      },
      clinica_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Clinicas', key: 'id_clinica' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      grupo_clinica_id: {
        type: Sequelize.INTEGER,
        allowNull: true
        // Se puede referenciar a GruposClinicas si se requiere más adelante
      },
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP')
      }
    });

    await queryInterface.addIndex('Tratamientos', ['clinica_id']);
    await queryInterface.addIndex('Tratamientos', ['disciplina']);
    await queryInterface.addIndex('Tratamientos', ['categoria']);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeIndex('Tratamientos', ['categoria']);
    await queryInterface.removeIndex('Tratamientos', ['disciplina']);
    await queryInterface.removeIndex('Tratamientos', ['clinica_id']);
    await queryInterface.dropTable('Tratamientos');
  }
};
