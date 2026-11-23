'use strict';
// Explicitly gated canonical scheduled-job entrypoint. No HTTP exposure.
module.exports={run:()=>require('./googleOAuthAdmissionRuntime.service').runGoogleOAuthAdmissionRecovery()};
