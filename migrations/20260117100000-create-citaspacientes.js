'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('CitasPacientes', {
      id_cita: { type: Sequelize.INTEGER, allowNull: false, autoIncrement: true, primaryKey: true },
      clinica_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Clinicas', key: 'id_clinica' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      paciente_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Pacientes', key: 'id_paciente' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      lead_intake_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'LeadIntakes', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      doctor_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Usuarios', key: 'id_usuario' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      instalacion_id: { type: Sequelize.INTEGER, allowNull: true },
      tratamiento_id: { type: Sequelize.INTEGER, allowNull: true },
      campana_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        // En BD la PK de Campanas es id_campana (no id)
        references: { model: 'Campanas', key: 'id_campana' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      titulo: { type: Sequelize.STRING(255), allowNull: true },
      nota: { type: Sequelize.TEXT, allowNull: true },
      motivo: { type: Sequelize.STRING(255), allowNull: true },
      estado: {
        type: Sequelize.ENUM('pendiente', 'confirmada', 'cancelada'),
        allowNull: false,
        defaultValue: 'pendiente'
      },
      inicio: { type: Sequelize.DATE, allowNull: false },
      fin: { type: Sequelize.DATE, allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
    });

    await queryInterface.addIndex('CitasPacientes', { name: 'idx_citaspacientes_clinica_inicio', fields: ['clinica_id', 'inicio'] });
    await queryInterface.addIndex('CitasPacientes', { name: 'idx_citaspacientes_lead', fields: ['lead_intake_id'] });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeIndex('CitasPacientes', 'idx_citaspacientes_lead');
    await queryInterface.removeIndex('CitasPacientes', 'idx_citaspacientes_clinica_inicio');
    await queryInterface.dropTable('CitasPacientes');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_CitasPacientes_estado";');
  }
};
