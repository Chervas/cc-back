require('dotenv').config();
const sessions = require('../services/accessSession.service');
const platformAudit = require('../services/platformAudit.service');
const bcrypt = require('bcryptjs');
const db = require('../../models');
const { Usuario } = db;
const { isBlockedAuthEmail } = require('../lib/blocked-auth-emails');
const passwordResetService = require('../services/passwordReset.service');
const systemNotificationsService = require('../services/systemNotifications.service');

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
exports.signIn = (req, res) => auditedAuth(req, res, 'auth.sign_in', async (attempt) => {
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
            const issued = await sessions.issue(newUser, { transaction, reason: 'account_created' });
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
            token: issued.token,
            expiresIn: issued.expiresIn,
        });
    } catch (error) {
        console.error('[Auth] Account creation failed.');
        res.status(500).json({ message: 'Error al crear el usuario' });
    }
};

exports.unlockSession = (req, res) => auditedAuth(req, res, 'auth.unlock', async (attempt) => {
    const { email, password } = req.body || {};
    if (!email || !password) return rejectedCredentials(true);
    const normalizedEmail = String(email).trim().toLowerCase();
    if (isBlockedAuthEmail(normalizedEmail)) return rejectedCredentials();
    const user = await Usuario.findOne({ where: { email_usuario: normalizedEmail } });
    if (!user?.password_usuario || !await bcrypt.compare(password, user.password_usuario)) return rejectedCredentials();
    return sessions.authenticated(user, { attempt });
});

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
    try { return res.json(await sessions.revoke(sessions.bearer(req.headers.authorization), all)); }
    catch (error) {
        const invalid = ['JsonWebTokenError', 'TokenExpiredError', 'NotBeforeError'].includes(error.name);
        return res.status(invalid ? 401 : 503).json({ message: invalid ? 'Auth failed!' : 'Authentication temporarily unavailable.' });
    }
}
exports.signOut = (req, res) => revoke(req, res, false);
exports.revokeSessions = (req, res) => revoke(req, res, true);
