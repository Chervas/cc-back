// backendclinicaclick/config/config.js
require('dotenv').config();

const databaseOptions = {
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  host: process.env.DB_HOST,
  dialect: 'mysql',
  // Bound mysql2's per-connection cache so polling cannot exhaust the shared
  // MySQL server's prepared-statement budget. Eviction closes old statements.
  dialectOptions: { maxPreparedStatements: 128 },
  // El polling del orquestador no debe volcar cada SELECT en los logs PM2.
  // Se puede habilitar de forma temporal y explícita para un diagnóstico.
  logging: process.env.DB_SQL_LOGGING === 'true' ? console.log : false
};

module.exports = {
  development: { ...databaseOptions },
  test: { ...databaseOptions },
  production: { ...databaseOptions }
};
