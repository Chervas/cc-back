'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Sequelize = require('sequelize');

const migration = require('../../../migrations/20260717230000-create-web-publication-domain');

function fakeQueryInterface(seed = {}, { dependencies = migration.DEPENDENCIES } = {}) {
  const tables = new Map(Object.entries(seed));
  const indexes = new Map();
  const foreignKeys = new Map();
  const constraints = new Map();
  const calls = [];
  return {
    calls,
    async showAllTables() { return [...dependencies, ...tables.keys()]; },
    async describeTable(name) { return tables.get(name) || {}; },
    async createTable(name, definition) {
      tables.set(name, definition);
      indexes.set(name, []);
      const references = Object.entries(definition).flatMap(([columnName, column]) => (
        column.references ? [{
          constraintName: `auto_${name}_${columnName}`,
          columnName,
          referencedTableName: column.references.model,
          referencedColumnName: column.references.key,
          updateRule: column.onUpdate,
          deleteRule: column.onDelete,
        }] : []
      ));
      foreignKeys.set(name, references);
      constraints.set(name, references.map((item) => ({
        constraintName: item.constraintName,
        constraintType: 'FOREIGN KEY',
      })));
      calls.push(['createTable', name]);
    },
    async showIndex(name) { return indexes.get(name) || []; },
    async addIndex(name, fields, options) {
      const current = indexes.get(name) || [];
      current.push({ name: options.name, unique: Boolean(options.unique), fields: fields.map((attribute) => ({ attribute })) });
      indexes.set(name, current);
      calls.push(['addIndex', name, options.name]);
    },
    async getForeignKeyReferencesForTable(name) {
      return [...(foreignKeys.get(name) || [])];
    },
    async showConstraint(name) {
      return [...(constraints.get(name) || [])];
    },
    async countCheckViolations() { return 0; },
    async addConstraint(name, options) {
      const current = constraints.get(name) || [];
      if (String(options.type).toLowerCase() === 'foreign key') {
        const reference = {
          constraintName: options.name,
          columnName: options.fields[0],
          referencedTableName: options.references.table,
          referencedColumnName: options.references.field,
          updateRule: options.onUpdate,
          deleteRule: options.onDelete,
        };
        foreignKeys.get(name).push(reference);
        current.push({ constraintName: options.name, constraintType: 'FOREIGN KEY' });
      } else {
        current.push({
          constraint_name: options.name,
          constraint_type: String(options.type).toUpperCase(),
          check_clause: options.where?.val || options.where,
        });
      }
      constraints.set(name, current);
      calls.push(['addConstraint', name, options.name]);
    },
    async replaceForeignKeyAtomically(name, current, contract) {
      const targetName = current.name.toLowerCase() === contract.name.toLowerCase()
        ? `${contract.name}_restrict`
        : contract.name;
      foreignKeys.set(name, foreignKeys.get(name).map((item) => (
        item.constraintName === current.name ? {
          constraintName: targetName,
          columnName: contract.column,
          referencedTableName: contract.table,
          referencedColumnName: contract.referencedColumn,
          updateRule: contract.onUpdate,
          deleteRule: contract.onDelete,
        } : item
      )));
      constraints.set(name, constraints.get(name).map((item) => (
        item.constraintName === current.name
          ? { constraintName: targetName, constraintType: 'FOREIGN KEY' }
          : item
      )));
      calls.push(['replaceForeignKeyAtomically', name, contract.column]);
    },
    async dropTable(name) {
      tables.delete(name);
      indexes.delete(name);
      foreignKeys.delete(name);
      constraints.delete(name);
      calls.push(['dropTable', name]);
    },
    _tables: tables,
    _indexes: indexes,
    _foreignKeys: foreignKeys,
    _constraints: constraints,
  };
}

function foreignKeyByColumn(queryInterface, tableName, columnName) {
  return queryInterface._foreignKeys.get(tableName).find((item) => item.columnName === columnName);
}

test('crea dominio, instalación, publicación y deployment en orden de FK', async () => {
  const queryInterface = fakeQueryInterface();
  await migration.up(queryInterface, Sequelize);
  assert.deepEqual(queryInterface.calls.filter(([kind]) => kind === 'createTable').map(([, name]) => name), [
    'WebDomains',
    'WebWordpressInstallations',
    'WebPublications',
    'WebPublicationDeployments',
  ]);
  assert.ok(queryInterface.calls.some((call) => call[2] === 'uniq_web_publications_host_path'));
  assert.ok(queryInterface.calls.some((call) => call[2] === 'uniq_web_publication_deployments_sequence'));
  assert.ok(queryInterface.calls.some((call) => call[2] === 'chk_web_domains_scope'));
  assert.ok(queryInterface.calls.some((call) => call[2] === 'chk_web_wordpress_installations_scope'));
  assert.ok(queryInterface.calls.some((call) => call[2] === 'chk_web_publications_scope'));
  assert.equal(queryInterface._tables.get('WebDomains').clinica_id.onUpdate, 'RESTRICT');
  assert.equal(queryInterface._tables.get('WebDomains').grupo_clinica_id.onUpdate, 'RESTRICT');
});

test('es idempotente con tablas e índices compatibles', async () => {
  const queryInterface = fakeQueryInterface();
  await migration.up(queryInterface, Sequelize);
  const firstCount = queryInterface.calls.length;
  await migration.up(queryInterface, Sequelize);
  assert.equal(queryInterface.calls.length, firstCount);
});

test('falla cerrado si una tabla existente no cumple contrato', async () => {
  const queryInterface = fakeQueryInterface({ WebDomains: { id: {} } });
  queryInterface._indexes.set('WebDomains', []);
  queryInterface._foreignKeys.set('WebDomains', []);
  queryInterface._constraints.set('WebDomains', []);
  await assert.rejects(() => migration.up(queryInterface, Sequelize), (error) => {
    assert.equal(error.code, 'web_publication_migration_incompatible_table');
    assert.equal(error.details.table, 'WebDomains');
    return true;
  });
});

test('falla cerrado ante CHECK, índice o acción FK incompatibles', async () => {
  const checkInterface = fakeQueryInterface();
  await migration.up(checkInterface, Sequelize);
  checkInterface._constraints.get('WebDomains')
    .find((item) => item.constraint_name === 'chk_web_domains_scope').check_clause = 'clinica_id IS NULL';
  await assert.rejects(() => migration.up(checkInterface, Sequelize), (error) => {
    assert.equal(error.code, 'web_publication_migration_incompatible_constraint');
    return true;
  });

  const indexInterface = fakeQueryInterface();
  await migration.up(indexInterface, Sequelize);
  indexInterface._indexes.get('WebDomains')
    .find((index) => index.name === 'uniq_web_domains_host').fields = [{ attribute: 'status' }];
  await assert.rejects(() => migration.up(indexInterface, Sequelize), (error) => {
    assert.equal(error.code, 'web_publication_migration_incompatible_index');
    return true;
  });

  const foreignKeyInterface = fakeQueryInterface();
  await migration.up(foreignKeyInterface, Sequelize);
  foreignKeyInterface._foreignKeys.get('WebPublications')
    .find((item) => item.columnName === 'clinica_id').updateRule = 'CASCADE';
  await migration.up(foreignKeyInterface, Sequelize);
  assert.equal(
    foreignKeyInterface._foreignKeys.get('WebPublications')
      .find((item) => item.columnName === 'clinica_id').updateRule,
    'RESTRICT'
  );
  assert.ok(foreignKeyInterface.calls.some((call) => (
    call[0] === 'replaceForeignKeyAtomically'
      && call[1] === 'WebPublications'
      && call[2] === 'clinica_id'
  )));
});

test('down elimina en orden inverso', async () => {
  const queryInterface = fakeQueryInterface();
  await migration.up(queryInterface, Sequelize);
  queryInterface.calls.length = 0;
  await migration.down(queryInterface);
  assert.deepEqual(queryInterface.calls.filter(([kind]) => kind === 'dropTable').map(([, name]) => name), [
    'WebPublicationDeployments',
    'WebPublications',
    'WebWordpressInstallations',
    'WebDomains',
  ]);
  queryInterface.calls.length = 0;
  await migration.down(queryInterface);
  assert.equal(queryInterface.calls.some(([kind]) => kind === 'dropTable'), false);
});

test('rechaza drift de tipo/longitud, enum, nullability, unsigned, default y PK', async () => {
  const cases = [
    ['string length', (query) => { query._tables.get('WebDomains').host.type = Sequelize.STRING(252); }],
    ['enum values', (query) => {
      query._tables.get('WebDomains').status.type = Sequelize.ENUM('pending_dns', 'ready');
    }],
    ['nullability', (query) => { query._tables.get('WebDomains').host.allowNull = true; }],
    ['unsigned', (query) => { query._tables.get('WebDomains').version.type = Sequelize.INTEGER; }],
    ['default', (query) => { query._tables.get('WebDomains').status.defaultValue = 'ready'; }],
    ['primary key', (query) => { query._tables.get('WebDomains').id.primaryKey = false; }],
  ];
  for (const [label, mutate] of cases) {
    const query = fakeQueryInterface();
    await migration.up(query, Sequelize);
    mutate(query);
    const mutationCount = query.calls.length;
    await assert.rejects(
      () => migration.up(query, Sequelize),
      (error) => error.code === 'web_publication_migration_incompatible_column',
      label
    );
    assert.equal(query.calls.length, mutationCount, label);
  }
});

test('rechaza destino, columna, ON DELETE y acciones no-scope incompatibles', async () => {
  const cases = [
    ['target table', (query) => {
      foreignKeyByColumn(query, 'WebPublications', 'project_id').referencedTableName = 'Usuarios';
    }],
    ['target column', (query) => {
      foreignKeyByColumn(query, 'WebPublications', 'project_id').referencedColumnName = 'id_usuario';
    }],
    ['on delete', (query) => {
      foreignKeyByColumn(query, 'WebPublications', 'project_id').deleteRule = 'CASCADE';
    }],
    ['non-scope on update', (query) => {
      foreignKeyByColumn(query, 'WebDomains', 'created_by_user_id').updateRule = 'RESTRICT';
    }],
    ['scope legacy not exact', (query) => {
      const foreignKey = foreignKeyByColumn(query, 'WebDomains', 'clinica_id');
      foreignKey.updateRule = 'CASCADE';
      foreignKey.deleteRule = 'CASCADE';
    }],
  ];
  for (const [label, mutate] of cases) {
    const query = fakeQueryInterface();
    await migration.up(query, Sequelize);
    mutate(query);
    const mutationCount = query.calls.length;
    await assert.rejects(
      () => migration.up(query, Sequelize),
      (error) => error.code === 'web_publication_migration_incompatible_foreign_key',
      label
    );
    assert.equal(query.calls.length, mutationCount, label);
  }
});

test('preflight de dependencias falla antes de cualquier DDL', async () => {
  const query = fakeQueryInterface({}, {
    dependencies: migration.DEPENDENCIES.filter((name) => name !== 'WebArtifacts'),
  });
  await assert.rejects(
    () => migration.up(query, Sequelize),
    (error) => error.code === 'web_publication_migration_missing_dependency'
      && error.details.missing_tables.join(',') === 'WebArtifacts'
  );
  assert.equal(query.calls.length, 0);
});
