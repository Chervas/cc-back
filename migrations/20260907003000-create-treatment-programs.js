'use strict';

// Definitions only: no purchase, payment, appointment, automation or live import.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('TreatmentPrograms', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true, allowNull: false },
      public_id: { type: Sequelize.STRING(36), allowNull: false, unique: true },
      clinic_id: { type: Sequelize.INTEGER, allowNull: false, references: { model: 'Clinicas', key: 'id_clinica' }, onDelete: 'RESTRICT' },
      name: { type: Sequelize.STRING(255), allowNull: false }, kind: { type: Sequelize.STRING(16), allowNull: false }, status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'draft' },
      total_price: { type: Sequelize.DECIMAL(12, 2), allowNull: true }, notes: { type: Sequelize.TEXT, allowNull: true }, appointments: { type: Sequelize.JSON, allowNull: false },
      version_number: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
      request_key: { type: Sequelize.STRING(64), allowNull: true, unique: true }, request_payload_hash: { type: Sequelize.STRING(64), allowNull: true },
      created_by: { type: Sequelize.INTEGER, allowNull: true }, updated_by: { type: Sequelize.INTEGER, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false }, updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('TreatmentPrograms', ['clinic_id', 'kind', 'status', 'id'], { name: 'treatment_program_clinic_kind_page' });
    await queryInterface.createTable('TreatmentProgramRevisions', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true, allowNull: false },
      program_id: { type: Sequelize.BIGINT.UNSIGNED, allowNull: false, references: { model: 'TreatmentPrograms', key: 'id' }, onDelete: 'RESTRICT' },
      version_number: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false }, snapshot: { type: Sequelize.JSON, allowNull: false }, actor_id: { type: Sequelize.INTEGER, allowNull: true }, created_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('TreatmentProgramRevisions', ['program_id', 'version_number'], { name: 'treatment_program_revision_unique', unique: true });
  },
  async down(queryInterface) {
    const [rows] = await queryInterface.sequelize.query('SELECT COUNT(*) AS count FROM TreatmentPrograms');
    if (Number(rows[0].count)) throw new Error('Hay definiciones de programas: requiere backup y rollback de datos aprobado.');
    await queryInterface.dropTable('TreatmentProgramRevisions');
    await queryInterface.dropTable('TreatmentPrograms');
  },
};
