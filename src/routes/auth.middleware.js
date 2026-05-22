const jwt = require('jsonwebtoken');
const secret = process.env.JWT_SECRET; // ✅ Usar variable de entorno
const { isBlockedAuthEmail } = require('../lib/blocked-auth-emails');

module.exports = (req, res, next) => {
    try {
        const token = req.headers.authorization.split(' ')[1]; // Bearer TOKEN
        const decodedToken = jwt.verify(token, secret); // ✅ Usar process.env.JWT_SECRET
        if (isBlockedAuthEmail(decodedToken.email)) {
            return res.status(401).json({ message: "Auth failed!" });
        }
        req.userData = { email: decodedToken.email, userId: decodedToken.userId };
        next();
    } catch (error) {
        res.status(401).json({ message: "Auth failed!" });
    }
};
