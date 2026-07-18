'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Sequelize = require('sequelize');
const migration = require('../../../migrations/20260717200000-create-web-content-media');

function referenceFromDefinition(table, columnName, definition, name = null) {
  return {
    constraintName: name || `auto_${table}_${columnName}`,
    columnName,
    referencedTableName: definition.references.model,
    referencedColumnName: definition.references.key,
    updateRule: definition.onUpdate,
    deleteRule: definition.onDelete,
  };
}

class FakeQueryInterface {
  constructor({ dependencies = migration.DEPENDENCIES } = {}) {
    this.dependencies = new Set(dependencies);
    this.tables = new Map();
    this.indexes = new Map();
    this.foreignKeys = new Map();
    this.constraints = new Map();
    this.calls = [];
  }

  async showAllTables() {
    this.calls.push(['showAllTables']);
    return [...this.dependencies, ...this.tables.keys()];
  }

  async createTable(name, definition) {
    if (this.tables.has(name)) throw new Error(`duplicate table ${name}`);
    this.tables.set(name, definition);
    this.indexes.set(name, []);
    const foreignKeys = Object.entries(definition).flatMap(([columnName, column]) => (
      column.references ? [referenceFromDefinition(name, columnName, column)] : []
    ));
    this.foreignKeys.set(name, foreignKeys);
    this.constraints.set(name, foreignKeys.map((item) => ({
      constraintName: item.constraintName,
      constraintType: 'FOREIGN KEY',
    })));
    this.calls.push(['createTable', name]);
  }

  async describeTable(name) {
    this.calls.push(['describeTable', name]);
    return this.tables.get(name);
  }

  async getForeignKeyReferencesForTable(name) {
    this.calls.push(['getForeignKeyReferencesForTable', name]);
    return [...(this.foreignKeys.get(name) || [])];
  }

  async showConstraint(name) {
    this.calls.push(['showConstraint', name]);
    return [...(this.constraints.get(name) || [])];
  }

  async addConstraint(name, options) {
    const constraint = {
      constraintName: options.name,
      constraintType: String(options.type).toUpperCase(),
      ...(String(options.type).toLowerCase() === 'check'
        ? { checkClause: options.where?.val || options.where }
        : {}),
    };
    this.constraints.get(name).push(constraint);
    if (String(options.type).toLowerCase() === 'foreign key') {
      this.foreignKeys.get(name).push({
        constraintName: options.name,
        columnName: options.fields[0],
        referencedTableName: options.references.table,
        referencedColumnName: options.references.field,
        updateRule: options.onUpdate,
        deleteRule: options.onDelete,
      });
    }
    this.calls.push(['addConstraint', name, options.name, String(options.type).toLowerCase()]);
  }

  async showIndex(name) {
    this.calls.push(['showIndex', name]);
    return [...(this.indexes.get(name) || [])];
  }

  async addIndex(name, fields, options) {
    this.indexes.get(name).push({
      name: options.name,
      unique: Boolean(options.unique),
      fields: fields.map((attribute) => ({ attribute })),
    });
    this.calls.push(['addIndex', name, options.name]);
  }

  async dropTable(name) {
    if (!this.tables.has(name)) throw new Error(`missing table ${name}`);
    this.tables.delete(name);
    this.indexes.delete(name);
    this.foreignKeys.delete(name);
    this.constraints.delete(name);
    this.calls.push(['dropTable', name]);
  }

  removeIndex(table, name) {
    this.indexes.set(table, this.indexes.get(table).filter((item) => item.name !== name));
  }

  async removeConstraint(table, name) {
    this.constraints.set(table, this.constraints.get(table).filter((item) => item.constraintName !== name));
    this.foreignKeys.set(
      table,
      this.foreignKeys.get(table).filter((item) => item.constraintName !== name)
    );
    this.calls.push(['removeConstraint', table, name]);
  }

  removeForeignKey(table, columnName) {
    const removedNames = this.foreignKeys.get(table)
      .filter((item) => item.columnName === columnName)
      .map((item) => item.constraintName);
    this.foreignKeys.set(
      table,
      this.foreignKeys.get(table).filter((item) => item.columnName !== columnName)
    );
    this.constraints.set(
      table,
      this.constraints.get(table).filter((item) => !removedNames.includes(item.constraintName))
    );
  }

  removeTable(table) {
    this.tables.delete(table);
    this.indexes.delete(table);
    this.foreignKeys.delete(table);
    this.constraints.delete(table);
  }

  resetCalls() {
    this.calls.length = 0;
  }
}

function index(query, table, name) {
  return query.indexes.get(table).find((item) => item.name === name);
}

function constraint(query, table, name) {
  return query.constraints.get(table).find((item) => item.constraintName === name);
}

function foreignKey(query, table, columnName) {
  return query.foreignKeys.get(table).find((item) => item.columnName === columnName);
}

test('crea el contrato completo en orden y la reentrada no repite DDL', async () => {
  const query = new FakeQueryInterface();
  await migration.up(query, Sequelize);

  assert.deepEqual([...query.tables.keys()], migration.TABLES);
  assert.deepEqual(
    query.calls.filter(([operation]) => operation === 'createTable').map(([, table]) => table),
    migration.TABLES
  );
  assert.equal(query.tables.get('WebMediaAssets').public_media_asset_id.references.model, 'PublicMediaAssets');
  assert.equal(query.tables.get('WebContentEntries').clinica_id.references.model, 'Clinicas');
  assert.equal(query.tables.get('WebContentEntries').grupo_clinica_id.references.model, 'GruposClinicas');
  assert.equal(query.tables.get('WebContentEntries').clinica_id.onUpdate, 'RESTRICT');
  assert.equal(query.tables.get('WebContentEntries').grupo_clinica_id.onUpdate, 'RESTRICT');
  assert.equal(query.tables.get('WebContentEntryVersions').content_entry_id.references.model, 'WebContentEntries');
  assert.equal(index(query, 'WebMediaAssets', 'uniq_web_media_public_asset').unique, true);
  assert.equal(index(query, 'WebContentEntryVersions', 'uniq_web_content_entry_version').unique, true);
  assert.ok(constraint(query, 'WebMediaAssets', 'chk_webmediaassets_scope'));
  assert.ok(constraint(query, 'WebContentEntries', 'chk_webcontententries_scope'));

  const mutationOrder = query.calls
    .filter(([operation]) => ['createTable', 'addConstraint', 'addIndex'].includes(operation))
    .map((call) => call.slice(0, 3).join(':'));
  assert.deepEqual(mutationOrder, [
    'createTable:WebMediaAssets',
    'addConstraint:WebMediaAssets:chk_webmediaassets_scope',
    'addIndex:WebMediaAssets:uniq_web_media_public_asset',
    'addIndex:WebMediaAssets:idx_web_media_clinic_status',
    'addIndex:WebMediaAssets:idx_web_media_group_status',
    'addIndex:WebMediaAssets:idx_web_media_kind_status',
    'createTable:WebContentEntries',
    'addConstraint:WebContentEntries:chk_webcontententries_scope',
    'addIndex:WebContentEntries:idx_web_content_clinic_status',
    'addIndex:WebContentEntries:idx_web_content_group_status',
    'addIndex:WebContentEntries:idx_web_content_type_locale_status',
    'addIndex:WebContentEntries:idx_web_content_owner_status',
    'addIndex:WebContentEntries:idx_web_content_hash',
    'createTable:WebContentEntryVersions',
    'addIndex:WebContentEntryVersions:uniq_web_content_entry_version',
    'addIndex:WebContentEntryVersions:idx_web_content_versions_entry',
    'addIndex:WebContentEntryVersions:idx_web_content_versions_hash',
  ]);

  const createCount = query.calls.filter(([operation]) => operation === 'createTable').length;
  const constraintCount = query.calls.filter(([operation]) => operation === 'addConstraint').length;
  const indexCount = query.calls.filter(([operation]) => operation === 'addIndex').length;
  await migration.up(query, Sequelize);
  assert.equal(query.calls.filter(([operation]) => operation === 'createTable').length, createCount);
  assert.equal(query.calls.filter(([operation]) => operation === 'addConstraint').length, constraintCount);
  assert.equal(query.calls.filter(([operation]) => operation === 'addIndex').length, indexCount);
});

test('acepta la forma real de metadatos que describeTable devuelve en MySQL', async () => {
  const query = new FakeQueryInterface();
  await migration.up(query, Sequelize);
  for (const columns of query.tables.values()) {
    for (const metadata of Object.values(columns)) {
      const key = String(metadata.type?.key || metadata.type?.constructor?.key || metadata.type?.prototype?.key || '');
      if (key === 'ENUM') {
        const values = metadata.type.values || metadata.type.options.values;
        metadata.type = `ENUM(${values.map((value) => `'${value}'`).join(',')})`;
      } else if (key === 'JSON') {
        metadata.type = 'JSON';
      } else if (key === 'DATE') {
        metadata.type = 'DATETIME';
      } else if (key === 'BOOLEAN') {
        metadata.type = 'TINYINT(1)';
      } else if (key === 'INTEGER') {
        metadata.type = /UNSIGNED/.test(String(metadata.type)) ? 'INT(10) UNSIGNED' : 'INT(11)';
      } else if (key === 'STRING') {
        metadata.type = String(metadata.type);
      }
      if (metadata.defaultValue?.val) metadata.defaultValue = metadata.defaultValue.val;
    }
  }
  query.resetCalls();
  await migration.up(query, Sequelize);
  assert.equal(
    query.calls.some(([operation]) => ['createTable', 'addConstraint', 'addIndex'].includes(operation)),
    false
  );
});

test('valida ENUM aunque Sequelize haya cargado los tipos específicos de MySQL', async () => {
  const mysql = new Sequelize.Sequelize('mysql://root@127.0.0.1:1/unused', {
    logging: false,
    pool: { max: 1, min: 0 },
  });
  try {
    const query = new FakeQueryInterface();
    await migration.up(query, Sequelize);
    query.resetCalls();
    await migration.up(query, Sequelize);
    assert.equal(
      query.calls.some(([operation]) => ['createTable', 'addConstraint', 'addIndex'].includes(operation)),
      false
    );
  } finally {
    await mysql.close();
  }
});

test('usa INFORMATION_SCHEMA para acotar constraints y reglas FK del MySQL real', async () => {
  const query = new FakeQueryInterface();
  const getReferences = query.getForeignKeyReferencesForTable.bind(query);
  query.getForeignKeyReferencesForTable = async (table) => (
    (await getReferences(table)).map((item) => {
      const copy = { ...item };
      delete copy.updateRule;
      delete copy.deleteRule;
      return copy;
    })
  );
  query.sequelize = {
    async querySql(sql, options) {
      const table = options.replacements.tableName;
      if (sql.includes('REFERENTIAL_CONSTRAINTS')) {
        return [[...(query.foreignKeys.get(table) || [])], { source: 'information_schema' }];
      }
      if (sql.includes('TABLE_CONSTRAINTS')) {
        return [[...(query.constraints.get(table) || [])], { source: 'information_schema' }];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  query.sequelize.query = query.sequelize.querySql;

  await migration.up(query, Sequelize);
  query.resetCalls();
  await migration.up(query, Sequelize);
  assert.equal(
    query.calls.some(([operation]) => ['createTable', 'addConstraint', 'addIndex'].includes(operation)),
    false
  );
});

test('acepta el CHECK de scope normalizado por MySQL con charset y comillas escapadas', async () => {
  const query = new FakeQueryInterface();
  await migration.up(query, Sequelize);
  constraint(query, 'WebMediaAssets', 'chk_webmediaassets_scope').checkClause =
    "(((`scope_type` = _utf8mb4\\'clinic\\') and (`clinica_id` is not null) and "
    + "(`grupo_clinica_id` is null)) or ((`scope_type` = _utf8mb4\\'group\\') and "
    + "(`clinica_id` is null) and (`grupo_clinica_id` is not null)))";
  query.resetCalls();

  await migration.up(query, Sequelize);
  assert.equal(
    query.calls.some(([operation]) => ['createTable', 'addConstraint', 'addIndex'].includes(operation)),
    false
  );
});

test('el preflight de dependencias falla antes de cualquier DDL', async () => {
  const query = new FakeQueryInterface({
    dependencies: migration.DEPENDENCIES.filter((name) => name !== 'PublicMediaAssets'),
  });
  await assert.rejects(
    () => migration.up(query, Sequelize),
    (error) => error.code === 'web_content_media_migration_missing_dependency'
      && error.details.missing_tables.join(',') === 'PublicMediaAssets'
  );
  assert.equal(query.calls.some(([operation]) => operation === 'createTable'), false);
  assert.equal(query.calls.some(([operation]) => operation === 'addConstraint'), false);
  assert.equal(query.calls.some(([operation]) => operation === 'addIndex'), false);
});

test('reanuda un DDL parcial compatible y crea solo padres/hijos ausentes', async () => {
  const query = new FakeQueryInterface();
  await migration.up(query, Sequelize);
  query.removeTable('WebContentEntries');
  query.removeTable('WebContentEntryVersions');
  query.resetCalls();

  await migration.up(query, Sequelize);
  assert.deepEqual(
    query.calls.filter(([operation]) => operation === 'createTable').map(([, table]) => table),
    ['WebContentEntries', 'WebContentEntryVersions']
  );
  assert.equal(query.tables.size, 3);
});

test('repara de forma segura FK, CHECK e índice ausentes y queda idempotente', async () => {
  const query = new FakeQueryInterface();
  await migration.up(query, Sequelize);
  query.removeForeignKey('WebContentEntries', 'owner_user_id');
  query.removeConstraint('WebContentEntries', 'chk_webcontententries_scope');
  query.removeIndex('WebContentEntries', 'idx_web_content_hash');
  query.resetCalls();

  await migration.up(query, Sequelize);
  const mutations = query.calls.filter(([operation]) => ['createTable', 'addConstraint', 'addIndex'].includes(operation));
  assert.deepEqual(mutations, [
    ['addConstraint', 'WebContentEntries', 'fk_webcontententries_owner_user_id', 'foreign key'],
    ['addConstraint', 'WebContentEntries', 'chk_webcontententries_scope', 'check'],
    ['addIndex', 'WebContentEntries', 'idx_web_content_hash'],
  ]);
  assert.ok(query.foreignKeys.get('WebContentEntries').some((item) => (
    item.columnName === 'owner_user_id'
    && item.referencedTableName === 'Usuarios'
    && item.deleteRule === 'SET NULL'
  )));

  query.resetCalls();
  await migration.up(query, Sequelize);
  assert.equal(
    query.calls.some(([operation]) => ['createTable', 'addConstraint', 'addIndex'].includes(operation)),
    false
  );
});

test('sustituye FK de scope legacy CASCADE antes de crear el CHECK y la reentrada queda limpia', async () => {
  const query = new FakeQueryInterface();
  await migration.up(query, Sequelize);
  foreignKey(query, 'WebMediaAssets', 'clinica_id').updateRule = 'CASCADE';
  foreignKey(query, 'WebMediaAssets', 'grupo_clinica_id').updateRule = 'CASCADE';
  await query.removeConstraint('WebMediaAssets', 'chk_webmediaassets_scope');
  query.resetCalls();

  await migration.up(query, Sequelize);

  const mutations = query.calls.filter(([operation]) => (
    ['removeConstraint', 'addConstraint', 'addIndex', 'createTable'].includes(operation)
  ));
  assert.deepEqual(mutations, [
    ['removeConstraint', 'WebMediaAssets', 'auto_WebMediaAssets_clinica_id'],
    ['addConstraint', 'WebMediaAssets', 'fk_webmediaassets_clinica_id', 'foreign key'],
    ['removeConstraint', 'WebMediaAssets', 'auto_WebMediaAssets_grupo_clinica_id'],
    ['addConstraint', 'WebMediaAssets', 'fk_webmediaassets_grupo_clinica_id', 'foreign key'],
    ['addConstraint', 'WebMediaAssets', 'chk_webmediaassets_scope', 'check'],
  ]);
  assert.equal(foreignKey(query, 'WebMediaAssets', 'clinica_id').updateRule, 'RESTRICT');
  assert.equal(foreignKey(query, 'WebMediaAssets', 'grupo_clinica_id').updateRule, 'RESTRICT');
  assert.ok(constraint(query, 'WebMediaAssets', 'chk_webmediaassets_scope'));

  query.resetCalls();
  await migration.up(query, Sequelize);
  assert.equal(
    query.calls.some(([operation]) => (
      ['createTable', 'removeConstraint', 'addConstraint', 'addIndex'].includes(operation)
    )),
    false
  );
});

test('genera un ALTER MySQL atómico con coma entre DROP FOREIGN KEY y ADD CONSTRAINT', async () => {
  const query = new FakeQueryInterface();
  await migration.up(query, Sequelize);
  const legacy = foreignKey(query, 'WebMediaAssets', 'clinica_id');
  legacy.updateRule = 'CASCADE';
  await query.removeConstraint('WebMediaAssets', 'chk_webmediaassets_scope');

  const alterStatements = [];
  query.sequelize = {
    getDialect() {
      return 'mysql';
    },
    async query(sql, options = {}) {
      if (sql.includes('TABLE_CONSTRAINTS')) {
        const table = options.replacements.tableName;
        return [[...(query.constraints.get(table) || [])], { source: 'information_schema' }];
      }
      if (!sql.startsWith('ALTER TABLE')) throw new Error(`unexpected SQL: ${sql}`);
      alterStatements.push(sql);
      assert.match(
        sql,
        /DROP FOREIGN KEY `auto_WebMediaAssets_clinica_id`, ADD CONSTRAINT `fk_webmediaassets_clinica_id`/
      );
      query.foreignKeys.set(
        'WebMediaAssets',
        query.foreignKeys.get('WebMediaAssets').filter((item) => item.constraintName !== legacy.constraintName)
      );
      query.constraints.set(
        'WebMediaAssets',
        query.constraints.get('WebMediaAssets').filter((item) => item.constraintName !== legacy.constraintName)
      );
      query.foreignKeys.get('WebMediaAssets').push({
        constraintName: 'fk_webmediaassets_clinica_id',
        columnName: 'clinica_id',
        referencedTableName: 'Clinicas',
        referencedColumnName: 'id_clinica',
        updateRule: 'RESTRICT',
        deleteRule: 'RESTRICT',
      });
      query.constraints.get('WebMediaAssets').push({
        constraintName: 'fk_webmediaassets_clinica_id',
        constraintType: 'FOREIGN KEY',
      });
      return [[], { source: 'alter' }];
    },
  };
  query.resetCalls();

  await migration.up(query, Sequelize);
  assert.equal(alterStatements.length, 1);
  assert.ok(constraint(query, 'WebMediaAssets', 'chk_webmediaassets_scope'));
  assert.equal(
    query.calls.some(([operation]) => operation === 'removeConstraint'),
    false
  );

  query.resetCalls();
  await migration.up(query, Sequelize);
  assert.equal(alterStatements.length, 1);
  assert.equal(
    query.calls.some(([operation]) => (
      ['createTable', 'removeConstraint', 'addConstraint', 'addIndex'].includes(operation)
    )),
    false
  );
});

test('evita reutilizar en el mismo ALTER el nombre de una FK legacy ya determinista', async () => {
  const query = new FakeQueryInterface();
  await migration.up(query, Sequelize);
  const current = foreignKey(query, 'WebMediaAssets', 'clinica_id');
  await query.removeConstraint('WebMediaAssets', current.constraintName);
  await query.addConstraint('WebMediaAssets', {
    fields: ['clinica_id'],
    type: 'foreign key',
    name: 'fk_webmediaassets_clinica_id',
    references: { table: 'Clinicas', field: 'id_clinica' },
    onUpdate: 'CASCADE',
    onDelete: 'RESTRICT',
  });
  await query.removeConstraint('WebMediaAssets', 'chk_webmediaassets_scope');
  query.resetCalls();

  await migration.up(query, Sequelize);
  assert.deepEqual(
    query.calls.filter(([operation]) => ['removeConstraint', 'addConstraint'].includes(operation)),
    [
      ['removeConstraint', 'WebMediaAssets', 'fk_webmediaassets_clinica_id'],
      ['addConstraint', 'WebMediaAssets', 'fk_webmediaassets_clinica_id_restrict', 'foreign key'],
      ['addConstraint', 'WebMediaAssets', 'chk_webmediaassets_scope', 'check'],
    ]
  );
  assert.equal(foreignKey(query, 'WebMediaAssets', 'clinica_id').updateRule, 'RESTRICT');
});

test('rechaza columnas parciales/incompatibles antes de reparar otra tabla', async () => {
  for (const mutate of [
    (query) => { delete query.tables.get('WebContentEntryVersions').content_hash; },
    (query) => { query.tables.get('WebContentEntryVersions').locale.allowNull = true; },
    (query) => { query.tables.get('WebContentEntryVersions').title.type = Sequelize.INTEGER; },
  ]) {
    const query = new FakeQueryInterface();
    await migration.up(query, Sequelize);
    query.removeIndex('WebMediaAssets', 'idx_web_media_kind_status');
    mutate(query);
    query.resetCalls();
    await assert.rejects(
      () => migration.up(query, Sequelize),
      (error) => [
        'web_content_media_migration_incompatible_table',
        'web_content_media_migration_incompatible_column',
      ].includes(error.code)
    );
    assert.equal(query.calls.some(([operation]) => operation === 'addIndex'), false);
  }
});

test('rechaza FK, índice o CHECK ambiguos en vez de alterarlos', async () => {
  const cases = [
    {
      expected: 'web_content_media_migration_incompatible_foreign_key',
      mutate(query) {
        const reference = query.foreignKeys.get('WebMediaAssets')
          .find((item) => item.columnName === 'public_media_asset_id');
        reference.referencedTableName = 'Usuarios';
        reference.referencedColumnName = 'id_usuario';
      },
    },
    {
      expected: 'web_content_media_migration_incompatible_index',
      mutate(query) {
        index(query, 'WebMediaAssets', 'uniq_web_media_public_asset').fields = [{ attribute: 'title' }];
      },
    },
    {
      expected: 'web_content_media_migration_incompatible_constraint',
      mutate(query) {
        constraint(query, 'WebMediaAssets', 'chk_webmediaassets_scope').checkClause = '(clinica_id IS NOT NULL)';
      },
    },
  ];
  for (const item of cases) {
    const query = new FakeQueryInterface();
    await migration.up(query, Sequelize);
    item.mutate(query);
    query.resetCalls();
    await assert.rejects(
      () => migration.up(query, Sequelize),
      (error) => error.code === item.expected
    );
    assert.equal(
      query.calls.some(([operation]) => ['createTable', 'addConstraint', 'addIndex'].includes(operation)),
      false
    );
  }
});

test('rechaza acciones FK incompatibles que no pertenecen al caso legacy reparable', async () => {
  const query = new FakeQueryInterface();
  await migration.up(query, Sequelize);
  foreignKey(query, 'WebMediaAssets', 'owner_user_id').updateRule = 'RESTRICT';
  query.resetCalls();

  await assert.rejects(
    () => migration.up(query, Sequelize),
    (error) => error.code === 'web_content_media_migration_incompatible_foreign_key'
      && error.details.table === 'WebMediaAssets'
      && error.details.column === 'owner_user_id'
  );
  assert.equal(
    query.calls.some(([operation]) => (
      ['createTable', 'removeConstraint', 'addConstraint', 'addIndex'].includes(operation)
    )),
    false
  );
});

test('down elimina hijos antes que padres y se puede repetir', async () => {
  const query = new FakeQueryInterface();
  await migration.up(query, Sequelize);
  query.resetCalls();
  await migration.down(query);
  assert.deepEqual(
    query.calls.filter(([operation]) => operation === 'dropTable').map(([, table]) => table),
    ['WebContentEntryVersions', 'WebContentEntries', 'WebMediaAssets']
  );
  assert.equal(query.tables.size, 0);

  query.resetCalls();
  await migration.down(query);
  assert.equal(query.calls.some(([operation]) => operation === 'dropTable'), false);
});
