require('dotenv').config();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const secret = process.env.JWT_SECRET; 
const { Usuario } = require('../../models'); 
const { isBlockedAuthEmail } = require('../lib/blocked-auth-emails');
const { isGlobalAdmin } = require('../lib/role-helpers');
const passwordResetService = require('../services/passwordReset.service');
const systemNotificationsService = require('../services/systemNotifications.service');
const ACCESS_TOKEN_TTL_SECONDS = Math.max(300, Number(process.env.AUTH_ACCESS_TOKEN_TTL_SECONDS || (12 * 60 * 60)));
const ACCESS_TOKEN_TTL = `${ACCESS_TOKEN_TTL_SECONDS}s`;

function buildAccessToken(user) {
    const userId = Number(user.id_usuario);
    return jwt.sign(
        { userId, email: user.email_usuario, isAdmin: isGlobalAdmin(userId) },
        secret,
        { expiresIn: ACCESS_TOKEN_TTL }
    );
}

function buildAuthResponse(user) {
    const plainUser = user?.get ? user.get({ plain: true }) : { ...user };
    plainUser.isAdmin = isGlobalAdmin(plainUser.id_usuario);
    return {
        token: buildAccessToken(plainUser),
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


exports.signIn = async (req, res) => {
    try {
        const email = String(req.body?.email || '').trim().toLowerCase();

        if (isBlockedAuthEmail(email)) {
            console.warn('[Auth] Blocked login attempt for disabled demo email:', email);
            return res.status(401).json({ message: 'Wrong email or password.' });
        }

        const user = await Usuario.findOne({ where: { email_usuario: email } });

        if (!user) {
            return res.status(401).json({ message: 'Wrong email or password.' });
        }

        if (!user.password_usuario) {
            return res.status(401).json({ message: 'Wrong email or password.' });
        }
        const validPassword = await bcrypt.compare(req.body.password, user.password_usuario);
        if (!validPassword) {
            return res.status(401).json({ message: 'Wrong email or password.' });
        }

        // Actualizar último acceso
        user.ultimo_login = new Date();
        await user.save({ fields: ['ultimo_login'] });

        res.status(200).json(buildAuthResponse(user));
    } catch (error) {
        console.error('Error en el proceso de signIn:', error);
        res.status(500).json({ message: 'Server error' });
    }
};

exports.signInWithToken = async (req, res) => {
    try {
        const accessToken = req.body.accessToken;
        if(!accessToken) return res.status(400).json({ error: 'Access token is required' });

        const decodedToken = jwt.verify(accessToken, secret);
        if (isBlockedAuthEmail(decodedToken.email)) {
            return res.status(401).json({ error: 'Invalid token' });
        }

        const user = await Usuario.findOne({ where: { id_usuario: decodedToken.userId } });

        if (!user) {
            return res.status(401).json({ error: 'User not found.' });
        }
    
        user.ultimo_login = new Date();
        await user.save({ fields: ['ultimo_login'] });

        res.status(200).json(buildAuthResponse(user));
    } catch (err) {
        if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Invalid token' });
        }
        return res.status(500).json({ error: 'Server error', details: err.message });
    }
};

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

exports.unlockSession = async (req, res) => {
    try {
        const { email, password } = req.body || {};
        if (!email || !password) {
            return res.status(400).json({ message: 'Email and password are required.' });
        }
        const normalizedEmail = String(email).trim().toLowerCase();
        if (isBlockedAuthEmail(normalizedEmail)) {
            return res.status(401).json({ message: 'Wrong email or password.' });
        }

        const user = await Usuario.findOne({ where: { email_usuario: normalizedEmail } });
        if (!user || !user.password_usuario) {
            return res.status(401).json({ message: 'Wrong email or password.' });
        }

        const validPassword = await bcrypt.compare(password, user.password_usuario);
        if (!validPassword) {
            return res.status(401).json({ message: 'Wrong email or password.' });
        }

        user.ultimo_login = new Date();
        await user.save({ fields: ['ultimo_login'] });

        return res.status(200).json(buildAuthResponse(user));
    } catch (error) {
        console.error('Error en unlockSession:', error);
        return res.status(500).json({ message: 'Server error', error: error.message });
    }
};
