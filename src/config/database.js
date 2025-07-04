// config/database.js
require('dotenv').config();
const { Sequelize } = require('sequelize');
const env = process.env.NODE_ENV || 'development';
const cfg = require('./config')[env];

const sequelize = new Sequelize(
  cfg.database,
  cfg.username,
  cfg.password,
  {
    host: cfg.host,
    dialect: cfg.dialect,
    logging: false,          // quita o activa si quieres ver SQL por consola
  }
);

module.exports = sequelize;
