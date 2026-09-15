require('dotenv').config();
const sessions = require('../services/accessSession.service');
const platformAudit = require('../services/platformAudit.service');
const bcrypt = require('bcryptjs');
const db = require('../../models');
const { Usuario } = db;
const { isBlockedAuthEmail } = require('../lib/blocked-auth-emails');
const passwordResetService = require('../services/passwordReset.service');
const systemNotificationsService = require('../services/systemNotifications.service');
const emailChallenges = require('../services/authEmailChallenge.service');
const trustedDevices = require('../services/authTrustedDevice.service');

exports.forgotPassword = async (req, res) => {
    try {
        const email = String(req.body?.email || '').trim().toLowerCase();
        if (!email) {
            return res.status(400).json({ message: 'Email is required.' });
        }
        if (!isBlockedAuthEmail(email)) {
            await passwordResetService.requestPasswordReset({
                email,
                requestIp: req.ip,
                userAgent: req.get('user-agent') || null,
            }).catch((error) => {
                console.error('[Auth] No se pudo encolar password reset:', error?.code || error?.message || error);
            });
        }
        return res.status(202).json({
            message: 'If the account exists, a recovery email will be sent.',
        });
    } catch (error) {
        console.error('[Auth] Error en forgotPassword:', error?.code || error?.message || error);
        return res.status(202).json({
            message: 'If the account exists, a recovery email will be sent.',
        });
    }
};

exports.resetPassword = async (req, res) => {
    try {
        const { token, password } = req.body || {};
        await passwordResetService.consumePasswordResetToken({ token, password });
        return res.status(200).json({
            message: 'Password reset successful.'
        });
    } catch (error) {
        const status = Number(error?.status || 500);
        if (status >= 500) {
            console.error('[Auth] Error in resetPassword:', error?.code || error?.message || error);
        }
        return res.status(status).json({ message: status >= 500 ? 'Server error' : error.message });
    }
};


// Audit success means credentials verified/token prepared; it does not claim the client received it.
async function auditedAuth(req, res, action, work) {
    let attempt;
    try { attempt = await platformAudit.begin(req, action); }
    catch { return res.status(503).json({ message: 'Authentication temporarily unavailable.' }); }
    let result;
    try { result = await work(attempt); }
    catch (error) {
        const expired = error?.name === 'TokenExpiredError';
        const invalidToken = expired || ['JsonWebTokenError', 'NotBeforeError'].includes(error?.name);
        result = invalidToken
            ? { status: 401, body: { error: 'Invalid token' }, audit: { outcome: 'denied', reason: action === 'auth.token_sign_in' ? (expired ? 'token_expired' : 'token_rejected') : 'credentials_rejected' } }
            : { status: 500, body: { message: 'Server error' }, audit: { outcome: 'error', reason: 'internal_error' } };
        if (!invalidToken) console.error('[Auth] Authentication operation failed.');
    }
    try { if (!result.auditCompleted) await attempt.complete(result.audit); }
    catch { return res.status(503).json({ message: 'Authentication temporarily unavailable.' }); }
    return res.status(result.status).json(result.body);
}
function rejectedCredentials(invalidRequest = false) {
    return { status: invalidRequest ? 400 : 401,
        body: { message: invalidRequest ? 'Email and password are required.' : 'Wrong email or password.' },
        audit: { outcome: 'denied', reason: invalidRequest ? 'request_invalid' : 'credentials_rejected' } };
}
const legacySignIn = (req, res) => auditedAuth(req, res, 'auth.sign_in', async (attempt) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (isBlockedAuthEmail(email)) return rejectedCredentials();
    const user = await Usuario.findOne({ where: { email_usuario: email } });
    if (!user?.password_usuario || !await bcrypt.compare(req.body.password, user.password_usuario)) return rejectedCredentials();
    return sessions.authenticated(user, { attempt });
});
exports.signInWithToken = (req, res) => auditedAuth(req, res, 'auth.token_sign_in', async (attempt) => {
    const accessToken = req.body?.accessToken;
    if (!accessToken) return { status: 400, body: { error: 'Access token is required' }, audit: { outcome: 'denied', reason: 'request_invalid' } };
    const decodedToken = await sessions.verify(accessToken);
    if (isBlockedAuthEmail(decodedToken.email)) return { status: 401, body: { error: 'Invalid token' }, audit: { outcome: 'denied', reason: 'token_rejected' } };
    const user = await Usuario.findOne({ where: { id_usuario: decodedToken.userId } });
    if (!user) return { status: 401, body: { error: 'User not found.' }, audit: { outcome: 'denied', reason: 'token_rejected' } };
    return sessions.authenticated(user, { parentToken: accessToken, attempt });
});

exports.signUp = async (req, res) => {
    try {
        const { rol, nombre, apellidos, email_usuario, email_factura, email_notificacion, password, fecha_creacion } = req.body;
        const hashedPassword = await bcrypt.hash(password, 8);
        const cfg = sessions.settings();
        const createAccount = async (transaction) => {
            const newUser = await Usuario.create({
                rol: rol,
                nombre: nombre,
                apellidos: apellidos,
                email_usuario: email_usuario,
                email_factura: email_factura,
                email_notificacion: email_notificacion,
                password_usuario: hashedPassword,
                fecha_creacion: fecha_creacion || new Date(),
            }, { transaction });
            const issued = cfg.emailMfaMode === 'enforce' ? null : await sessions.issue(newUser, { transaction, reason: 'account_created' });
            return { newUser, issued };
        };
        const { newUser, issued } = cfg.mode === 'enforce' ? await db.sequelize.transaction(createAccount) : await createAccount();

        systemNotificationsService.notifyUserRegistration({
            user: newUser,
            origin: 'auth.sign_up',
        }).catch((error) => {
            console.warn('[Auth] No se pudo encolar notificación de nuevo registro:', error?.code || error?.message || error);
        });
        
        res.status(201).json({
            message: 'Usuario creado exitosamente',
            user: {
                id_usuario: newUser.id_usuario,
                rol: newUser.rol,
                nombre: newUser.nombre,
                apellidos: newUser.apellidos,
                email: newUser.email_usuario,
                email_factura: newUser.email_factura,
                email_notificacion: newUser.email_notificacion,
                fecha_creacion: newUser.fecha_creacion,
            },
            ...(issued ? { token: issued.token, expiresIn: issued.expiresIn } : { signInRequired: true }),
        });
    } catch (error) {
        console.error('[Auth] Account creation failed.');
        res.status(500).json({ message: 'Error al crear el usuario' });
    }
};

const legacyUnlockSession = (req, res) => auditedAuth(req, res, 'auth.unlock', async (attempt) => {
    const { email, password } = req.body || {};
    if (!email || !password) return rejectedCredentials(true);
    const normalizedEmail = String(email).trim().toLowerCase();
    if (isBlockedAuthEmail(normalizedEmail)) return rejectedCredentials();
    const user = await Usuario.findOne({ where: { email_usuario: normalizedEmail } });
    if (!user?.password_usuario || !await bcrypt.compare(password, user.password_usuario)) return rejectedCredentials();
    return sessions.authenticated(user, { attempt });
});

function emailError(res, error) {
    const statuses = { auth_email_invalid: 401, auth_email_expired: 401, auth_email_locked: 429,
        auth_email_rate_limited: 429, auth_email_unavailable: 503, auth_email_configuration_invalid: 503 };
    const code = Object.hasOwn(statuses, error?.code) ? error.code : 'auth_email_unavailable';
    return res.status(statuses[code]).json({ error: code,
        message: statuses[code] === 503 ? 'Authentication temporarily unavailable.' : 'Email verification could not be completed.' });
}
async function passwordWithEmail(req, res, legacy) {
    try {
        if (emailChallenges.mode() !== 'enforce') return legacy(req, res);
        res.set('Cache-Control', 'private, no-store');
        const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
        const password = req.body?.password;
        const valid = email.length > 0 && email.length <= 254 && typeof password === 'string'
            && password.length > 0 && password.length <= 1024 && !isBlockedAuthEmail(email);
        const user = valid ? await Usuario.findOne({ where: { email_usuario: email } }) : null;
        if (!sessions.activeUser(user) || !await bcrypt.compare(password, user.password_usuario)) {
            await emailChallenges.rejectedCredentials();
            return res.status(401).json({ message: 'Wrong email or password.' });
        }
        const trusted = trustedDevices.cookie(req);
        if (trusted) {
            try { return res.status(200).json((await sessions.authenticated(user, { trustedDeviceToken: trusted })).body); }
            catch (error) {
                if (error?.code !== 'auth_trusted_device_invalid') throw error;
                trustedDevices.clearCookie(res);
            }
        }
        return res.status(202).json(await emailChallenges.begin(user));
    } catch (error) { return emailError(res, error); }
}
exports.signIn = (req, res) => passwordWithEmail(req, res, legacySignIn);
exports.unlockSession = (req, res) => passwordWithEmail(req, res, legacyUnlockSession);
async function emailCommand(req, res, resend) {
    res.set('Cache-Control', 'private, no-store');
    try {
        const body = req.body;
        const keys = resend ? ['challengeToken'] : ['challengeToken', 'code', ...(Object.hasOwn(body || {}, 'trustDevice') ? ['trustDevice'] : [])];
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== keys.sort().join(',')
            || (!resend && Object.hasOwn(body, 'trustDevice') && typeof body.trustDevice !== 'boolean')) {
            return res.status(400).json({ error: 'auth_email_request_invalid' });
        }
        if (!resend && body.trustDevice === true) {
            if (!trustedDevices.browserRequest(req)) return res.status(400).json({ error: 'auth_email_request_invalid' });
            const result = await emailChallenges.verifyAndTrust(body.challengeToken, body.code);
            trustedDevices.setCookie(res, result.device);
            return res.status(200).json(result.body);
        }
        const result = resend ? await emailChallenges.resend(body.challengeToken) : await emailChallenges.verify(body.challengeToken, body.code);
        return res.status(resend ? 202 : 200).json(result);
    } catch (error) { return emailError(res, error); }
}
exports.verifyEmailCode = (req, res) => emailCommand(req, res, false);
exports.resendEmailCode = (req, res) => emailCommand(req, res, true);

// A remembered browser is enough for ordinary login. Sensitive actions can
// explicitly recheck the password and email without logging the user out or
// changing the browser's trusted-device cookie. Reuse the normal one-use proof.
exports.beginEmailStepUp = async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try {
        if (emailChallenges.mode() !== 'enforce') return res.status(503).json({ error: 'auth_email_unavailable' });
        const body = req.body;
        if (!body || typeof body !== 'object' || Array.isArray(body)
            || Object.keys(body).join(',') !== 'password' || typeof body.password !== 'string'
            || !body.password.length || body.password.length > 1024) {
            return res.status(400).json({ error: 'auth_email_request_invalid' });
        }
        const user = await Usuario.findByPk(req.userData?.userId);
        if (!sessions.activeUser(user) || isBlockedAuthEmail(user.email_usuario)
            || !await bcrypt.compare(body.password, user.password_usuario)) {
            await emailChallenges.rejectedCredentials();
            return res.status(400).json({ error: 'auth_password_rejected' });
        }
        return res.status(202).json(await emailChallenges.begin(user));
    } catch (error) { return emailError(res, error); }
};

exports.me = async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try {
        const user = await Usuario.findByPk(req.userData.userId, { attributes: ['id_usuario', 'nombre', 'apellidos', 'email_usuario', 'isProfesional', 'avatar'] });
        if (!user) return res.status(401).json({ message: 'Auth failed!' });
        return res.json({ user: sessions.projectUser(user), session: { managed: Boolean(req.authSession?.id), expiresAt: req.authSession?.expiresAt } });
    } catch { return res.status(503).json({ message: 'Authentication temporarily unavailable.' }); }
};
async function revoke(req, res, all) {
    res.set('Cache-Control', 'private, no-store');
    try {
        const result = await sessions.revoke(sessions.bearer(req.headers.authorization), all);
        if (all && result.revoked) trustedDevices.clearCookie(res);
        return res.json(result);
    }
    catch (error) {
        const invalid = ['JsonWebTokenError', 'TokenExpiredError', 'NotBeforeError'].includes(error.name);
        return res.status(invalid ? 401 : 503).json({ message: invalid ? 'Auth failed!' : 'Authentication temporarily unavailable.' });
    }
}
exports.signOut = (req, res) => revoke(req, res, false);
exports.revokeSessions = (req, res) => revoke(req, res, true);
