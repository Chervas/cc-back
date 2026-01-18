'use strict';

/**
 * Tabla de vínculo Paciente ↔ Clínica para permitir que un paciente
 * esté asociado a varias clínicas del mismo grupo sin duplicar la ficha.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('PacienteClinicas', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false
      },
      paciente_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'Pacientes',
          key: 'id_paciente'
        },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE'
      },
      clinica_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'Clinicas',
          key: 'id_clinica'
        },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE'
      },
      es_principal: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false
      },
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
      }
    });

    // Un paciente solo puede estar una vez por clínica
    await queryInterface.addConstraint('PacienteClinicas', {
      fields: ['paciente_id', 'clinica_id'],
      type: 'unique',
      name: 'unique_paciente_clinica'
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('PacienteClinicas');
  }
};
