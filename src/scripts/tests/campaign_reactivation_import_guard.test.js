'use strict';

const assert = require('node:assert/strict');

const db = require('../../../models');
const service = require('../../services/marketingReactivation.service');

async function main() {
  const freeText = [
    'la paciente llama a nou barris y comenta que no quiere visitarse más en encants.',
    'Indica que desea hablar con dirección antes de volver a la clínica y añade varias',
    'observaciones personales que no describen un tratamiento clínico del catálogo.',
    'Este contenido procede de una celda libre exportada por el sistema anterior.',
  ].join(' ');

  assert(freeText.length > 255);

  const prepared = service._test.prepareImportedTreatmentValue(freeText);
  assert.equal(prepared.canCreateCatalogEntry, false);
  assert.equal(prepared.storageName.length, 255);
  assert.equal(prepared.normalized, freeText);

  let lookupCalled = false;
  const result = await service._test.resolveImportedTreatment(freeText, {
    treatmentMappings: new Map(),
    treatmentsById: new Map(),
    treatmentsByKey: new Map(),
    treatmentsByCode: new Map(),
    defaultClinicId: 89,
    transaction: null,
  }, {
    createIfMissing: true,
    findExistingImportedTreatment: async () => {
      lookupCalled = true;
      return null;
    },
  });

  assert.equal(lookupCalled, false);
  assert.deepEqual(result, {
    id: null,
    name: null,
  });

  console.log('campaign_reactivation_import_guard.test.js: OK');
}

(async () => {
  let exitCode = 0;
  try {
    await main();
  } catch (error) {
    console.error(error);
    exitCode = 1;
  }

  try {
    await db.sequelize.close();
  } catch (error) {
    console.error(error);
    exitCode = 1;
  }

  process.exit(exitCode);
})();
