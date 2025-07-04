const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controllers');

router.post('/forgot-password', authController.forgotPassword);
router.post('/reset-password', authController.resetPassword);
router.post('/sign-in', authController.signIn);
router.post('/sign-in-with-token', authController.signInWithToken);
router.post('/sign-up', authController.signUp);
router.post('/unlock-session', authController.unlockSession);

module.exports = router;
