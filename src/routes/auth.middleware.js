const sessions = require('../services/accessSession.service');

module.exports = async (req, res, next) => {
    try {
        const token = sessions.bearer(req.headers.authorization);
        const decodedToken = await sessions.verify(token);
        req.userData = { email: decodedToken.email, userId: decodedToken.userId };
        req.authSession = { id: decodedToken.sessionVersion || decodedToken.authDelegation ? decodedToken.jti : null, expiresAt: decodedToken.exp };
        if (decodedToken.authDelegation) {
            req.authSession = Object.freeze({ ...req.authSession, kind: 'delegated' });
            Object.defineProperty(req, 'authDelegation', { value: decodedToken.authDelegation, enumerable: true });
            return await require('../services/platformAudit.delegation').admitHttp(req, res, async () => {
                if (require('../lib/delegatedOperationPolicy').requiresOwnSession(req)) {
                    return res.status(403).json({ error: 'delegated_operation_requires_own_session' });
                }
                // Admission may wait for durable audit storage. Do not dispatch
                // an action whose child/parent authority changed while waiting.
                const latest = await sessions.verify(token);
                if (latest.userId !== decodedToken.userId || latest.jti !== decodedToken.jti
                    || latest.authDelegation?.delegationId !== decodedToken.authDelegation.delegationId) {
                    throw Object.assign(Error('auth_invalid'), { name: 'JsonWebTokenError' });
                }
                return next();
            });
        }
        next();
    } catch (error) {
        const invalid = ['JsonWebTokenError', 'TokenExpiredError', 'NotBeforeError'].includes(error.name);
        res.status(invalid ? 401 : 503).json({ message: invalid ? 'Auth failed!' : 'Authentication temporarily unavailable.' });
    }
};
