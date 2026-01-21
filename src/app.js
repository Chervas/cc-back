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
const notificationsRoutes = require('./routes/notifications.routes');
// NUEVAS RUTAS Y MODELOS
const oauthRoutes = require('./routes/oauth.routes');
// NUEVA RUTA: Sistema de métricas de redes sociales
const metaSyncRoutes = require('./routes/metasync.routes');
const whatsappRoutes = require('./routes/whatsapp.routes');
const webRoutes = require('./routes/web.routes');
const localRoutes = require('./routes/local.routes');
const googleAdsRoutes = require('./routes/googleads.routes');
const jobRequestsRoutes = require('./routes/jobrequests.routes');
const intakeRoutes = require('./routes/intake.routes');
const campaignRoutes = require('./routes/campaign.routes');
const campaignRequestRoutes = require('./routes/campaign-request.routes');
const templatesRoutes = require('./routes/templates.routes');
const citasRoutes = require('./routes/citas.routes');
const tratamientosRoutes = require('./routes/tratamientos.routes');
const especialidadesRoutes = require('./routes/especialidades.routes');
const dependenciasRoutes = require('./routes/dependencias.routes');
const jobScheduler = require('./services/jobScheduler.service');
const intakeController = require('./controllers/intake.controller');


// Importar db desde models/index.js que contiene sequelize y todos los modelos
const db = require('../models'); // <-- Importa el objeto db de models/index.js
const app = express();
// Configuración CORS (mantengo tu estructura)
const corsOptions = {
    origin: ['https://app.clinicaclick.com', 'https://crm.clinicaclick.com', 'http://localhost:4200'],
    credentials: true
};
app.use(cors(corsOptions));
app.use(express.json({
    verify: (req, res, buf) => {
        // Guardar el cuerpo crudo para validar firmas HMAC de intake
        req.rawBody = buf;
    }
}));
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
app.use('/api/common/notifications', notificationsRoutes);
console.log('Ruta /api/common/notifications configurada');
// RUTA: OAuth (exponer bajo /api/oauth para proxy y también /oauth por compatibilidad)
app.use('/api/oauth', oauthRoutes);
app.use('/oauth', oauthRoutes);
console.log('Ruta /api/oauth y /oauth configuradas');
// NUEVA RUTA: Sistema de métricas de redes sociales
app.use('/api/metasync', metaSyncRoutes);
console.log('Ruta /api/metasync configurada');
app.use('/api/web', webRoutes);
console.log('Ruta /api/web configurada');
app.use('/api/local', localRoutes);
console.log('Ruta /api/local configurada');
app.use('/api/googleads', googleAdsRoutes);
console.log('Ruta /api/googleads configurada');
app.use('/api/job-requests', jobRequestsRoutes);
console.log('Ruta /api/job-requests configurada');
app.use('/api/whatsapp', whatsappRoutes);
console.log('Ruta /api/whatsapp configurada');
app.use('/api/intake', intakeRoutes);
console.log('Ruta /api/intake configurada');
// Alias directo para webhook de Meta Lead Ads
app.get('/api/leads/webhook', intakeController.verifyMetaWebhook);
app.post('/api/leads/webhook', intakeController.receiveMetaWebhook);
console.log('Ruta /api/leads/webhook configurada');
app.use('/api/campaigns', campaignRoutes);
console.log('Ruta /api/campaigns configurada');
app.use('/api/campaign-requests', campaignRequestRoutes);
console.log('Ruta /api/campaign-requests configurada');
app.use('/api', templatesRoutes);
console.log('Rutas /api/templates, /api/flows, /api/message-log configuradas');
app.use('/api/citas', citasRoutes);
console.log('Ruta /api/citas configurada');
app.use('/api/tratamientos', tratamientosRoutes);
console.log('Ruta /api/tratamientos configurada');
app.use('/api/especialidades', especialidadesRoutes);
console.log('Ruta /api/especialidades configurada');
app.use('/api/dependencias', dependenciasRoutes);
console.log('Ruta /api/dependencias configurada');
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

jobScheduler.start();
console.log('🔁 Job scheduler iniciado');

// Inicializar jobs automáticamente en producción
const { metaSyncJobs } = require('./jobs/sync.jobs');
metaSyncJobs.initialize().catch((error) => {
  console.error('⚠️ No se pudo inicializar el sistema de jobs al arranque:', error.message);
});
const shouldAutoStart = process.env.NODE_ENV === 'production' || process.env.JOBS_AUTO_START === 'true';
if (shouldAutoStart) {
  setTimeout(async () => {
    try {
      console.log('🚀 Inicializando sistema de jobs automáticamente...');
      await metaSyncJobs.initialize();
      metaSyncJobs.start();
      console.log('✅ Sistema de jobs iniciado automáticamente');
    } catch (error) {
      console.error('❌ Error al iniciar jobs automáticamente:', error);
    }
  }, 5000);
}


module.exports = app;
