'use strict';
const { DataTypes: D } = require('sequelize');
const TABLE = 'MedicalAreaAdoptions';
module.exports = {
  async up(qi) {
    if (!(await qi.showAllTables()).includes(TABLE)) await qi.createTable(TABLE, {
      id: { type: D.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      clinic_id: { type: D.INTEGER, allowNull: false, references: { model: 'Clinicas', key: 'id_clinica' }, onDelete: 'RESTRICT' },
      code: { type: D.STRING(80), allowNull: false },
      previous_revision_id: { type: D.INTEGER, allowNull: true },
      revision_id: { type: D.INTEGER, allowNull: false, references: { model: 'MedicalAreaContractRevisions', key: 'id' }, onDelete: 'RESTRICT' },
      actor_id: { type: D.INTEGER, allowNull: false },
      review_hash: { type: D.STRING(64), allowNull: false },
      review_json: { type: D.JSON, allowNull: false },
      reason: { type: D.STRING(500), allowNull: false },
      created_at: { type: D.DATE, allowNull: false },
    });
    if (!(await qi.showIndex(TABLE)).some(i => i.name === 'medical_area_adoption_clinic_code')) {
      await qi.addIndex(TABLE, ['clinic_id', 'code', 'id'], { name: 'medical_area_adoption_clinic_code' });
    }
  },
  async down() { throw Error('Preserve medical area adoption history; use a forward repair'); },
};
