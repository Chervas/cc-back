require('dotenv').config(); // Asegúrate de que .env está en la raíz del proyecto
const cors = require('cors');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
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
const marketingRoutes = require('./routes/marketing.routes');
const automationsRoutes = require('./routes/automations.routes');
const automationCatalogRoutes = require('./routes/automationCatalog.routes');
const citasRoutes = require('./routes/citas.routes');
const tratamientosRoutes = require('./routes/tratamientos.routes');
const appointmentFlowTemplatesRoutes = require('./routes/appointment-flow-templates.routes');
const especialidadesRoutes = require('./routes/especialidades.routes');
const dependenciasRoutes = require('./routes/dependencias.routes');
const conversationRoutes = require('./routes/conversation.routes');
const whatsappWebhookRoutes = require('./routes/whatsapp-webhook.routes');
const instalacionesRoutes = require('./routes/instalaciones.routes');
const doctoresRoutes = require('./routes/doctores.routes');
const disponibilidadRoutes = require('./routes/disponibilidad.routes');
const personalRoutes = require('./routes/personal.routes');
const accessPolicyRoutes = require('./routes/access-policy.routes');
const jobScheduler = require('./services/jobScheduler.service');
const intakeController = require('./controllers/intake.controller');
const { setIO } = require('./services/socket.service');
const { isGlobalAdmin } = require('./lib/role-helpers');
const { buildQuickChatContextFromMemberships } = require('./lib/quickchat-helpers');
require('./workers/queue.workers');


// Importar db desde models/index.js que contiene sequelize y todos los modelos
const db = require('../models'); // <-- Importa el objeto db de models/index.js
const app = express();
const server = http.createServer(app);
// CORS:
// - UI (app/crm/local) queda en allowlist.
// - Snippet web (intake) necesita poder llamar desde dominios externos (validación real en /api/intake/*).
const STATIC_CORS_ORIGINS = new Set([
    'https://app.clinicaclick.com',
    'https://crm.clinicaclick.com',
    'http://localhost:4200',
    'http://localhost:4201'
]);

function isPublicIntakePath(pathname = '') {
    return (
        typeof pathname === 'string' &&
        (pathname === '/api/intake/config' ||
            pathname === '/api/intake/leads' ||
            pathname === '/api/intake/events' ||
            pathname.startsWith('/api/intake/'))
    );
}

const corsOptionsDelegate = (req, callback) => {
    const origin = req.header('Origin');
    const pathname = req.path || req.originalUrl || '';

    // Requests without Origin header (server-to-server) don't need CORS headers.
    if (!origin) {
        return callback(null, { origin: false });
    }

    if (STATIC_CORS_ORIGINS.has(origin)) {
        return callback(null, { origin: true, credentials: true });
    }

    // Allow external origins for the intake snippet endpoints. Security is enforced inside the controllers
    // (domain allowlist + optional HMAC).
    if (isPublicIntakePath(pathname)) {
        return callback(null, { origin: true, credentials: false });
    }

    return callback(null, { origin: false });
};

app.use(cors(corsOptionsDelegate));
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
// Alias (compat) usado por algunos componentes del frontend
app.use('/api/grupos-clinicas', gruposClinicasRoutes);
console.log('Ruta /api/grupos-clinicas configurada');
app.use('/api/pacientes', pacienteRoutes);
console.log('Ruta /api/pacientes configurada');
// Alias directo para webhook de Meta Lead Ads (antes de leadRoutes con auth)
app.get('/api/leads/webhook', intakeController.verifyMetaWebhook);
app.post('/api/leads/webhook', intakeController.receiveMetaWebhook);
console.log('Ruta /api/leads/webhook configurada');
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
app.use('/api/campaigns', campaignRoutes);
console.log('Ruta /api/campaigns configurada');
app.use('/api/campaign-requests', campaignRequestRoutes);
console.log('Ruta /api/campaign-requests configurada');
app.use('/api/marketing', marketingRoutes);
console.log('Ruta /api/marketing configurada');
app.use('/api/automations', automationsRoutes);
console.log('Ruta /api/automations configurada');
app.use('/api/automation-catalog', automationCatalogRoutes);
console.log('Ruta /api/automation-catalog configurada');
app.use('/api', whatsappWebhookRoutes);
console.log('Ruta /api/whatsapp/webhook configurada');
app.use('/api', templatesRoutes);
console.log('Rutas /api/templates, /api/flows, /api/message-log configuradas');
app.use('/api/citas', citasRoutes);
console.log('Ruta /api/citas configurada');
app.use('/api/instalaciones', instalacionesRoutes);
console.log('Ruta /api/instalaciones configurada');
app.use('/api/doctores', doctoresRoutes);
console.log('Ruta /api/doctores configurada');
// Alias en inglés para compatibilidad con front
app.use('/api/doctors', doctoresRoutes);
console.log('Ruta /api/doctors configurada');
app.use('/api/personal', personalRoutes);
console.log('Ruta /api/personal configurada');
app.use('/api/access-policies', accessPolicyRoutes);
console.log('Ruta /api/access-policies configurada');
app.use('/api/disponibilidad', disponibilidadRoutes);
console.log('Ruta /api/disponibilidad configurada');
app.use('/api/tratamientos', tratamientosRoutes);
console.log('Ruta /api/tratamientos configurada');
app.use('/api/appointment-flow-templates', appointmentFlowTemplatesRoutes);
console.log('Ruta /api/appointment-flow-templates configurada');
app.use('/api/especialidades', especialidadesRoutes);
console.log('Ruta /api/especialidades configurada');
app.use('/api/dependencias', dependenciasRoutes);
console.log('Ruta /api/dependencias configurada');
app.use('/api', conversationRoutes);
console.log('Ruta /api/conversations configurada');
app.use('/api/whatsapp', require('./routes/whatsapp-embedded.routes'));
console.log('Ruta /api/whatsapp embedded configurada');
console.log('Routes registered successfully');
// Puerto del servidor
const PORT = process.env.PORT || 3000;
// Socket.io
const io = new Server(server, {
    cors: {
        origin: ['https://app.clinicaclick.com', 'https://crm.clinicaclick.com', 'http://localhost:4200'],
        credentials: true
    }
});
setIO(io);
io.use((socket, next) => {
    const token =
        socket.handshake.auth?.token ||
        socket.handshake.headers?.authorization?.split(' ')[1];
    if (!token) {
        return next(new Error('auth_required'));
    }
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        socket.userData = { userId: decoded.userId, email: decoded.email };
        return next();
    } catch (err) {
        return next(new Error('auth_invalid'));
    }
});

io.on('connection', async (socket) => {
    const userId = socket.userData?.userId;
    console.log('Socket.io conectado', socket.id, 'user', userId);

    if (!userId) {
        return;
    }

    // Unir al room del usuario
    socket.join(`user:${userId}`);

    // Cargar clínicas permitidas para el usuario
    const memberships = await db.UsuarioClinica.findAll({
        where: { id_usuario: userId },
        attributes: ['id_clinica', 'rol_clinica', 'subrol_clinica'],
        raw: true
    });
    const quickChatContext = buildQuickChatContextFromMemberships(memberships, {
        isGlobalAdmin: isGlobalAdmin(userId),
    });
    const allowedClinicIds = quickChatContext.clinicIds.filter((clinicId) => {
        const permissions = quickChatContext.permissionsByClinic.get(clinicId);
        return !!permissions && (permissions.readTeam || permissions.readPatients);
    });
    const canUseAllClinics = quickChatContext.canUseAllClinics;

    socket.data.allowedClinicIds = allowedClinicIds;
    socket.data.canUseAllClinics = canUseAllClinics;

    // Suscripción inicial: solo "todas" si el perfil lo permite.
    const initialRooms = canUseAllClinics ? [...allowedClinicIds] : [];
    initialRooms.forEach((clinicId) => socket.join(`clinic:${clinicId}`));
    socket.data.clinicRooms = initialRooms;
    if (process.env.CHAT_DEBUG === 'true') {
        console.log('[CHAT] initial rooms', socket.id, {
            allowedClinicIds,
            canUseAllClinics,
            joined: socket.data.clinicRooms,
        });
    }

    // Suscripción dinámica desde frontend
    socket.on('subscribe', (requested = []) => {
        const requestedIds = Array.isArray(requested)
            ? requested.map((id) => Number(id)).filter((id) => Number.isFinite(id))
            : [];

        const requestedAllowed = Array.from(new Set(requestedIds))
            .filter((id) => allowedClinicIds.includes(id));
        const targetIds =
            requestedAllowed.length > 0
                ? requestedAllowed
                : (canUseAllClinics ? allowedClinicIds : []);

        const previous = socket.data.clinicRooms || [];
        previous.forEach((id) => socket.leave(`clinic:${id}`));
        targetIds.forEach((id) => socket.join(`clinic:${id}`));
        socket.data.clinicRooms = [...targetIds];
        if (process.env.CHAT_DEBUG === 'true') {
            console.log('[CHAT] subscribe', socket.id, {
                requested,
                requestedAllowed,
                targetIds,
                allowedClinicIds,
                canUseAllClinics,
            });
        }
    });
});
// Sincronizar modelos con la base de datos
db.sequelize.authenticate() // <-- Usar db.sequelize
    .then(() => console.log('Conexión a la base de datos establecida correctamente.'))
    .catch(err => console.error('No se pudo conectar a la base de datos:', err));
// Sincronizar modelos (comentado porque usamos migraciones)
// db.sequelize.sync({ alter: true }) // <-- Usar db.sequelize
//     .then(() => console.log('Modelos de la base de datos sincronizados.'))
//     .catch(err => console.error('Error al sincronizar modelos de la base de datos:', err));
server.listen(PORT, () => {
    console.log(`Servidor backend escuchando en el puerto ${PORT}`);
});

// Importante: staging puede levantar un backend separado en otro puerto.
// Para evitar duplicar workers (jobs/colas), el scheduler se controla con JOBS_AUTO_START.
const shouldAutoStart = process.env.NODE_ENV === 'production' || process.env.JOBS_AUTO_START === 'true';
if (shouldAutoStart) {
    jobScheduler.start();
    console.log('🔁 Job scheduler iniciado');
} else {
    console.log('⏸️ Job scheduler deshabilitado (JOBS_AUTO_START=false)');
}

// Inicializar jobs automáticamente en producción
const { metaSyncJobs } = require('./jobs/sync.jobs');
metaSyncJobs.initialize().catch((error) => {
  console.error('⚠️ No se pudo inicializar el sistema de jobs al arranque:', error.message);
});
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
