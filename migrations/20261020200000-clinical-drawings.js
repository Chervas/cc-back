'use strict';
module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = (await queryInterface.showAllTables()).map(item => typeof item === 'string' ? item : item.tableName || item.table_name);
    if (!tables.includes('ClinicalDrawings')) await queryInterface.createTable('ClinicalDrawings', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      public_id: { type: Sequelize.STRING(36), allowNull: false, unique: true },
      clinic_id: { type: Sequelize.INTEGER, allowNull: false, references: { model: 'Clinicas', key: 'id_clinica' }, onDelete: 'RESTRICT' },
      patient_id: { type: Sequelize.INTEGER, allowNull: false, references: { model: 'Pacientes', key: 'id_paciente' }, onDelete: 'RESTRICT' },
      source_asset_id: { type: Sequelize.INTEGER, allowNull: true, references: { model: 'ClinicalPrivateAssets', key: 'id' }, onDelete: 'RESTRICT' },
      template_key: { type: Sequelize.STRING(24), allowNull: false },
      template_version: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
      title: { type: Sequelize.STRING(180), allowNull: false },
      document: { type: Sequelize.JSON, allowNull: false },
      version_number: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
      status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'active' },
      idempotency_key: { type: Sequelize.STRING(80), allowNull: false },
      creation_hash: { type: Sequelize.STRING(64), allowNull: false },
      created_by: { type: Sequelize.INTEGER, allowNull: false }, updated_by: { type: Sequelize.INTEGER, allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false }, updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    const addIndex = async (table, fields, name, unique = false) => {
      if (!(await queryInterface.showIndex(table)).some(index => index.name === name)) await queryInterface.addIndex(table, fields, { name, unique });
    };
    await addIndex('ClinicalDrawings', ['clinic_id', 'patient_id', 'idempotency_key'], 'clinical_drawings_creation_once', true);
    await addIndex('ClinicalDrawings', ['clinic_id', 'patient_id', 'updated_at', 'id'], 'clinical_drawings_patient_history');
    if (!tables.includes('ClinicalDrawingRevisions')) await queryInterface.createTable('ClinicalDrawingRevisions', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      drawing_id: { type: Sequelize.BIGINT.UNSIGNED, allowNull: false, references: { model: 'ClinicalDrawings', key: 'id' }, onDelete: 'RESTRICT' },
      version_number: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false },
      snapshot: { type: Sequelize.JSON, allowNull: false },
      actor_id: { type: Sequelize.INTEGER, allowNull: false }, change_type: { type: Sequelize.STRING(20), allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
    });
    await addIndex('ClinicalDrawingRevisions', ['drawing_id', 'version_number'], 'clinical_drawing_revision_once', true);
  },
  async down(queryInterface) {
    const [rows] = await queryInterface.sequelize.query('SELECT (SELECT COUNT(*) FROM ClinicalDrawings) + (SELECT COUNT(*) FROM ClinicalDrawingRevisions) AS retained');
    if (Number(rows[0]?.retained)) throw new Error('Refusing to remove clinical drawings or their retained revisions. Roll back code instead.');
    await queryInterface.dropTable('ClinicalDrawingRevisions');
    await queryInterface.dropTable('ClinicalDrawings');
  },
};
