const jwt = require('jsonwebtoken');
const secret = '6798261677hH-!';

module.exports = (req, res, next) => {
    try {
        const token = req.headers.authorization.split(' ')[1]; // Bearer TOKEN
        const decodedToken = jwt.verify(token, secret);
        req.userData = { email: decodedToken.email, userId: decodedToken.userId };
        next();
    } catch (error) {
        res.status(401).json({ message: "Auth failed!" });
    }
};