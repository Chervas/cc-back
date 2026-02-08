const mysql = require('mysql2/promise');

// Crear una conexión a la base de datos
const pool = mysql.createPool({
    // Use IPv4 loopback explicitly. On this server, MySQL is bound to 127.0.0.1,
    // and using "localhost" can resolve to ::1 first and fail with ECONNREFUSED.
    host: '127.0.0.1',
    user: 'carlos',
    password: '6798261677hH-!',
    database: 'clinicaclick',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

module.exports = pool;
