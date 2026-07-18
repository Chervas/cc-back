'use strict';

const assert = require('node:assert/strict');
const Sequelize = require('sequelize');

const editorMigration = require('../../../migrations/20260717190000-create-web-editor-domain');
const publicationMigration = require('../../../migrations/20260717230000-create-web-publication-domain');

function assertIsolatedTestDatabase(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (cause) {
    const error = new Error('WEB_EDITOR_TEST_MYSQL_URL debe ser una URL MySQL válida');
    error.cause = cause;
    throw error;
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, '')).trim();
  if (!['mysql:', 'mysql2:'].includes(parsed.protocol)) {
    throw new Error('WEB_EDITOR_TEST_MYSQL_URL debe usar el protocolo mysql');
  }
  if (!database || !/(?:^|_)test$/i.test(database) || /(?:dev|staging|stage|prod|production)/i.test(database)) {
    throw new Error(
      `Integración destructiva rechazada: ${database || '(sin base)'} no es una base aislada con sufijo _test`
    );
  }
  return { parsed, database };
}

function quoteIdentifier(value) {
  return `\`${String(value).replace(/`/g, '``')}\``;
}

async function foreignKeyRule(sequelize, table, column) {
  const [rows] = await sequelize.query(
    `SELECT rc.UPDATE_RULE AS update_rule, rc.DELETE_RULE AS delete_rule
       FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
       JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc
         ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
        AND rc.TABLE_NAME = kcu.TABLE_NAME
        AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
      WHERE kcu.CONSTRAINT_SCHEMA = DATABASE()
        AND kcu.TABLE_NAME = :table
        AND kcu.COLUMN_NAME = :column`,
    { replacements: { table, column } }
  );
  assert.equal(rows.length, 1, `${table}.${column} debe tener exactamente una FK`);
  return rows[0];
}

async function replaceScopeFkWithLegacyCascade(sequelize, table, column, parentTable, parentColumn) {
  const [rows] = await sequelize.query(
    `SELECT CONSTRAINT_NAME AS constraint_name
       FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
      WHERE CONSTRAINT_SCHEMA = DATABASE()
        AND TABLE_NAME = :table
        AND COLUMN_NAME = :column
        AND REFERENCED_TABLE_NAME IS NOT NULL`,
    { replacements: { table, column } }
  );
  assert.equal(rows.length, 1);
  const currentName = rows[0].constraint_name;
  const checkName = table === 'WebProjects' ? 'chk_web_projects_scope' : 'chk_web_domains_scope';
  await sequelize.query(
    `ALTER TABLE ${quoteIdentifier(table)} DROP CHECK ${quoteIdentifier(checkName)}`
  );
  await sequelize.query([
    `ALTER TABLE ${quoteIdentifier(table)}`,
    `DROP FOREIGN KEY ${quoteIdentifier(currentName)},`,
    `ADD CONSTRAINT ${quoteIdentifier(`legacy_${table.toLowerCase()}_${column}`)}`,
    `FOREIGN KEY (${quoteIdentifier(column)})`,
    `REFERENCES ${quoteIdentifier(parentTable)} (${quoteIdentifier(parentColumn)})`,
    'ON UPDATE CASCADE ON DELETE RESTRICT',
  ].join(' '));
}

async function replaceForeignKeyWithDrift(
  sequelize,
  table,
  column,
  parentTable,
  parentColumn,
  { onUpdate, onDelete }
) {
  const [rows] = await sequelize.query(
    `SELECT CONSTRAINT_NAME AS constraint_name
       FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
      WHERE CONSTRAINT_SCHEMA = DATABASE()
        AND TABLE_NAME = :table
        AND COLUMN_NAME = :column
        AND REFERENCED_TABLE_NAME IS NOT NULL`,
    { replacements: { table, column } }
  );
  assert.equal(rows.length, 1);
  const driftName = `drift_${table.toLowerCase()}_${column}`;
  await sequelize.query([
    `ALTER TABLE ${quoteIdentifier(table)}`,
    `DROP FOREIGN KEY ${quoteIdentifier(rows[0].constraint_name)},`,
    `ADD CONSTRAINT ${quoteIdentifier(driftName)}`,
    `FOREIGN KEY (${quoteIdentifier(column)})`,
    `REFERENCES ${quoteIdentifier(parentTable)} (${quoteIdentifier(parentColumn)})`,
    `ON UPDATE ${onUpdate} ON DELETE ${onDelete}`,
  ].join(' '));
  return driftName;
}

async function main() {
  const sourceUrl = String(process.env.WEB_EDITOR_TEST_MYSQL_URL || '').trim();
  if (!sourceUrl) {
    console.log('web editor/publication mysql integration: SKIP (WEB_EDITOR_TEST_MYSQL_URL no configurada)');
    return;
  }
  const { parsed } = assertIsolatedTestDatabase(sourceUrl);
  const database = `clinicaclick_web_contract_${process.pid}_${Date.now()}_test`;
  const admin = new Sequelize.Sequelize(sourceUrl, { logging: false, pool: { max: 1, min: 0 } });
  let isolated = null;
  try {
    await admin.authenticate();
    await admin.query(
      `CREATE DATABASE ${quoteIdentifier(database)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    parsed.pathname = `/${database}`;
    isolated = new Sequelize.Sequelize(parsed.toString(), {
      logging: false,
      pool: { max: 1, min: 0 },
    });
    await isolated.authenticate();
    await isolated.query('CREATE TABLE Clinicas (id_clinica INT NOT NULL PRIMARY KEY) ENGINE=InnoDB');
    await isolated.query('CREATE TABLE GruposClinicas (id_grupo INT NOT NULL PRIMARY KEY) ENGINE=InnoDB');
    await isolated.query('CREATE TABLE Usuarios (id_usuario INT NOT NULL PRIMARY KEY) ENGINE=InnoDB');
    await isolated.query('CREATE TABLE JobRequests (id INT UNSIGNED NOT NULL PRIMARY KEY) ENGINE=InnoDB');

    const queryInterface = isolated.getQueryInterface();
    await editorMigration.up(queryInterface, Sequelize);
    await isolated.query('CREATE TABLE WebArtifacts (id VARCHAR(36) NOT NULL PRIMARY KEY) ENGINE=InnoDB');
    await publicationMigration.up(queryInterface, Sequelize);

    await editorMigration.up(queryInterface, Sequelize);
    await publicationMigration.up(queryInterface, Sequelize);

    assert.deepEqual(
      await foreignKeyRule(isolated, 'WebProjects', 'clinica_id'),
      { update_rule: 'RESTRICT', delete_rule: 'RESTRICT' }
    );
    assert.deepEqual(
      await foreignKeyRule(isolated, 'WebDomains', 'grupo_clinica_id'),
      { update_rule: 'RESTRICT', delete_rule: 'RESTRICT' }
    );
    await assert.rejects(
      () => isolated.query(
        "INSERT INTO WebProjects (id, scope_type, name) VALUES ('bad', 'clinic', 'bad')"
      )
    );

    await replaceScopeFkWithLegacyCascade(
      isolated,
      'WebProjects',
      'clinica_id',
      'Clinicas',
      'id_clinica'
    );
    await editorMigration.up(queryInterface, Sequelize);
    assert.equal((await foreignKeyRule(isolated, 'WebProjects', 'clinica_id')).update_rule, 'RESTRICT');

    await replaceScopeFkWithLegacyCascade(
      isolated,
      'WebDomains',
      'clinica_id',
      'Clinicas',
      'id_clinica'
    );
    await publicationMigration.up(queryInterface, Sequelize);
    assert.equal((await foreignKeyRule(isolated, 'WebDomains', 'clinica_id')).update_rule, 'RESTRICT');

    await isolated.query('ALTER TABLE WebDomains MODIFY host VARCHAR(252) NOT NULL');
    await assert.rejects(
      () => publicationMigration.up(queryInterface, Sequelize),
      (error) => error.code === 'web_publication_migration_incompatible_column'
        && error.details.table === 'WebDomains'
    );
    await isolated.query('ALTER TABLE WebDomains MODIFY host VARCHAR(253) NOT NULL');

    await replaceForeignKeyWithDrift(
      isolated,
      'WebPublications',
      'project_id',
      'WebProjects',
      'id',
      { onUpdate: 'CASCADE', onDelete: 'CASCADE' }
    );
    await assert.rejects(
      () => publicationMigration.up(queryInterface, Sequelize),
      (error) => error.code === 'web_publication_migration_incompatible_foreign_key'
        && error.details.table === 'WebPublications'
        && error.details.column === 'project_id'
    );
    assert.deepEqual(
      await foreignKeyRule(isolated, 'WebPublications', 'project_id'),
      { update_rule: 'CASCADE', delete_rule: 'CASCADE' }
    );

    await publicationMigration.down(queryInterface);
    await publicationMigration.down(queryInterface);
    await isolated.query('DROP TABLE WebArtifacts');
    await editorMigration.down(queryInterface);
    await editorMigration.down(queryInterface);
    console.log('web editor/publication mysql integration: ok');
  } finally {
    if (isolated) await isolated.close();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)}`).catch(() => {});
    await admin.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
