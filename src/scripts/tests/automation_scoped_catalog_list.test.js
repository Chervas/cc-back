'use strict';

const assert = require('node:assert/strict');

process.env.JOBS_AUTO_START = 'false';

const controller = require('../../controllers/automationsV2.controller');
const db = require('../../../models');

async function run() {
  const collapse = controller.__collapseCatalogManagedRowsForScopedList;
  const rows = [
    {
      id: 1,
      public_id: 'flw_message_received_after_hours',
      template_key: 'system_message_received_after_hours',
      is_system: true,
      clinic_id: null,
      version: 5,
      published_at: new Date(),
      is_active: false,
    },
    {
      id: 2,
      public_id: 'flw_clinic_after_hours',
      template_key: 'system_message_received_after_hours__clinic_66',
      is_system: false,
      clinic_id: 66,
      version: 4,
      published_at: new Date(),
      is_active: true,
    },
    {
      id: 3,
      public_id: 'flw_unrelated_system',
      template_key: 'unrelated_system_flow',
      is_system: true,
      clinic_id: null,
      version: 1,
      published_at: new Date(),
      is_active: false,
    },
  ];

  assert.deepEqual(
    collapse(rows, true).map((row) => row.id),
    [2],
  );
  assert.deepEqual(
    collapse(rows, false).map((row) => row.id),
    [1, 2, 3],
  );

  const templateModel = db.AutomationFlowTemplateV2;
  const originalFindOne = templateModel.findOne;
  const lookups = [];
  templateModel.findOne = async (options) => {
    lookups.push(options.where);
    return options.where.public_id === 'flw_clinic_after_hours' ? { id: 2 } : null;
  };
  try {
    assert.deepEqual(
      await controller.__resolveTemplateFamilyWhere('flw_clinic_after_hours'),
      { public_id: 'flw_clinic_after_hours' },
    );
    assert.deepEqual(lookups, [{ public_id: 'flw_clinic_after_hours' }]);
  } finally {
    templateModel.findOne = originalFindOne;
  }

  console.log('automation_scoped_catalog_list.test.js OK');
}

run().then(async () => {
  try { await db.sequelize.close(); } catch (_error) {}
  process.exit(0);
}).catch(async (error) => {
  console.error(error);
  try { await db.sequelize.close(); } catch (_error) {}
  process.exit(1);
});
