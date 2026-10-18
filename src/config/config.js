// backendclinicaclick/config/config.js
require('dotenv').config();
const { buildDatabaseTlsOptions } = require('../lib/databaseTlsConfig');

const databaseOptions = {
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  host: process.env.DB_HOST,
  dialect: 'mysql',
  // Gated preparation: enabling TLS requires a trusted CA and hostname verification.
  // A TLS/certificate error never falls back to the previous transport.
  // Bound the cache per connection: mysql2's 16,000 default can exhaust the
  // shared MySQL statement budget from a single long-running polling worker.
  dialectOptions: { ...buildDatabaseTlsOptions(process.env), maxPreparedStatements: 128 },
  // El polling del orquestador no debe volcar cada SELECT en los logs PM2.
  // Se puede habilitar de forma temporal y explícita para un diagnóstico.
  logging: process.env.DB_SQL_LOGGING === 'true' ? console.log : false
};

module.exports = {
  development: { ...databaseOptions },
  test: { ...databaseOptions },
  production: { ...databaseOptions }
};
