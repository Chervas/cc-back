'use strict';
const mysql = require('mysql2/promise');
const config = require('./config')[process.env.NODE_ENV || 'development'];
if (!config || ['host', 'username', 'password', 'database'].some(key => typeof config[key] !== 'string' || !config[key].length)) {
    throw Error('database_configuration_missing');
}

// Legacy pool retains its interface, using the same approved configuration as Sequelize.
// No embedded credentials and no fallback identity.
const pool = mysql.createPool({
    host: config.host,
    user: config.username,
    password: config.password,
    database: config.database,
    ...config.dialectOptions,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
});
module.exports = pool;
