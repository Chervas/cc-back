const adminCredentials = require('../lib/adminCredentialSession');
const secret = process.env.JWT_SECRET; // ✅ Usar variable de entorno
const { isBlockedAuthEmail } = require('../lib/blocked-auth-emails');

module.exports = async (req, res, next) => {
    try {
        const token = adminCredentials.bearer(req.headers.authorization);
        const decodedToken = await adminCredentials.verifyToken(token, secret);
        if (isBlockedAuthEmail(decodedToken.email)) {
            return res.status(401).json({ message: "Auth failed!" });
        }
        req.userData = { email: decodedToken.email, userId: decodedToken.userId };
        next();
    } catch (error) {
        res.status(401).json({ message: "Auth failed!" });
    }
};
