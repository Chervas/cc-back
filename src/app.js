require('dotenv').config(); // Asegúrate de que .env está en la raíz del proyecto
if (!process.env.GROQ_API_KEY) {
    console.warn('[startup] GROQ_API_KEY no está definida. Los nodos condition/ai_analysis fallarán hasta corregir la configuración del entorno.');
}
const cors = require('cors');
const express = require('express');
const crypto = require('node:crypto');
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
const { landingIntakeHandlers } = require('./routes/webLandingIntake.handlers');
const { landingEventBridgeHandlers } = require('./routes/webLandingEventBridge.handlers');
const webHostedOrigin = require('./middleware/webHostedOrigin.middleware');
const campaignRoutes = require('./routes/campaign.routes');
const campaignRequestRoutes = require('./routes/campaign-request.routes');
const templatesRoutes = require('./routes/templates.routes');
const marketingRoutes = require('./routes/marketing.routes');
const marketingTrackingRoutes = require('./routes/marketingTracking.routes');
const automationsRoutes = require('./routes/automations.routes');
const automationCatalogRoutes = require('./routes/automationCatalog.routes');
const adminCampaignPlaybooksRoutes = require('./routes/adminCampaignPlaybooks.routes');
const adminManagedCampaignsRoutes = require('./routes/adminManagedCampaigns.routes');
const adminWebRuntimeReconciliationsRoutes = require('./routes/adminWebRuntimeReconciliations.routes');
const consentimientosRoutes = require('./routes/consentimientos.routes');
const metaRoutes = require('./routes/meta.routes');
const citasRoutes = require('./routes/citas.routes');
const tratamientosRoutes = require('./routes/tratamientos.routes');
const especialidadesRoutes = require('./routes/especialidades.routes');
const dependenciasRoutes = require('./routes/dependencias.routes');
const conversationRoutes = require('./routes/conversation.routes');
const whatsappWebhookRoutes = require('./routes/whatsapp-webhook.routes');
const instalacionesRoutes = require('./routes/instalaciones.routes');
const doctoresRoutes = require('./routes/doctores.routes');
const disponibilidadRoutes = require('./routes/disponibilidad.routes');
const personalRoutes = require('./routes/personal.routes');
const accessPolicyRoutes = require('./routes/access-policy.routes');
const publicMediaRoutes = require('./routes/publicMedia.routes');
const jobScheduler = require('./services/jobScheduler.service');
const intakeController = require('./controllers/intake.controller');
const { setIO, onBusEvent } = require('./services/socket.service');
const { isGlobalAdmin } = require('./lib/role-helpers');
const { buildQuickChatContextFromMemberships } = require('./lib/quickchat-helpers');
const { canUserAccessFeature } = require('./lib/access-policy');
require('./workers/queue.workers');

const RUNTIME_ROLE = String(process.env.RUNTIME_ROLE || '').trim().toLowerCase();
const IS_GATEWAY_RUNTIME = RUNTIME_ROLE === 'gateway';
const RESUME_AUTOMATIONS_FROM_SOCKET_BUS =
    String(process.env.AUTOMATIONS_V2_RESUME_FROM_SOCKET_BUS || '').trim().toLowerCase() === 'true';

// Importar db desde models/index.js que contiene sequelize y todos los modelos
const db = require('../models'); // <-- Importa el objeto db de models/index.js
const app = express();
// Nginx corre en el mismo host. Solo sus redes locales pueden aportar XFF;
// un cliente directo no puede suplantar la IP usada en intake/rate limits.
app.set('trust proxy', process.env.HTTP_TRUST_PROXY || 'loopback');
const server = http.createServer(app);
// CORS:
// - UI (app/crm/local) queda en allowlist.
// - Snippet web (intake) necesita poder llamar desde dominios externos (validación real en /api/intake/*).
const STATIC_CORS_ORIGINS = new Set([
    'https://app.clinicaclick.com',
    'https://crm.clinicaclick.com',
    'http://localhost:4200',
    'http://localhost:4201',
    'http://localhost:4202',
    'http://localhost:4203'
]);
const HTTP_JSON_BODY_LIMIT = process.env.HTTP_JSON_BODY_LIMIT || '25mb';
const {
    MARKETING_WEB_JSON_LIMIT_BYTES,
    invalidMarketingWebJsonResponse,
    isMarketingWebJsonPath,
} = require('./lib/marketingWebRequestGuards');

function isJsonContentType(req) {
    const contentType = String(req.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase();
    return contentType === 'application/json' || /^application\/[a-z0-9.+-]+\+json$/.test(contentType);
}

function requestIdForWebGuard(req) {
    const supplied = String(req.get('X-Request-Id') || '').trim();
    return /^[A-Za-z0-9][A-Za-z0-9._:-]{7,79}$/.test(supplied)
        ? supplied
        : crypto.randomUUID();
}

function isPublicIntakePath(pathname = '') {
    if (typeof pathname !== 'string') return false;
    const normalizedPath = pathname.split('?')[0].replace(/\/+$/, '');
    return new Set([
        '/api/intake/config',
        '/api/intake/leads',
        '/api/intake/landing-leads',
        '/api/intake/leads/webhook',
        '/api/intake/events',
        '/api/intake/whatsapp-origin'
    ]).has(normalizedPath);
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
    // (domain allowlist + mandatory scoped or server-to-server HMAC).
    if (isPublicIntakePath(pathname)) {
        return callback(null, { origin: true, credentials: false });
    }

    return callback(null, { origin: false });
};

app.use(cors(corsOptionsDelegate));
const marketingWebJsonParser = express.json({
    limit: MARKETING_WEB_JSON_LIMIT_BYTES,
    type: isJsonContentType,
    verify: (req, res, buf) => { req.rawBody = buf; },
});
app.use((req, res, next) => {
    if (!isMarketingWebJsonPath(req.originalUrl || req.url || req.path)) return next();
    const method = String(req.method || 'GET').toUpperCase();
    if (['POST', 'PUT', 'PATCH'].includes(method) && !isJsonContentType(req)) {
        const requestId = requestIdForWebGuard(req);
        res.set('X-Request-Id', requestId);
        res.set('Cache-Control', 'no-store');
        return res.status(415).json({
            success: false,
            error: {
                code: 'marketing_web_unsupported_media_type',
                message: 'Estas operaciones requieren Content-Type: application/json.',
            },
            request_id: requestId,
        });
    }
    return marketingWebJsonParser(req, res, next);
});
app.use(express.json({
    limit: HTTP_JSON_BODY_LIMIT,
    // Las rutas del editor ya han pasado por su parser estricto de 1 MB.
    type: (req) => !isMarketingWebJsonPath(req.originalUrl || req.url || req.path) && isJsonContentType(req),
    verify: (req, res, buf) => {
        // Guardar el cuerpo crudo para validar firmas HMAC de intake
        req.rawBody = buf;
    }
}));
const landingIntakeParser = express.urlencoded({
    extended: false,
    limit: 16 * 1024,
    parameterLimit: 20,
    type: 'application/x-www-form-urlencoded',
    verify: (req, res, buf) => { req.rawBody = buf; },
});
app.use(['/api/intake/landing-leads', '/_clinicaclick/intake'], (req, res, next) => {
    if (String(req.method || '').toUpperCase() !== 'POST') return next();
    const contentType = String(req.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (contentType !== 'application/x-www-form-urlencoded') {
        return res.status(415).json({
            success: false,
            error: { code: 'web_landing_unsupported_media_type', message: 'El formulario no tiene un formato válido.' },
        });
    }
    return landingIntakeParser(req, res, (error) => {
        if (!error) return next();
        const tooLarge = error?.type === 'entity.too.large';
        return res.status(tooLarge ? 413 : 400).json({
            success: false,
            error: {
                code: tooLarge ? 'web_landing_payload_too_large' : 'web_landing_body_invalid',
                message: 'El formulario no tiene un formato válido.',
            },
        });
    });
});
app.post('/_clinicaclick/intake', ...landingIntakeHandlers);
app.post('/_clinicaclick/events', ...landingEventBridgeHandlers);
app.use(webHostedOrigin);
app.use(express.urlencoded({ extended: true, limit: HTTP_JSON_BODY_LIMIT }));
app.use(cookieParser());
app.use('/', marketingTrackingRoutes);
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
// Alias directo para webhook de Meta Lead Ads.
// El CRUD canónico de leads vive en /api/intake/leads.
app.get('/api/leads/webhook', intakeController.verifyMetaWebhook);
app.post('/api/leads/webhook', intakeController.receiveMetaWebhook);
console.log('Ruta /api/leads/webhook configurada');
app.use('/api/campanas', campanaRoutes);
console.log('Ruta /api/campanas configurada');
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
app.use('/api/admin/campaign-playbooks', adminCampaignPlaybooksRoutes);
console.log('Ruta /api/admin/campaign-playbooks configurada');
app.use('/api/admin/managed-campaigns', adminManagedCampaignsRoutes);
console.log('Ruta /api/admin/managed-campaigns configurada');
app.use('/api/admin/web-runtime-reconciliations', adminWebRuntimeReconciliationsRoutes);
console.log('Ruta /api/admin/web-runtime-reconciliations configurada');
app.use('/api/consentimientos', consentimientosRoutes);
console.log('Ruta /api/consentimientos configurada');
app.use('/api/meta', metaRoutes);
console.log('Ruta /api/meta configurada');
app.use('/api', whatsappWebhookRoutes);
console.log('Ruta /api/whatsapp/webhook configurada');
app.use('/api', templatesRoutes);
console.log('Rutas /api/templates y /api/message-log configuradas');
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
app.use('/api/public-media', publicMediaRoutes);
console.log('Ruta /api/public-media configurada');
app.use('/api/disponibilidad', disponibilidadRoutes);
console.log('Ruta /api/disponibilidad configurada');
app.use('/api/tratamientos', tratamientosRoutes);
console.log('Ruta /api/tratamientos configurada');
app.use('/api/especialidades', especialidadesRoutes);
console.log('Ruta /api/especialidades configurada');
app.use('/api/dependencias', dependenciasRoutes);
console.log('Ruta /api/dependencias configurada');
app.use('/api', conversationRoutes);
console.log('Ruta /api/conversations configurada');
app.use('/api/whatsapp', require('./routes/whatsapp-embedded.routes'));
console.log('Ruta /api/whatsapp embedded configurada');
console.log('Routes registered successfully');
app.use((error, req, res, next) => {
    const requestPath = String(req.originalUrl || req.url || req.path || '').split('?')[0];
    const invalidJsonPayload = invalidMarketingWebJsonResponse(error, requestPath);
    if (invalidJsonPayload) {
        const requestId = requestIdForWebGuard(req);
        res.set('X-Request-Id', requestId);
        res.set('Cache-Control', 'no-store');
        return res.status(400).json({
            ...invalidJsonPayload,
            request_id: requestId,
        });
    }
    const webPayloadTooLarge = isMarketingWebJsonPath(req.originalUrl || req.url || req.path)
        && (error?.code === 'marketing_web_payload_too_large' || error?.type === 'entity.too.large');
    if (!webPayloadTooLarge) return next(error);
    const requestId = requestIdForWebGuard(req);
    res.set('X-Request-Id', requestId);
    res.set('Cache-Control', 'no-store');
    return res.status(413).json({
        success: false,
        error: {
            code: 'marketing_web_payload_too_large',
            message: 'El documento supera el límite de 1 MB permitido por el editor web.',
            details: { limit_bytes: MARKETING_WEB_JSON_LIMIT_BYTES },
        },
        request_id: requestId,
    });
});
// Puerto del servidor
const PORT = process.env.PORT || 3000;
// Socket.io
const io = new Server(server, {
    cors: {
        origin: Array.from(STATIC_CORS_ORIGINS),
        credentials: true
    }
});
setIO(io);
const automationsV2ResumeService = require('./services/automationsV2Resume.service');

// Con gateway vivo, el webhook inbound coordina una sola reanudacion y encola
// el job en el namespace propietario del flujo. El bus queda solo como opt-in
// legacy para evitar que dev/staging dupliquen respuestas del mismo mensaje.
if (RESUME_AUTOMATIONS_FROM_SOCKET_BUS) {
    onBusEvent(async (envelope) => {
        if (envelope?.event !== 'message:created') {
            return;
        }

        const payload = envelope?.payload && typeof envelope.payload === 'object'
            ? envelope.payload
            : null;
        if (!payload || String(payload.direction || '').toLowerCase() !== 'inbound') {
            return;
        }

        const conversationId = Number.parseInt(String(payload.conversation_id || payload.conversationId || ''), 10);
        if (!Number.isInteger(conversationId) || conversationId <= 0) {
            return;
        }

        let text = typeof payload.resume_text === 'string'
            ? payload.resume_text.trim()
            : (typeof payload?.metadata?.resume_text === 'string'
                ? payload.metadata.resume_text.trim()
                : (typeof payload.content === 'string' ? payload.content.trim() : ''));

        if (!text && String(payload?.message_type || '').toLowerCase() === 'reaction') {
            const emoji = String(payload?.metadata?.reaction?.emoji || '').trim();
            text = emoji
                ? `El paciente reaccionó ${emoji} a tu mensaje`
                : 'El paciente reaccionó a tu mensaje';
        }
        if (!text) {
            return;
        }

        try {
            const conv = await db.Conversation.findByPk(conversationId, {
                attributes: ['id', 'clinic_id', 'patient_id', 'lead_id'],
                raw: true,
            });

            if (!conv?.clinic_id) {
                return;
            }

            await automationsV2ResumeService.enqueueInboundResponseResume({
                clinicId: conv.clinic_id,
                conversationId: conv.id,
                patientId: conv.patient_id || null,
                leadId: conv.lead_id || null,
                messageText: text,
                inboundMessageId: payload.id || null,
                channel: 'whatsapp',
            });
        } catch (error) {
            console.warn('[automations-v2] No se pudo reanudar wait_response desde socket-bus:', error?.message || error);
        }
    });
} else {
    console.log('[automations-v2] Reanudacion por socket-bus deshabilitada; el gateway coordina inbound');
}
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

    const userIsGlobalAdmin = isGlobalAdmin(userId);

    // Unir al room del usuario
    socket.join(`user:${userId}`);

    // Cargar clínicas permitidas para el usuario
    const memberships = await db.UsuarioClinica.findAll({
        where: { id_usuario: userId },
        attributes: ['id_clinica', 'rol_clinica', 'subrol_clinica'],
        raw: true
    });
    const allClinicIds = userIsGlobalAdmin
        ? (await db.Clinica.findAll({ attributes: ['id_clinica'], raw: true })).map((row) => row.id_clinica)
        : [];
    const quickChatContext = buildQuickChatContextFromMemberships(memberships, {
        isGlobalAdmin: userIsGlobalAdmin,
        allClinicIds,
    });
    // Los rooms de clínica transportan eventos con contenido de conversaciones.
    // Un perfil que solo pueda leer chats internos no debe entrar en ellos: el
    // mismo room también recibe mensajes de pacientes y leads. Esos perfiles
    // conservan REST/polling para su ámbito no sensible.
    const realtimeClinicDecisions = await Promise.all(quickChatContext.clinicIds.map(async (clinicId) => {
        const [readPatients, readLeads, patientSensitive, leadSensitive] = await Promise.all([
            canUserAccessFeature({ actorId: userId, featureKey: 'quickchat.read_patients', clinicId }),
            canUserAccessFeature({ actorId: userId, featureKey: 'quickchat.read_leads', clinicId }),
            canUserAccessFeature({ actorId: userId, featureKey: 'patients.sensitive.view', clinicId }),
            canUserAccessFeature({ actorId: userId, featureKey: 'leads.sensitive.view', clinicId }),
        ]);
        return {
            clinicId,
            allowed: (readPatients && patientSensitive) || (readLeads && leadSensitive),
        };
    }));
    const allowedClinicIds = realtimeClinicDecisions
        .filter((decision) => decision.allowed)
        .map((decision) => decision.clinicId);
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

// El liderazgo del cron debe ser explícito para evitar que varios runtimes
// (integracion/auth/staging) encolen el mismo trabajo por hora.
// El worker de JobRequests va por separado: staging debe poder ejecutar sus
// automatizaciones y resumes aunque no sea el leader de cron.
const isCronLeader = process.env.JOBS_CRON_LEADER === 'true';
const shouldStartWorker = process.env.JOBS_WORKER_ENABLED !== 'false';
const shouldStartCron = isCronLeader && (process.env.NODE_ENV === 'production' || process.env.JOBS_AUTO_START === 'true');
if (shouldStartWorker) {
    jobScheduler.start()
      .then((report) => {
        if (report?.status === 'started') {
          console.log(`🔁 Job scheduler iniciado y recuperación completada en ${report.startupAttempts || 1} intento(s)`);
        } else {
          console.log(`⏹️ Job scheduler detenido durante el arranque (${report?.status || 'sin estado'})`);
        }
      })
      .catch((error) => console.error('❌ No se pudo iniciar el Job scheduler:', error.message));
} else {
    console.log(`⏸️ Job scheduler deshabilitado (JOBS_WORKER_ENABLED=${process.env.JOBS_WORKER_ENABLED || 'true'})`);
}

// Inicializar jobs automáticamente en producción
const { metaSyncJobs } = require('./jobs/sync.jobs');
if (IS_GATEWAY_RUNTIME) {
  console.log('⏸️ Cron jobs no registrados en runtime gateway');
} else {
  metaSyncJobs.initialize().catch((error) => {
    console.error('⚠️ No se pudo inicializar el sistema de jobs al arranque:', error.message);
  });
}
if (!IS_GATEWAY_RUNTIME && shouldStartCron) {
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
} else if (!IS_GATEWAY_RUNTIME) {
  console.log(`⏸️ Cron jobs deshabilitados en este runtime (JOBS_CRON_LEADER=${process.env.JOBS_CRON_LEADER || 'false'})`);
}


module.exports = app;
