'use strict';
const crypto = require('node:crypto');
const active = new WeakMap();

// Content admission is serialized across API processes. The pinned connection
// owns only the advisory lock; asset/job writes finish before it is released.
async function withIngestionLease(sequelize, scope, work) {
  // Leave connections free for storage/model writes; several admissions must
  // not pin the whole pool while each waits for another pooled connection.
  const capacity = Math.min(2, Number(sequelize.options?.pool?.max || 5) - 1);
  if (capacity < 1 || (active.get(sequelize) || 0) >= capacity) {
    throw Object.assign(Error('Hay otros archivos entrando. Vuelve a intentarlo.'), { statusCode: 429, code: 'accounting_ingestion_capacity' });
  }
  active.set(sequelize, (active.get(sequelize) || 0) + 1);
  const manager = sequelize.connectionManager;
  let connection;
  try {
  connection = await manager.getConnection({ type: 'WRITE', useMaster: true });
  const name = `cc:ocr:${crypto.createHash('sha256').update(`${sequelize.config.database}:${scope}`).digest('hex').slice(0, 48)}`;
  const query = async (sql, args) => {
    if (typeof connection.promise === 'function') return (await connection.promise().query(sql, args))[0];
    return new Promise((resolve, reject) => connection.query(sql, args, (error, rows) => error ? reject(error) : resolve(rows)));
  };
  let held = false, reusable = false;
  try {
    const rows = await query('SELECT GET_LOCK(?, 5) AS acquired', [name]);
    if (Number(rows[0]?.acquired) !== 1) {
      reusable = true;
      throw Object.assign(Error('El archivo se está añadiendo. Vuelve a intentarlo.'), { statusCode: 409, code: 'accounting_ingestion_busy' });
    }
    held = true;
    return await work();
  } finally {
    try {
      if (held) reusable = Number((await query('SELECT RELEASE_LOCK(?) AS released', [name]))[0]?.released) === 1;
    } finally {
      if (reusable) await manager.releaseConnection(connection);
      else await manager.destroyConnection(connection);
    }
  }
  } finally {
    active.set(sequelize, active.get(sequelize) - 1);
  }
}
module.exports = { withIngestionLease };
