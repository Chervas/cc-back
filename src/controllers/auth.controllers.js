require('dotenv').config();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const secret = '6798261677hH-!';
const { Usuario } = require('../../models'); 

exports.forgotPassword = (req, res) => {
    // Tu lógica para olvidar contraseña aquí
};

exports.resetPassword = async (req, res) => {
    try {
        console.log('Datos recibidos en resetPassword:', req.body);
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ message: "Email and password are required." });
        }

        // Aseguramos que se obtenga la instancia completa (raw: false)
        const user = await Usuario.findOne({ where: { email_usuario: email }, raw: false });
        if (!user) {
            return res.status(404).json({ message: "User not found." });
        }

        const hashedPassword = await bcrypt.hash(password, 8);
        console.log('Nuevo hash generado:', hashedPassword);

        // Forzamos la actualización del campo password_usuario
        user.setDataValue('password_usuario', hashedPassword);
        await user.save({ fields: ['password_usuario'] });
        console.log('Hash actualizado en DB:', user.password_usuario);

        return res.status(200).json({
            message: "Password reset successful.",
            newPassword: password
        });
    } catch (error) {
        console.error("Error in resetPassword:", error);
        return res.status(500).json({ message: "Server error", error: error.message });
    }
};


exports.signIn = async (req, res) => {
    try {
        console.log('Credenciales recibidas:', req.body);

        const user = await Usuario.findOne({ where: { email_usuario: req.body.email } });
        console.log('Datos del usuario:', user);

        if (!user) {
            console.log('Usuario no encontrado.');
            return res.status(401).json({ message: 'Wrong email or password.' });
        }

        if (!user.password_usuario) {
            console.log('No password set for the user.');
            return res.status(401).json({ message: 'Wrong email or password.' });
        }
        const validPassword = await bcrypt.compare(req.body.password, user.password_usuario);
        console.log('Resultado de bcrypt.compare:', validPassword);
        if (!validPassword) {
            console.log('Contraseña no válida.');
            return res.status(401).json({ message: 'Wrong email or password.' });
        }

        const token = jwt.sign(
            { userId: user.id_usuario, email: user.email_usuario },
            secret, 
            { expiresIn: '1h' }
        );

        res.status(200).json({
            token: token,
            expiresIn: 3600,
            user: user,
        });
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
        const user = await Usuario.findOne({ where: { id_usuario: decodedToken.userId } });

        if (!user) {
            return res.status(401).json({ error: 'User not found.' });
        }
    
        const newToken = jwt.sign(
            { userId: user.id_usuario, email: user.email_usuario },
            secret, 
            { expiresIn: '1h' }
        );

        res.status(200).json({
            token: newToken,
            expiresIn: 3600,
            user: user
        });
    } catch (err) {
        if (err.name === 'JsonWebTokenError') {
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
        
        const token = jwt.sign(
            { userId: newUser.id_usuario, email: newUser.email_usuario },
            secret, 
            { expiresIn: '1h' }
        );

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
            token: token
        });
    } catch (error) {
        console.error('Error en el proceso de signUp:', error);
        res.status(500).json({ message: 'Error al crear el usuario', error: error.message });
    }
};

exports.unlockSession = (req, res) => {
    // Tu lógica para desbloquear sesión aquí
};
