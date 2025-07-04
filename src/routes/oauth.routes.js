// backendclinicaclick/src/routes/oauth.routes.js
const express = require('express');
const axios = require('axios');
const jwt = require('jsonwebtoken'); // Para decodificar el token JWT
const router = express.Router();
const db = require('../../models'); // <-- Importa el objeto db de models/index.js
const MetaConnection = db.MetaConnection; // <-- Accede al modelo MetaConnection
const ClinicMetaAsset = db.ClinicMetaAsset; // <-- Accede al modelo ClinicMetaAsset

// Configuración de la App de Meta
const META_APP_ID = '1807844546609897'; // <-- App ID correcto
const META_APP_SECRET = 'bfcfedd6447dce4c3eb280067300e141'; // <-- App Secret correcto
const REDIRECT_URI = 'https://autenticacion.clinicaclick.com/oauth/meta/callback';
const FRONTEND_URL = 'https://crm.clinicaclick.com';
const FRONTEND_DEV_URL = 'http://localhost:4200'; // Para desarrollo local

/**
 * GET /oauth/meta/callback
 * Maneja el callback de la autorización de Meta (Facebook).
 */
router.get('/meta/callback', async (req, res) => {
    const { code, state, error, error_reason, error_description } = req.query;

    console.log('➡️  Callback de Meta recibido.');

    if (error) {
        console.error('❌ Error en el callback de Meta:', { error, error_reason, error_description });
        return res.redirect(`${FRONTEND_URL}/pages/settings?error=${encodeURIComponent(error_description || error)}`);
    }

    if (!code) {
        console.error('❌ No se recibió el código de autorización.');
        return res.redirect(`${FRONTEND_URL}/pages/settings?error=${encodeURIComponent('No se recibió el código de autorización.')}`);
    }

    console.log('✅ Código de autorización recibido: ' + code.substring(0, 20) + '...');

    try {
        // 1. Intercambiar el código por un Access Token de CORTA DURACIÓN
        console.log('🔄  Intercambiando código por Access Token de corta duración...');
        const tokenUrl = `https://graph.facebook.com/v23.0/oauth/access_token`;
        const tokenParams = {
            client_id: META_APP_ID,
            client_secret: META_APP_SECRET,
            redirect_uri: REDIRECT_URI,
            code: code,
        };
        const tokenResponse = await axios.get(tokenUrl, { params: tokenParams });
        const shortLivedAccessToken = tokenResponse.data.access_token;
        
        if (!shortLivedAccessToken) {
            console.error('❌ No se pudo obtener el Access Token de corta duración.');
            throw new Error('No se pudo obtener el Access Token de corta duración.');
        }
        console.log('✅ Access Token de corta duración obtenido: ' + shortLivedAccessToken.substring(0, 20) + '...');

        // 2. Intercambiar el Access Token de CORTA DURACIÓN por uno de LARGA DURACIÓN
        console.log('🔄  Intercambiando por Access Token de LARGA DURACIÓN...');
        const longLivedTokenUrl = `https://graph.facebook.com/v23.0/oauth/access_token`;
        const longLivedTokenParams = {
            grant_type: 'fb_exchange_token',
            client_id: META_APP_ID,
            client_secret: META_APP_SECRET,
            fb_exchange_token: shortLivedAccessToken,
        };
        const longLivedTokenResponse = await axios.get(longLivedTokenUrl, { params: longLivedTokenParams });
        const longLivedAccessToken = longLivedTokenResponse.data.access_token;
        const longLivedExpiresIn = longLivedTokenResponse.data.expires_in;

        if (!longLivedAccessToken) {
            console.error('❌ No se pudo obtener el Access Token de larga duración.');
            throw new Error('No se pudo obtener el Access Token de larga duración.');
        }
        console.log('✅ Access Token de LARGA DURACIÓN obtenido: ' + longLivedAccessToken.substring(0, 20) + '...');

        // 3. Obtener información básica del usuario de Meta
        console.log('👤 Obteniendo información del usuario de Meta...');
        const userProfileUrl = `https://graph.facebook.com/me?fields=id,name,email&access_token=${longLivedAccessToken}`;
        const userProfileResponse = await axios.get(userProfileUrl);
        const userData = userProfileResponse.data;
        console.log('👤 Usuario de Meta autenticado:', userData);

        // 4. Almacenar el token de larga duración en la base de datos
        console.log('💾 Almacenando conexión Meta en la base de datos...');
        
        // ENFOQUE CORREGIDO: 
        // - userId = ID del usuario de la aplicación (foreign key a Usuarios.id_usuario)
        // - metaUserId = ID del usuario de Meta (string)
        
        // Por ahora, usar un userId fijo (1) o implementar lógica para obtener el usuario actual
        // TODO: Implementar lógica para obtener el userId del usuario logueado en la aplicación
        const userId = 1; // ID del usuario de la aplicación (temporal)
        const metaUserId = userData.id; // ID del usuario de Meta (string)
        
        console.log('🔍 userId (aplicación):', userId);
        console.log('🔍 metaUserId (Meta):', metaUserId);

        const expiresAt = new Date(Date.now() + longLivedExpiresIn * 1000);

        await MetaConnection.upsert({
            userId: userId, // ID del usuario de la aplicación
            metaUserId: metaUserId, // ID del usuario de Meta
            userName: userData.name,
            userEmail: userData.email,
            accessToken: longLivedAccessToken,
            expiresAt: expiresAt,
        });

        console.log('✅ Conexión Meta almacenada/actualizada en la base de datos.');

        // 5. Redirigir de vuelta al frontend con un indicador de éxito y los datos
        const redirectParams = new URLSearchParams();
        redirectParams.append('connected', 'meta');
        redirectParams.append('userId', userData.id);
        redirectParams.append('userName', userData.name);
        redirectParams.append('userEmail', userData.email);
        redirectParams.append('accessToken', longLivedAccessToken);

        console.log('✅ Redirigiendo al frontend:', `${FRONTEND_URL}/pages/settings?${redirectParams.toString()}`);
        res.redirect(`${FRONTEND_URL}/pages/settings?${redirectParams.toString()}`);

    } catch (err) {
        console.error('❌ Error fatal en el proceso de OAuth:', err.response ? err.response.data : err.message);
        res.redirect(`${FRONTEND_URL}/pages/settings?error=${encodeURIComponent('Error en el proceso de autenticación.')}`);
    }
});

/**
 * GET /oauth/test
 * Endpoint de prueba para verificar que las rutas OAuth están funcionando.
 */
router.get('/test', (req, res) => {
    res.json({
        message: '✅ El servicio OAuth está funcionando correctamente.',
        callback_url: REDIRECT_URI,
        frontend_redirect_url: FRONTEND_URL + '/pages/settings?connected=meta'
    });
});

/**
 * Función auxiliar para obtener el userId del token JWT
 */
const getUserIdFromToken = (req) => {
    try {
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.substring(7); // Remover 'Bearer ' del inicio
            if (token) {
                // Usar el mismo secreto que se usa en auth.controllers.js
                const decoded = jwt.verify(token, '6798261677hH-!');
                console.log('🔍 Token JWT decodificado para connection-status:', decoded);
                return decoded.userId; // El campo correcto según auth.controllers.js
            }
        }
    } catch (error) {
        console.error("❌ Error decodificando JWT:", error);
    }
    return null;
};

/**
 * GET /oauth/meta/connection-status
 * Consulta el estado de conexión de Meta para el usuario logueado
 */
router.get('/meta/connection-status', async (req, res) => {
    try {
        console.log('🔍 Consultando estado de conexión Meta...');
        
        // Obtener el userId del token JWT
        const userId = getUserIdFromToken(req);
        
        if (!userId) {
            console.log('❌ No se pudo obtener userId del token JWT');
            return res.json({
                connected: false,
                error: 'Usuario no autenticado'
            });
        }
        
        console.log('🔍 Buscando conexión Meta para userId:', userId);
        
        // Buscar la conexión Meta en la base de datos
        const metaConnection = await MetaConnection.findOne({
            where: { userId: userId }
        });
        
        if (metaConnection) {
            console.log('✅ Conexión Meta encontrada:', {
                metaUserId: metaConnection.metaUserId,
                userName: metaConnection.userName,
                userEmail: metaConnection.userEmail
            });
            
            // Verificar si el token no ha expirado
            const now = new Date();
            const isExpired = metaConnection.expiresAt && metaConnection.expiresAt < now;
            
            if (isExpired) {
                console.log('⚠️ Token de Meta expirado');
                return res.json({
                    connected: false,
                    error: 'Token expirado'
                });
            }
            
            return res.json({
                connected: true,
                metaUserId: metaConnection.metaUserId,
                userName: metaConnection.userName,
                userEmail: metaConnection.userEmail,
                expiresAt: metaConnection.expiresAt
            });
        } else {
            console.log('❌ No se encontró conexión Meta para este usuario');
            return res.json({
                connected: false
            });
        }
        
    } catch (error) {
        console.error('❌ Error consultando estado de conexión Meta:', error);
        res.status(500).json({
            connected: false,
            error: 'Error interno del servidor'
        });
    }
});

/**
 * DELETE /oauth/meta/disconnect
 * Elimina la conexión de Meta para el usuario logueado
 */
router.delete('/meta/disconnect', async (req, res) => {
    try {
        console.log('🗑️ Desconectando Meta...');
        
        // Obtener el userId del token JWT
        const userId = getUserIdFromToken(req);
        
        if (!userId) {
            console.log('❌ No se pudo obtener userId del token JWT');
            return res.status(401).json({
                success: false,
                error: 'Usuario no autenticado'
            });
        }
        
        console.log('🔍 Eliminando conexión Meta para userId:', userId);
        
        // Eliminar la conexión Meta de la base de datos
        const deletedRows = await MetaConnection.destroy({
            where: { userId: userId }
        });
        
        if (deletedRows > 0) {
            console.log('✅ Conexión Meta eliminada correctamente');
            return res.json({
                success: true,
                message: 'Conexión Meta desconectada correctamente'
            });
        } else {
            console.log('⚠️ No se encontró conexión Meta para eliminar');
            return res.json({
                success: false,
                error: 'No se encontró conexión Meta para este usuario'
            });
        }
        
    } catch (error) {
        console.error('❌ Error eliminando conexión Meta:', error);
        res.status(500).json({
            success: false,
            error: 'Error interno del servidor'
        });
    }
});

module.exports = router;

