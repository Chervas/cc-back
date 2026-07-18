'use strict';

const assert = require('node:assert/strict');
const { Sequelize, QueryTypes } = require('sequelize');

async function main() {
  const url = String(process.env.WEB_EDITOR_TEST_MYSQL_URL || '').trim();
  if (!url) {
    console.log('web content/media mysql integration: SKIP (WEB_EDITOR_TEST_MYSQL_URL no configurada)');
    return;
  }
  const sequelize = new Sequelize(url, { logging: false, pool: { max: 1, min: 0 } });
  try {
    await sequelize.authenticate();
    await sequelize.transaction(async (transaction) => {
      await sequelize.query(`
        CREATE TEMPORARY TABLE W3ScopeContract (
          id INT NOT NULL PRIMARY KEY,
          scope_type ENUM('clinic', 'group') NOT NULL,
          clinica_id INT NULL,
          grupo_clinica_id INT NULL,
          CONSTRAINT chk_w3_scope_contract CHECK (
            (scope_type = 'clinic' AND clinica_id IS NOT NULL AND grupo_clinica_id IS NULL)
            OR (scope_type = 'group' AND clinica_id IS NULL AND grupo_clinica_id IS NOT NULL)
          )
        )
      `, { transaction, type: QueryTypes.RAW });
      await sequelize.query(
        "INSERT INTO W3ScopeContract (id, scope_type, clinica_id, grupo_clinica_id) VALUES (1, 'clinic', 66, NULL)",
        { transaction }
      );
      await assert.rejects(
        () => sequelize.query(
          "INSERT INTO W3ScopeContract (id, scope_type, clinica_id, grupo_clinica_id) VALUES (2, 'clinic', NULL, 4)",
          { transaction }
        )
      );
    });
    console.log('web content/media mysql integration: ok');
  } finally {
    await sequelize.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
