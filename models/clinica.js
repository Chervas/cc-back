// backendclinicaclick/models/clinica.js
'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class Clinica extends Model {
    static associate(models) {
      // Asociación con GrupoClinica: cada clínica puede pertenecer a un grupo (opcional)
      Clinica.belongsTo(models.GrupoClinica, { foreignKey: 'grupoClinicaId', as: 'grupoClinica' });
      
      // LA SIGUIENTE LÍNEA DEBE SER ELIMINADA DE AQUÍ.
      // La asociación Clinica.belongsToMany(Usuario) se define en models/index.js
      // Clinica.belongsToMany(models.Usuario, { 
      //   through: 'UsuarioClinica', 
      //   foreignKey: 'clinicaId',
      //   as: 'usuarios' // <-- ESTA LÍNEA DEBE SER ELIMINADA
      // });
    }
  }
  
  Clinica.init({
    id_clinica: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    url_web: DataTypes.STRING,
    url_avatar: DataTypes.STRING,
    url_fondo: DataTypes.STRING,
    url_ficha_local: DataTypes.STRING,
    nombre_clinica: DataTypes.STRING,
    fecha_creacion: DataTypes.DATE,
    
    // ✅ AÑADIDO: Campos de contacto que faltaban
    telefono: DataTypes.STRING,
    email: DataTypes.STRING,
    descripcion: DataTypes.TEXT,
    
    // ✅ AÑADIDO: Campos de dirección que faltaban
    direccion: DataTypes.STRING,
    codigo_postal: DataTypes.STRING,
    ciudad: DataTypes.STRING,
    provincia: DataTypes.STRING,
    pais: DataTypes.STRING,
    
    // ✅ AÑADIDO: Campo de horarios que faltaba
    horario_atencion: DataTypes.TEXT,
    
    // Campos existentes de publicidad
    id_publicidad_meta: DataTypes.INTEGER,
    url_publicidad_meta: DataTypes.STRING, 
    filtro_pc_meta: DataTypes.INTEGER,
    id_publicidad_google: DataTypes.INTEGER,
    url_publicidad_google: DataTypes.STRING,
    filtro_pc_google: DataTypes.INTEGER,
    
    // Campos existentes
    servicios: DataTypes.STRING,
    checklist: DataTypes.STRING,
    estado_clinica: DataTypes.BOOLEAN,
    
    // ✅ AÑADIDO: Campo de redes sociales que faltaba
    redes_sociales: {
      type: DataTypes.JSON,
      allowNull: true
    },
    
    // ✅ AÑADIDO: Campo de configuración que faltaba
    configuracion: {
      type: DataTypes.JSON,
      allowNull: true
    },
    
    // Campo existente de datos fiscales
    datos_fiscales_clinica: {
      type: DataTypes.JSON,
      allowNull: true
    },
    
    // Campo existente para asociación con grupo
    grupoClinicaId: {
      type: DataTypes.INTEGER,
      allowNull: true
    }
  }, {
    sequelize,
    modelName: 'Clinica',
    tableName: 'Clinicas',
    timestamps: false
  });
  
  return Clinica;
};
