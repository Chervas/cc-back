'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    // Crear la tabla GruposClinicas
    await queryInterface.createTable('GruposClinicas', {
      id_grupo: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      nombre_grupo: {
        type: Sequelize.STRING,
        allowNull: false,
      }
    });

    // Agregar la columna grupoClinicaId a la tabla Clinicas
    await queryInterface.addColumn('Clinicas', 'grupoClinicaId', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: {
        model: 'GruposClinicas',
        key: 'id_grupo'
      },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL'
    });
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.removeColumn('Clinicas', 'grupoClinicaId');
    await queryInterface.dropTable('GruposClinicas');
  }
};
