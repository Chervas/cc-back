'use strict';
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('Pacientes', {
      id_paciente: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false
      },
      nombre: {
        type: Sequelize.STRING,
        allowNull: false
      },
      apellidos: {
        type: Sequelize.STRING,
        allowNull: false
      },
      dni: {
        type: Sequelize.STRING,
        allowNull: true
      },
      telefono_movil: {
        type: Sequelize.STRING,
        allowNull: false
      },
      email: {
        type: Sequelize.STRING,
        allowNull: true
      },
      telefono_secundario: {
        type: Sequelize.STRING,
        allowNull: true
      },
      foto: {
        type: Sequelize.STRING,
        allowNull: true
      },
      fecha_nacimiento: {
        type: Sequelize.DATE,
        allowNull: true
      },
      edad: {
        type: Sequelize.INTEGER,
        allowNull: true
      },
      estatura: {
        type: Sequelize.FLOAT,
        allowNull: true
      },
      peso: {
        type: Sequelize.FLOAT,
        allowNull: true
      },
      sexo: {
        type: Sequelize.STRING,
        allowNull: true
      },
      profesion: {
        type: Sequelize.STRING,
        allowNull: true
      },
      fecha_alta: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.fn('NOW')
      },
      fecha_baja: {
        type: Sequelize.DATE,
        allowNull: true
      },
      alergias: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      antecedentes: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      medicacion: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      paciente_conocido: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false
      },
      como_nos_conocio: {
        type: Sequelize.ENUM('redes sociales', 'buscadores', 'recomendación', 'otros'),
        allowNull: true
      },
      procedencia: {
        type: Sequelize.INTEGER,
        allowNull: true
      },
      clinica_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'Clinicas',
          key: 'id_clinica'
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.fn('NOW')
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.fn('NOW')
      }
    });
  },
  down: async (queryInterface, Sequelize) => {
    await queryInterface.dropTable('Pacientes');
  }
};
