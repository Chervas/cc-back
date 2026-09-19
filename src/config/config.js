// backendclinicaclick/config/config.js
require('dotenv').config();
const { buildDatabaseTlsOptions } = require('../lib/databaseTlsConfig');

const databaseOptions = {
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  host: process.env.DB_HOST,
  dialect: 'mysql',
  // mysql2 defaults to 16,000 cached statements PER connection. A polling
  // worker can otherwise exhaust the shared server's 16,382 statement limit.
  // Eviction closes the server statement; do not raise that global limit.
  // Gated preparation: enabling TLS requires a trusted CA and hostname verification.
  // A TLS/certificate error never falls back to the previous transport.
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
