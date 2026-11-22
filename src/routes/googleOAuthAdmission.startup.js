'use strict';

const C = require('../services/googleOAuthAdmissionAttempt.contract');
const { installGoogleOAuthAdmissionRuntime } = require('../services/googleOAuthAdmissionRuntime.service');

function initializeGoogleOAuthAdmissionHttp(oauthRouter,{
  env = process.env,
  install = installGoogleOAuthAdmissionRuntime,
  createAdapter = require('./googleOAuthAdmission.http').createGoogleOAuthAdmissionHttpAdapter,
  authenticate = require('./auth.middleware'),
  warn = console.warn,
} = {}) {
  let runtime;
  try {
    runtime = install({ env });
  } catch {
    // A configured reader can already own emitted return states. An
    // unavailable configuration must not send them to the earlier handler.
    // Keep unrelated routes and application startup available.
    const unavailable = async () => { throw C.problem('google_oauth_admission_attempt_unavailable',503); };
    runtime = {
      capability:unavailable,begin:unavailable,status:unavailable,callback:unavailable,
      settingsOrigin:env.JOB_RUNTIME_NAMESPACE === 'dev' ? 'http://localhost:4203' : 'https://crm.clinicaclick.com',
    };
    warn('[google-first-admission] configured runtime unavailable');
  }
  if (!runtime) return;
  oauthRouter.installGoogleOAuthAdmissionHttp(createAdapter({ runtime,authenticate,returnOrigin:runtime.settingsOrigin }));
}

module.exports = { initializeGoogleOAuthAdmissionHttp };
