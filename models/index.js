'use strict';

const fs = require('fs');
const path = require('path');
const Sequelize = require('sequelize');
const basename = path.basename(__filename);
const env = process.env.NODE_ENV || 'development';
// RUTA CORREGIDA: Apunta a src/config/config.js
const config = require(__dirname + '/../src/config/config.js')[env]; 
const db = {};

let sequelize;
if (config.use_env_variable) {
  sequelize = new Sequelize(process.env[config.use_env_variable], config);
} else {
  sequelize = new Sequelize(config.database, config.username, config.password, config);
}

fs
  .readdirSync(__dirname)
  .filter(file => {
    return (
      file.indexOf('.') !== 0 &&
      file !== basename &&
      file.slice(-3) === '.js' &&
      file.indexOf('.test.js') === -1
    );
  })
  .forEach(file => {
    const model = require(path.join(__dirname, file))(sequelize, Sequelize.DataTypes);
    db[model.name] = model;
  });

Object.keys(db).forEach(modelName => {
  if (db[modelName].associate) {
    db[modelName].associate(db);
  }
});

// Asociaciones adicionales
if (db.Usuario && db.Clinica) { 
  db.Usuario.belongsToMany(db.Clinica, { 
    through: 'UsuarioClinica', 
    foreignKey: 'id_usuario',
    as: 'clinicas' // Alias para las clínicas asociadas a un usuario
  });
  db.Clinica.belongsToMany(db.Usuario, { 
    through: 'UsuarioClinica', 
    foreignKey: 'id_clinica',
    as: 'usuarios' // Alias para los usuarios asociados a una clínica
  }); 
}

// Asociación entre Clinica y Servicio (si aplica)
if (db.ClinicaServicio) {
  db.Clinica.belongsToMany(db.Servicio, { through: db.ClinicaServicio, foreignKey: 'id_clinica', otherKey: 'id_servicio' });
  db.Servicio.belongsToMany(db.Clinica, { through: db.ClinicaServicio, foreignKey: 'id_servicio', otherKey: 'id_clinica' });
}

// Asociación para HistorialDeServicios, si no está definida
if (db.HistorialDeServicios && db.Servicio && !db.HistorialDeServicios.associations.servicio) {
  db.HistorialDeServicios.belongsTo(db.Servicio, { foreignKey: 'id_servicio', as: 'servicio' });
}

db.sequelize = sequelize;
db.Sequelize = Sequelize;

console.log('Modelos cargados:', Object.keys(db));

module.exports = db;

