'use strict';

async function queryRawConnection(connection, sql, values = []) {
  if (connection && typeof connection.promise === 'function') {
    const [rows] = await connection.promise().query(sql, values);
    return rows;
  }
  return new Promise((resolve, reject) => {
    connection.query(sql, values, (error, rows) => {
      if (error) reject(error);
      else resolve(rows);
    });
  });
}

async function destroyRawConnection(connectionManager, connection) {
  if (typeof connectionManager.destroyConnection === 'function') {
    await connectionManager.destroyConnection(connection);
    return;
  }
  if (typeof connection?.destroy === 'function') {
    connection.destroy();
  }
}

async function acquireWabaCatalogCreationLease(wabaId, options = {}) {
  const safeWabaId = String(wabaId || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeWabaId) {
    return { acquired: false, reason: 'invalid_waba_id', release: async () => {} };
  }

  const sequelizeInstance = options.sequelizeInstance;
  if (!sequelizeInstance) {
    throw new Error('sequelize_instance_required');
  }
  const connectionManager = options.connectionManager || sequelizeInstance.connectionManager;
  const dialect = typeof sequelizeInstance.getDialect === 'function'
    ? sequelizeInstance.getDialect()
    : 'mysql';
  if (!['mysql', 'mariadb'].includes(dialect)) {
    return { acquired: true, reason: 'unsupported_dialect_noop', release: async () => {} };
  }

  const waitSeconds = Math.max(0, Math.min(Number(options.waitSeconds ?? 30) || 0, 60));
  const lockName = `cc:wa:catalog:${safeWabaId}`.slice(0, 64);
  let connection = null;

  try {
    connection = await connectionManager.getConnection({ type: 'WRITE', useMaster: true });
    const rows = await queryRawConnection(
      connection,
      'SELECT GET_LOCK(?, ?) AS acquired',
      [lockName, waitSeconds]
    );
    const acquired = Number(rows?.[0]?.acquired) === 1;
    if (!acquired) {
      await connectionManager.releaseConnection(connection);
      return { acquired: false, reason: 'contended', lockName, release: async () => {} };
    }

    let released = false;
    return {
      acquired: true,
      lockName,
      async release() {
        if (released) return;
        released = true;
        let lockReleased = false;
        try {
          const releaseRows = await queryRawConnection(
            connection,
            'SELECT RELEASE_LOCK(?) AS released',
            [lockName]
          );
          lockReleased = Number(releaseRows?.[0]?.released) === 1;
        } finally {
          if (lockReleased) {
            await connectionManager.releaseConnection(connection);
          } else {
            await destroyRawConnection(connectionManager, connection);
          }
        }
      },
    };
  } catch (error) {
    if (connection) {
      await destroyRawConnection(connectionManager, connection).catch(() => undefined);
    }
    throw error;
  }
}

module.exports = {
  acquireWabaCatalogCreationLease,
};
