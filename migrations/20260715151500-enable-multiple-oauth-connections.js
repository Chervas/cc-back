'use strict';

function indexColumns(index) {
  return (index.fields || [])
    .map((field) => field.attribute || field.name)
    .filter(Boolean);
}

async function assertNoDuplicates(queryInterface, table, columns, phase) {
  const quotedColumns = columns.map((column) => `\`${column}\``).join(', ');
  const notNull = columns.map((column) => `\`${column}\` IS NOT NULL`).join(' AND ');
  const [rows] = await queryInterface.sequelize.query(`
    SELECT ${quotedColumns}, COUNT(*) AS duplicate_count
    FROM \`${table}\`
    WHERE ${notNull}
    GROUP BY ${quotedColumns}
    HAVING COUNT(*) > 1
    LIMIT 1
  `);
  if (rows.length) {
    throw new Error(
      `${phase}: ${table} contiene duplicados para (${columns.join(', ')}); `
      + 'la migración se detiene sin borrar ni fusionar conexiones.'
    );
  }
}

async function ensureIndex(queryInterface, table, columns, options) {
  const indexes = await queryInterface.showIndex(table);
  const exists = indexes.some((index) => (
    Boolean(index.unique) === Boolean(options.unique)
    && indexColumns(index).join(',') === columns.join(',')
  ));
  if (!exists) {
    await queryInterface.addIndex(table, columns, options);
  }
}

async function dropMatchingUniqueIndexes(queryInterface, table, columns) {
  const indexes = await queryInterface.showIndex(table);
  for (const index of indexes) {
    if (
      index.name !== 'PRIMARY'
      && index.unique
      && indexColumns(index).join(',') === columns.join(',')
    ) {
      await queryInterface.removeIndex(table, index.name);
    }
  }
}

module.exports = {
  async up(queryInterface) {
    await assertNoDuplicates(
      queryInterface,
      'GoogleConnections',
      ['userId', 'googleUserId'],
      'No se puede habilitar multi-conexión Google'
    );
    await assertNoDuplicates(
      queryInterface,
      'MetaConnections',
      ['userId', 'metaUserId'],
      'No se puede habilitar multi-conexión Meta'
    );

    // Añadir primero las nuevas garantías. MySQL hace autocommit de ALTER TABLE:
    // nunca debe existir una ventana en la que una carrera pueda insertar dos
    // filas para la misma identidad proveedor/usuario.
    await ensureIndex(queryInterface, 'GoogleConnections', ['userId', 'googleUserId'], {
      name: 'uniq_google_connections_user_provider',
      unique: true,
    });
    await ensureIndex(queryInterface, 'MetaConnections', ['userId', 'metaUserId'], {
      name: 'uniq_meta_connections_user_provider',
      unique: true,
    });

    // Mantener índices simples antes de retirar UNIQUE: las FK de MySQL siguen
    // necesitando un índice cuyo primer campo sea userId.
    await ensureIndex(queryInterface, 'GoogleConnections', ['userId'], {
      name: 'idx_google_connections_user_id',
      unique: false,
    });
    await ensureIndex(queryInterface, 'MetaConnections', ['userId'], {
      name: 'idx_meta_connections_user_id',
      unique: false,
    });
    await ensureIndex(queryInterface, 'MetaConnections', ['metaUserId'], {
      name: 'idx_meta_connections_provider_id',
      unique: false,
    });

    await dropMatchingUniqueIndexes(queryInterface, 'GoogleConnections', ['userId']);
    await dropMatchingUniqueIndexes(queryInterface, 'MetaConnections', ['userId']);
    await dropMatchingUniqueIndexes(queryInterface, 'MetaConnections', ['metaUserId']);
  },

  async down(queryInterface) {
    // El rollback nunca deduplica ni elimina grants. Si el estado nuevo no cabe
    // en el contrato antiguo, se aborta antes de alterar ningún índice.
    await assertNoDuplicates(
      queryInterface,
      'GoogleConnections',
      ['userId'],
      'No se puede restaurar la unicidad Google por usuario'
    );
    await assertNoDuplicates(
      queryInterface,
      'MetaConnections',
      ['userId'],
      'No se puede restaurar la unicidad Meta por usuario'
    );
    await assertNoDuplicates(
      queryInterface,
      'MetaConnections',
      ['metaUserId'],
      'No se puede restaurar la unicidad global Meta'
    );

    // Restaurar primero las garantías antiguas. Solo después se retiran los
    // compuestos, manteniendo unicidad incluso si un ALTER posterior falla.
    await ensureIndex(queryInterface, 'GoogleConnections', ['userId'], {
      name: 'uniq_google_connections_user_id',
      unique: true,
    });
    await ensureIndex(queryInterface, 'MetaConnections', ['userId'], {
      name: 'uniq_meta_connections_user_id',
      unique: true,
    });
    await ensureIndex(queryInterface, 'MetaConnections', ['metaUserId'], {
      name: 'uniq_meta_connections_provider_id',
      unique: true,
    });

    await dropMatchingUniqueIndexes(
      queryInterface,
      'GoogleConnections',
      ['userId', 'googleUserId']
    );
    await dropMatchingUniqueIndexes(
      queryInterface,
      'MetaConnections',
      ['userId', 'metaUserId']
    );
  },
};
