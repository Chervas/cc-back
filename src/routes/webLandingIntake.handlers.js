'use strict';

const intakeController = require('../controllers/intake.controller');
const webLandingIntakeController = require('../controllers/webLandingIntake.controller');
const { createPublicMarketingWebRateLimiter } = require('../lib/marketingWebRequestGuards');

const publicWebRateLimit = createPublicMarketingWebRateLimiter();

const landingIntakeHandlers = [
  // Primera barrera barata, por IP real resuelta por Express. Protege las
  // consultas criptográficas/BD aunque alguien rote identificadores falsos.
  publicWebRateLimit({
    operation: 'landing_intake_prepare',
    limit: 60,
    globalIpLimit: 240,
    windowMs: 10 * 60 * 1000,
    identity: () => '00000000-0000-4000-8000-000000000000',
  }),
  webLandingIntakeController.prepare,
  // A partir de aquí cualquier error del bridge (incluido un 429) vuelve a la
  // landing y muestra su estado de error; nunca deja al paciente en una página JSON.
  webLandingIntakeController.redirectResponse,
  // El segundo bucket usa una publicación ya validada contra revisión,
  // artefacto, host y path. Dos clientes distintos nunca comparten el límite.
  publicWebRateLimit({
    operation: 'landing_intake',
    limit: 8,
    globalIpLimit: 64,
    windowMs: 10 * 60 * 1000,
    identity: (req) => req.webLandingRateLimitIdentity,
  }),
  intakeController.ingestLead,
  webLandingIntakeController.redirectError,
];

module.exports = { landingIntakeHandlers };
