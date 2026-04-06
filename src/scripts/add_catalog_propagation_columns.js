'use strict';

require('dotenv').config();
const db = require('../../models');

async function ensureColumn(table, column, sql) {
  const [rows] = await db.sequelize.query(
    `
      SELECT COLUMN_NAME
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = :table
        AND COLUMN_NAME = :column
      LIMIT 1
    `,
    {
      replacements: { table, column },
    }
  );

  if (Array.isArray(rows) && rows.length > 0) {
    return false;
  }

  await db.sequelize.query(`ALTER TABLE \`${table}\` ADD COLUMN ${sql}`);
  return true;
}

async function main() {
  const changes = [];

  changes.push(
    await ensureColumn(
      'AutomationFlowCatalog',
      'last_propagated_at',
      '`last_propagated_at` DATETIME NULL AFTER `template_version`'
    )
  );
  changes.push(
    await ensureColumn(
      'AutomationFlowCatalog',
      'last_propagated_template_key',
      '`last_propagated_template_key` VARCHAR(120) NULL AFTER `last_propagated_at`'
    )
  );
  changes.push(
    await ensureColumn(
      'AutomationFlowCatalog',
      'last_propagated_template_version',
      '`last_propagated_template_version` INT NULL AFTER `last_propagated_template_key`'
    )
  );

  changes.push(
    await ensureColumn(
      'WhatsappTemplateCatalog',
      'last_propagated_at',
      '`last_propagated_at` DATETIME NULL AFTER `components`'
    )
  );
  changes.push(
    await ensureColumn(
      'WhatsappTemplateCatalog',
      'propagation_state',
      '`propagation_state` VARCHAR(24) NULL AFTER `last_propagated_at`'
    )
  );

  console.log(
    JSON.stringify(
      {
        success: true,
        columns_added: changes.filter(Boolean).length,
      },
      null,
      2
    )
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.sequelize.close();
  });
