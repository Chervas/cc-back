require('dotenv').config();
const jwt = require('jsonwebtoken');
const { randomUUID } = require('node:crypto');
const platformAudit = require('../services/platformAudit.service');
const bcrypt = require('bcryptjs');
const secret = process.env.JWT_SECRET; 
const { Usuario } = require('../../models'); 
const { isBlockedAuthEmail } = require('../lib/blocked-auth-emails');
const { isGlobalAdmin } = require('../lib/role-helpers');
const passwordResetService = require('../services/passwordReset.service');
const systemNotificationsService = require('../services/systemNotifications.service');
const ACCESS_TOKEN_TTL_SECONDS = Math.max(300, Number(process.env.AUTH_ACCESS_TOKEN_TTL_SECONDS || (12 * 60 * 60)));
const ACCESS_TOKEN_TTL = `${ACCESS_TOKEN_TTL_SECONDS}s`;

function buildAccessToken(user, sessionRef = randomUUID()) {
    const userId = Number(user.id_usuario);
    return jwt.sign(
        { userId, email: user.email_usuario, isAdmin: isGlobalAdmin(userId) },
        secret,
        { expiresIn: ACCESS_TOKEN_TTL, jwtid: sessionRef }
    );
}

function buildAuthResponse(user, sessionRef) {
    const plainUser = user?.get ? user.get({ plain: true }) : { ...user };
    delete plainUser.password_usuario;
    plainUser.isAdmin = isGlobalAdmin(plainUser.id_usuario);
    return {
        token: buildAccessToken(plainUser, sessionRef),
        expiresIn: ACCESS_TOKEN_TTL_SECONDS,
        user: plainUser,
    };
}

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
    try { result = await work(); }
    catch (error) {
        const expired = error?.name === 'TokenExpiredError';
        const invalidToken = action === 'auth.token_sign_in' && (expired || ['JsonWebTokenError', 'NotBeforeError'].includes(error?.name));
        result = invalidToken
            ? { status: 401, body: { error: 'Invalid token' }, audit: { outcome: 'denied', reason: expired ? 'token_expired' : 'token_rejected' } }
            : { status: 500, body: { message: 'Server error' }, audit: { outcome: 'error', reason: 'internal_error' } };
        if (!invalidToken) console.error('[Auth] Authentication operation failed.');
    }
    try { await attempt.complete(result.audit); }
    catch { return res.status(503).json({ message: 'Authentication temporarily unavailable.' }); }
    return res.status(result.status).json(result.body);
}
function rejectedCredentials(invalidRequest = false) {
    return { status: invalidRequest ? 400 : 401,
        body: { message: invalidRequest ? 'Email and password are required.' : 'Wrong email or password.' },
        audit: { outcome: 'denied', reason: invalidRequest ? 'request_invalid' : 'credentials_rejected' } };
}
async function acceptedCredentials(user, tokenLogin = false) {
    user.ultimo_login = new Date();
    await user.save({ fields: ['ultimo_login'] });
    const sessionRef = randomUUID();
    return { status: 200, body: buildAuthResponse(user, sessionRef), audit: { outcome: 'success',
        reason: tokenLogin ? 'token_verified' : 'credentials_verified', userId: user.id_usuario, sessionRef } };
}
exports.signIn = (req, res) => auditedAuth(req, res, 'auth.sign_in', async () => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (isBlockedAuthEmail(email)) return rejectedCredentials();
    const user = await Usuario.findOne({ where: { email_usuario: email } });
    if (!user?.password_usuario || !await bcrypt.compare(req.body.password, user.password_usuario)) return rejectedCredentials();
    return acceptedCredentials(user);
});
exports.signInWithToken = (req, res) => auditedAuth(req, res, 'auth.token_sign_in', async () => {
    const accessToken = req.body?.accessToken;
    if (!accessToken) return { status: 400, body: { error: 'Access token is required' }, audit: { outcome: 'denied', reason: 'request_invalid' } };
    const decodedToken = jwt.verify(accessToken, secret);
    if (isBlockedAuthEmail(decodedToken.email)) return { status: 401, body: { error: 'Invalid token' }, audit: { outcome: 'denied', reason: 'token_rejected' } };
    const user = await Usuario.findOne({ where: { id_usuario: decodedToken.userId } });
    if (!user) return { status: 401, body: { error: 'User not found.' }, audit: { outcome: 'denied', reason: 'token_rejected' } };
    return acceptedCredentials(user, true);
});

exports.signUp = async (req, res) => {
    try {
        const { rol, nombre, apellidos, email_usuario, email_factura, email_notificacion, password, fecha_creacion } = req.body;
        const hashedPassword = await bcrypt.hash(password, 8);
        const newUser = await Usuario.create({
            rol: rol,
            nombre: nombre,
            apellidos: apellidos,
            email_usuario: email_usuario,
            email_factura: email_factura,
            email_notificacion: email_notificacion,
            password_usuario: hashedPassword,
            fecha_creacion: fecha_creacion || new Date(),
        });

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
            token: buildAccessToken(newUser),
            expiresIn: ACCESS_TOKEN_TTL_SECONDS,
        });
    } catch (error) {
        console.error('Error en el proceso de signUp:', error);
        res.status(500).json({ message: 'Error al crear el usuario', error: error.message });
    }
};

exports.unlockSession = (req, res) => auditedAuth(req, res, 'auth.unlock', async () => {
    const { email, password } = req.body || {};
    if (!email || !password) return rejectedCredentials(true);
    const normalizedEmail = String(email).trim().toLowerCase();
    if (isBlockedAuthEmail(normalizedEmail)) return rejectedCredentials();
    const user = await Usuario.findOne({ where: { email_usuario: normalizedEmail } });
    if (!user?.password_usuario || !await bcrypt.compare(password, user.password_usuario)) return rejectedCredentials();
    return acceptedCredentials(user);
});
