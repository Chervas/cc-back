const sessions = require('../services/accessSession.service');

module.exports = async (req, res, next) => {
    try {
        const decodedToken = await sessions.verify(sessions.bearer(req.headers.authorization));
        req.userData = { email: decodedToken.email, userId: decodedToken.userId };
        req.authSession = { id: decodedToken.sessionVersion ? decodedToken.jti : null, expiresAt: decodedToken.exp };
        next();
    } catch (error) {
        const invalid = ['JsonWebTokenError', 'TokenExpiredError', 'NotBeforeError'].includes(error.name);
        res.status(invalid ? 401 : 503).json({ message: invalid ? 'Auth failed!' : 'Authentication temporarily unavailable.' });
    }
};
