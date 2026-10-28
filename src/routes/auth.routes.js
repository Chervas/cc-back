const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controllers');
router.use('/delegations', require('./authDelegations.routes').createRouter());
// Public recovery/login commands keep their existing public contracts, but an
// authenticated child cannot use its context to operate on login credentials.
router.use(['/forgot-password', '/reset-password', '/sign-in', '/sign-up', '/unlock-session', '/email-code/verify', '/email-code/resend', '/claim-invite'], (req, res, next) => {
    let token;
    try { token = require('../services/accessSession.service').bearer(req.headers.authorization); } catch { return next(); }
    if (!require('../services/delegatedSession.service').isDelegatedToken(token)) return next();
    return require('./auth.middleware')(req, res, next);
});

router.post('/forgot-password', authController.forgotPassword);
router.post('/reset-password', authController.resetPassword);
router.post('/sign-in', authController.signIn);
router.post('/email-code/verify', authController.verifyEmailCode);
router.post('/email-code/resend', authController.resendEmailCode);
router.post('/email-code/step-up', require('./auth.middleware'), authController.beginEmailStepUp);
router.post('/sign-in-with-token', authController.signInWithToken);
router.post('/sign-up', authController.signUp);
router.post('/unlock-session', authController.unlockSession);
router.get('/me', require('./auth.middleware'), authController.me);
router.post('/sign-out', authController.signOut);
router.post('/revoke-sessions', authController.revokeSessions);

// ── Onboarding: reclamar cuenta provisional (público, sin JWT) ──
const personalController = require('../controllers/personal.controller');
router.post('/claim-invite', personalController.reclamarCuenta);

module.exports = router;
