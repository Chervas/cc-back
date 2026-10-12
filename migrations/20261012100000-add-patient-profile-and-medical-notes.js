'use strict';

const {
  PATIENT_PROFILE_FIELD_SPECS,
  PATIENT_PROFILE_FIELD_NAMES,
  patientProfileAttributes,
} = require('../src/lib/patient-profile-fields');

const TABLE = 'Pacientes';

function isCompatible(field, column) {
  const spec = PATIENT_PROFILE_FIELD_SPECS[field];
  const type = String(column?.type || '').toUpperCase().replace(/\s+/g, '');
  const expectedType = spec.kind === 'boolean' ? /^(?:BOOLEAN|BOOL|TINYINT\(1\))$/
    : spec.kind === 'text' ? /^TEXT$/ : new RegExp(`^VARCHAR\\(${spec.maxLength}\\)$`);
  return !!column && column.allowNull === true && column.defaultValue == null && expectedType.test(type);
}

function assertCompatibleExistingColumns(definition) {
  for (const field of PATIENT_PROFILE_FIELD_NAMES) {
    if (Object.hasOwn(definition, field) && !isCompatible(field, definition[field])) {
      throw new Error(`patient_profile_schema_conflict:${field}`);
    }
  }
}

module.exports = {
  async up(queryInterface, Sequelize) {
    const columns = patientProfileAttributes(Sequelize);
    // Validate all existing fields before the first DDL operation. A partially
    // applied migration can resume, but never silently alters someone else's
    // existing column, NULL contract, default, or saved patient values.
    assertCompatibleExistingColumns(await queryInterface.describeTable(TABLE));
    for (const field of PATIENT_PROFILE_FIELD_NAMES) {
      const current = await queryInterface.describeTable(TABLE);
      assertCompatibleExistingColumns(current);
      if (Object.hasOwn(current, field)) continue;
      try {
        await queryInterface.addColumn(TABLE, field, columns[field]);
      } catch (error) {
        // A competing migration may have added the same column. Only the
        // explicit duplicate-column outcome and exact expected schema count
        // as a successful compare-and-check; every other error still fails.
        const code = error?.original?.code || error?.parent?.code || error?.code;
        if (code !== 'ER_DUP_FIELDNAME') throw error;
        const afterRace = await queryInterface.describeTable(TABLE);
        assertCompatibleExistingColumns(afterRace);
        if (!isCompatible(field, afterRace[field])) throw error;
      }
    }
    const finalDefinition = await queryInterface.describeTable(TABLE);
    assertCompatibleExistingColumns(finalDefinition);
    if (PATIENT_PROFILE_FIELD_NAMES.some(field => !isCompatible(field, finalDefinition[field]))) {
      throw new Error('patient_profile_schema_incomplete');
    }
  },

  async down() {
    // Rolling back application code is safe with unused nullable columns.
    // Dropping them would destroy manually entered notes and address data.
    throw new Error('patient_profile_schema_rollback_requires_explicit_data_preservation');
  },
};
