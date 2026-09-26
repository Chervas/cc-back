'use strict';

const { DataTypes: D } = require('sequelize');
const definitions = require('../src/lib/medical-area-contracts');
const { contractHash, assertUnits } = require('../src/services/medicalAreaContracts.service');
const REVISIONS = 'MedicalAreaContractRevisions';
const PINS = 'ClinicMedicalAreaContracts';

module.exports = {
  async up(qi) {
    const tables = await qi.showAllTables();
    if (!tables.includes(REVISIONS)) {
      await qi.createTable(REVISIONS, {
        id: { type: D.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
        code: { type: D.STRING(80), allowNull: false },
        revision_number: { type: D.INTEGER, allowNull: false },
        contract_json: { type: D.JSON, allowNull: false },
        content_hash: { type: D.STRING(64), allowNull: false },
        created_by: { type: D.INTEGER, allowNull: true },
        created_at: { type: D.DATE, allowNull: false },
      });
    }
    if (!(await qi.showIndex(REVISIONS)).some(i => i.name === 'medical_area_revision_code_number')) {
      await qi.addIndex(REVISIONS, ['code', 'revision_number'], { name: 'medical_area_revision_code_number', unique: true });
    }
    if (!tables.includes(PINS)) {
      await qi.createTable(PINS, {
        id: { type: D.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
        clinic_id: { type: D.INTEGER, allowNull: false, references: { model: 'Clinicas', key: 'id_clinica' }, onDelete: 'RESTRICT' },
        code: { type: D.STRING(80), allowNull: false },
        revision_id: { type: D.INTEGER, allowNull: false, references: { model: REVISIONS, key: 'id' }, onDelete: 'RESTRICT' },
        previous_revision_id: { type: D.INTEGER, allowNull: true, references: { model: REVISIONS, key: 'id' }, onDelete: 'RESTRICT' },
        updated_by: { type: D.INTEGER, allowNull: true },
        created_at: { type: D.DATE, allowNull: false },
        updated_at: { type: D.DATE, allowNull: false },
      });
    }
    if (!(await qi.showIndex(PINS)).some(i => i.name === 'medical_area_clinic_code')) {
      await qi.addIndex(PINS, ['clinic_id', 'code'], { name: 'medical_area_clinic_code', unique: true });
    }
    if (!(await qi.describeTable('MedicalAreaContracts')).revision_id) {
      await qi.addColumn('MedicalAreaContracts', 'revision_id', {
        type: D.INTEGER, allowNull: true, references: { model: REVISIONS, key: 'id' }, onDelete: 'RESTRICT',
      });
    }
    if (!(await qi.describeTable('PatientNutritionMeasurements')).area_contract_revision_id) {
      await qi.addColumn('PatientNutritionMeasurements', 'area_contract_revision_id', {
        type: D.INTEGER, allowNull: true,
      });
    }
    if (!(await qi.getForeignKeyReferencesForTable('PatientNutritionMeasurements')).some(fk => fk.constraintName === 'nutrition_area_revision_fk')) {
      await qi.addConstraint('PatientNutritionMeasurements', {
        fields: ['area_contract_revision_id'], type: 'foreign key', name: 'nutrition_area_revision_fk',
        references: { table: REVISIONS, field: 'id' }, onDelete: 'RESTRICT',
      });
    }

    // MySQL DDL commits separately. All initialization DML is atomic and can be
    // rerun after a interrupted DDL step without overwriting any published pin.
    await qi.sequelize.transaction(async transaction => {
      const [clinics] = await qi.sequelize.query('SELECT id_clinica FROM Clinicas ORDER BY id_clinica FOR UPDATE', { transaction });
      const [heads] = await qi.sequelize.query('SELECT * FROM MedicalAreaContracts ORDER BY code FOR UPDATE', { transaction });
      const byCode = new Map(heads.map(h => [h.code, h]));
      const codes = new Set([...definitions.getKnownCodes(), ...heads.filter(h => h.active).map(h => h.code)]);
      const now = new Date();
      for (const code of [...codes].sort()) {
        const head = byCode.get(code);
        const [existing] = await qi.sequelize.query('SELECT id, created_by FROM MedicalAreaContractRevisions WHERE code = :code AND revision_number = 1', {
          replacements: { code }, transaction,
        });
        let baseline = existing[0]?.id;
        const isInitialSnapshot = !existing.length || existing[0].created_by == null;
        if (!baseline) {
          const override = head?.active ? definitions.parseStoredContract(head.contract_json) : null;
          if (head?.active && (!override || Array.isArray(override) || (override.code && override.code !== code))) {
            throw Error('medical_area_invalid_legacy_contract:' + code);
          }
          assertUnits(code, override);
          const contract = definitions.mergeContract(definitions.getBaseContractForArea(code), override);
          await qi.bulkInsert(REVISIONS, [{ code, revision_number: 1, contract_json: JSON.stringify(contract),
            content_hash: contractHash(contract), created_by: null, created_at: now }], { transaction });
          const [inserted] = await qi.sequelize.query('SELECT id FROM MedicalAreaContractRevisions WHERE code = :code AND revision_number = 1', {
            replacements: { code }, transaction,
          });
          baseline = inserted[0].id;
          if (!head) await qi.bulkInsert('MedicalAreaContracts', [{ code, contract_json: JSON.stringify(contract),
            version: 'revision-1', active: true, updated_by: null, revision_id: baseline, created_at: now, updated_at: now }], { transaction });
        }
        // A rerun must never reset a subsequently published system head.
        if (head && !head.revision_id) await qi.bulkUpdate('MedicalAreaContracts', { revision_id: baseline, active: true }, { id: head.id }, { transaction });
        // A custom area first published after this cut is not a migration
        // baseline. Replaying DDL must not silently adopt it for old clinics.
        for (const clinic of isInitialSnapshot ? clinics : []) {
          await qi.sequelize.query(`INSERT INTO ClinicMedicalAreaContracts
            (clinic_id, code, revision_id, created_at, updated_at)
            SELECT :clinic, :code, :revision, :now, :now FROM DUAL
            WHERE NOT EXISTS (SELECT 1 FROM ClinicMedicalAreaContracts WHERE clinic_id = :clinic AND code = :code)`, {
            replacements: { clinic: clinic.id_clinica, code, revision: baseline, now }, transaction,
          });
        }
      }
    });
  },
  async down() {
    // Published revisions can be referenced by historical clinical snapshots.
    // Roll back application code, not these rows or their foreign keys.
    throw Error('Preserve medical area revisions and clinic assignments; use a forward repair');
  },
};
