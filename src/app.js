require('dotenv').config(); // Asegúrate de que .env está en la raíz del proyecto
const cors = require('cors');
const express = require('express');
const cookieParser = require('cookie-parser');
// Importar rutas existentes
const userRoutes = require('./routes/user.routes');
const authRoutes = require('./routes/auth.routes');
const clinicaRoutes = require('./routes/clinica.routes');
const servicioRoutes = require('./routes/servicio.routes');
const clinicaServicioRoutes = require('./routes/clinicaservicio.route');
const historialDeServiciosRoutes = require('./routes/historialdeservicios.route');
const gruposClinicasRoutes = require('./routes/gruposclinicas.routes');
const pacienteRoutes = require('./routes/paciente.routes');
const campanaRoutes = require('./routes/campana.routes');
const leadRoutes = require('./routes/lead.routes');
const panelesRoutes = require('./routes/paneles.routes');
const userClinicasRoutes = require('./routes/userclinicas.routes');
// NUEVAS RUTAS Y MODELOS
const oauthRoutes = require('./routes/oauth.routes');
// NUEVA RUTA: Sistema de métricas de redes sociales
const metaSyncRoutes = require('./routes/metasync.routes');


// Importar db desde models/index.js que contiene sequelize y todos los modelos
const db = require('../models'); // <-- Importa el objeto db de models/index.js
const app = express();
// Configuración CORS (mantengo tu estructura)
const corsOptions = {
    origin: ['https://crm.clinicaclick.com', 'http://localhost:4200'],
    credentials: true
};
app.use(cors(corsOptions));
app.use(express.json());
app.use(cookieParser());
// ✅ CORREGIDO: Usar rutas con prefijo /api/ como en la versión que funcionaba
console.log('Configurando rutas...');
app.use('/api/users', userRoutes);
console.log('Ruta /api/users configurada');
app.use('/api/auth', authRoutes);  // ✅ CAMBIO PRINCIPAL: Añadir /api/
console.log('Ruta /api/auth configurada');
app.use('/api/clinicas', clinicaRoutes);
console.log('Ruta /api/clinicas configurada');
app.use('/api/servicios', servicioRoutes);
console.log('Ruta /api/servicios configurada');
app.use('/api/clinicaservicio', clinicaServicioRoutes);
console.log('Ruta /api/clinicaservicio configurada');
app.use('/api/historialdeservicios', historialDeServiciosRoutes);
console.log('Ruta /api/historialdeservicios configurada');
app.use('/api/gruposclinicas', gruposClinicasRoutes);
console.log('Ruta /api/gruposclinicas configurada');
app.use('/api/pacientes', pacienteRoutes);
console.log('Ruta /api/pacientes configurada');
app.use('/api/campanas', campanaRoutes);
console.log('Ruta /api/campanas configurada');
app.use('/api/leads', leadRoutes);
console.log('Ruta /api/leads configurada');
app.use('/api/paneles', panelesRoutes);
console.log('Ruta /api/paneles configurada');
app.use('/api/userclinicas', userClinicasRoutes);
console.log('Ruta /api/userclinicas configurada');
// NUEVA RUTA: OAuth (sin /api/ porque es para OAuth2)
app.use('/oauth', oauthRoutes);
console.log('Ruta /oauth configurada');
// NUEVA RUTA: Sistema de métricas de redes sociales
app.use('/api/metasync', metaSyncRoutes);
console.log('Ruta /api/metasync configurada');
console.log('Routes registered successfully');
// Puerto del servidor
const PORT = process.env.PORT || 3000;
// Sincronizar modelos con la base de datos
db.sequelize.authenticate() // <-- Usar db.sequelize
    .then(() => console.log('Conexión a la base de datos establecida correctamente.'))
    .catch(err => console.error('No se pudo conectar a la base de datos:', err));
// Sincronizar modelos (comentado porque usamos migraciones)
// db.sequelize.sync({ alter: true }) // <-- Usar db.sequelize
//     .then(() => console.log('Modelos de la base de datos sincronizados.'))
//     .catch(err => console.error('Error al sincronizar modelos de la base de datos:', err));
app.listen(PORT, () => {
    console.log(`Servidor backend escuchando en el puerto ${PORT}`);
});


// Inicializar jobs automáticamente en producción
const { metaSyncJobs } = require('./jobs/metasync.jobs');
if (process.env.NODE_ENV === 'production') {
  setTimeout(async () => {
    try {
      console.log('🚀 Inicializando sistema de jobs automáticamente...');
      await metaSyncJobs.initialize();
      metaSyncJobs.start();
      console.log('✅ Sistema de jobs iniciado automáticamente');
    } catch (error) {
      console.error('❌ Error al inicializar jobs automáticamente:', error);
    }
  }, 5000); // Esperar 5 segundos después del arranque
}


module.exports = app;
