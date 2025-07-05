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
        const longLivedExpiresIn = longLivedTokenResponse.data.expires_in; // Generalmente 60 días

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
        
        // ARQUITECTURA CORREGIDA:
        // - userId = ID del usuario en la aplicación (obtenido del state parameter)
        // - metaUserId = ID del usuario en Meta (userData.id)
        
        // Obtener el userId del parámetro state que viene del frontend
        const userId = state; // El frontend debe enviar el userId de la aplicación en el state
        const metaUserId = userData.id; // ID del usuario de Meta
        
        console.log('🔍 userId (aplicación):', userId);
        console.log('🔍 metaUserId (Meta):', metaUserId);
        
        if (!userId) {
            console.error('❌ No se pudo obtener el userId del parámetro state');
            return res.redirect(`${FRONTEND_URL}/pages/settings?error=${encodeURIComponent('No se pudo identificar al usuario logueado. Por favor, inicie sesión en la aplicación antes de conectar Meta.')}`);
        }

        // Calcular fecha de expiración del token de larga duración
        // Los tokens de larga duración de Meta duran 60 días
        let expiresAt;
        if (longLivedExpiresIn && !isNaN(longLivedExpiresIn)) {
            // Si Meta proporciona expires_in, usarlo
            expiresAt = new Date(Date.now() + longLivedExpiresIn * 1000);
            console.log('📅 Usando expires_in de Meta:', longLivedExpiresIn, 'segundos');
        } else {
            // Si no, usar 60 días por defecto (duración estándar de tokens de larga duración)
            const sixtyDaysInMs = 60 * 24 * 60 * 60 * 1000; // 60 días en milisegundos
            expiresAt = new Date(Date.now() + sixtyDaysInMs);
            console.log('📅 Usando duración por defecto: 60 días');
        }
        
        console.log('📅 Token expirará el:', expiresAt.toISOString());

        await MetaConnection.upsert({
            userId: userId, // ID del usuario de la aplicación
            metaUserId: metaUserId, // ID del usuario de Meta
            userName: userData.name,
            userEmail: userData.email,
            accessToken: longLivedAccessToken,
            expiresAt: expiresAt,
        });
        console.log('✅ Conexión Meta almacenada/actualizada en la base de datos.');

        // 5. Redirigir de vuelta al frontend con un indicador de éxito
        console.log(`🚀 Redirigiendo al frontend: ${FRONTEND_URL}/pages/settings?connected=meta&metaUserId=${userData.id}`);
        res.redirect(`${FRONTEND_URL}/pages/settings?connected=meta&metaUserId=${userData.id}`);

    } catch (err) {
        console.error('❌ Error fatal en el proceso de OAuth:', err.response ? err.response.data : err.message);
        res.redirect(`${FRONTEND_URL}/pages/settings?error=${encodeURIComponent('Error en el proceso de autenticación.')}`);
    }
});

/**
 * GET /oauth/meta/connection-status
 * Endpoint para que el frontend consulte el estado de conexión de Meta para el usuario actual.
 */
router.get('/meta/connection-status', async (req, res) => {
    const userId = getUserIdFromToken(req); // Obtén el ID de tu usuario logueado
    if (!userId) {
        return res.status(401).json({ connected: false, message: 'Usuario no autenticado.' });
    }

    try {
        const connection = await MetaConnection.findOne({ where: { userId: userId } });
        if (connection) {
            return res.json({
                connected: true,
                metaUserId: connection.metaUserId,
                userName: connection.userName,
                userEmail: connection.userEmail,
                message: 'Conexión Meta activa.'
            });
        } else {
            return res.json({ connected: false, message: 'No hay conexión Meta para este usuario.' });
        }
    } catch (error) {
        console.error('Error al obtener estado de conexión Meta:', error);
        return res.status(500).json({ connected: false, message: 'Error interno del servidor.' });
    }
});

/**
 * GET /oauth/meta/assets
 * Obtener todos los activos de Meta del usuario con paginación completa
 */
router.get('/meta/assets', async (req, res) => {
    try {
        console.log('📋 Obteniendo activos de Meta con paginación completa...');
        
        // 1. Obtener userId del JWT
        const userId = getUserIdFromToken(req);
        if (!userId) {
            console.log('❌ No se pudo obtener userId del token JWT');
            return res.status(401).json({ 
                success: false, 
                error: 'Usuario no autenticado' 
            });
        }

        console.log('🔍 Token JWT decodificado para assets:', { userId });

        // 2. Buscar conexión Meta del usuario
        const metaConnection = await MetaConnection.findOne({
            where: { userId: userId }
        });

        if (!metaConnection) {
            console.log('❌ No se encontró conexión Meta para este usuario');
            return res.status(404).json({ 
                success: false, 
                error: 'No hay conexión Meta activa para este usuario' 
            });
        }

        console.log('✅ Conexión Meta encontrada:', {
            id: metaConnection.id,
            metaUserId: metaConnection.metaUserId,
            userName: metaConnection.userName
        });

        // 3. Verificar que el token no haya expirado
        if (new Date() > metaConnection.expiresAt) {
            console.log('❌ Token de Meta expirado');
            return res.status(401).json({ 
                success: false, 
                error: 'Token de Meta expirado. Por favor, reconecta tu cuenta.' 
            });
        }

        console.log('✅ Token de usuario válido encontrado');

        // 4. Función para obtener todos los elementos con paginación
        async function getAllPaginatedData(initialUrl, accessToken) {
            let allData = [];
            let nextUrl = initialUrl;
            let pageCount = 0;

            while (nextUrl && pageCount < 50) { // Límite de seguridad: máximo 50 páginas
                pageCount++;
                console.log(`📄 Obteniendo página ${pageCount}...`);
                
                try {
                    const response = await axios.get(nextUrl, {
                        headers: { Authorization: `Bearer ${accessToken}` }
                    });

                    if (response.data && response.data.data) {
                        allData.push(...response.data.data);
                        console.log(`✅ Página ${pageCount}: ${response.data.data.length} elementos obtenidos`);
                    }

                    // Verificar si hay más páginas
                    nextUrl = response.data.paging?.next || null;
                    
                    if (!nextUrl) {
                        console.log(`🏁 Paginación completada en ${pageCount} páginas`);
                    }
                } catch (error) {
                    console.log(`❌ Error en página ${pageCount}:`, error.message);
                    break; // Salir del bucle si hay error
                }
            }

            if (pageCount >= 50) {
                console.log('⚠️ Límite de paginación alcanzado (50 páginas)');
            }

            return allData;
        }

        // 5. Obtener todas las páginas de Facebook con paginación
        console.log('📄 Obteniendo páginas de Facebook...');
        const facebookPagesUrl = `https://graph.facebook.com/v23.0/me/accounts?fields=id,name,picture.width(200).height(200),access_token,category,verification_status,followers_count,instagram_business_account{id,name,username,profile_picture_url,followers_count,media_count,biography}`;
        
        const allFacebookPages = await getAllPaginatedData(facebookPagesUrl, metaConnection.accessToken);
        console.log(`✅ ${allFacebookPages.length} páginas de Facebook encontradas`);

        // 6. Obtener todas las cuentas publicitarias con paginación
        console.log('💰 Obteniendo cuentas publicitarias...');
        const adAccountsUrl = `https://graph.facebook.com/v23.0/me/adaccounts?fields=id,name,account_status,currency,timezone_name,business_name`;
        
        const allAdAccounts = await getAllPaginatedData(adAccountsUrl, metaConnection.accessToken);
        console.log(`✅ ${allAdAccounts.length} cuentas publicitarias encontradas`);

        // 7. Procesar páginas de Facebook
        const facebookPages = allFacebookPages.map(page => ({
            id: page.id,
            name: page.name,
            type: 'facebook_page',
            assetAvatarUrl: page.picture?.data?.url || null,
            page_access_token: page.access_token, // ⭐ TOKEN ESPECÍFICO
            additionalData: {
                category: page.category || null,
                verification_status: page.verification_status || null,
                followers_count: page.followers_count || 0
            }
        }));

        // 8. Procesar Instagram Business Accounts (separados)
        const instagramBusinessAccounts = [];
        allFacebookPages.forEach(page => {
            if (page.instagram_business_account) {
                const igAccount = page.instagram_business_account;
                instagramBusinessAccounts.push({
                    id: igAccount.id,
                    name: igAccount.name || igAccount.username,
                    username: igAccount.username,
                    type: 'instagram_business',
                    assetAvatarUrl: igAccount.profile_picture_url || null,
                    linked_facebook_page: page.id, // Referencia a la página vinculada
                    additionalData: {
                        followers_count: igAccount.followers_count || 0,
                        media_count: igAccount.media_count || 0,
                        biography: igAccount.biography || null,
                        username: igAccount.username
                    }
                });
            }
        });

        // 9. Procesar cuentas publicitarias
        const adAccounts = allAdAccounts.map(account => ({
            id: account.id,
            name: account.name,
            type: 'ad_account',
            assetAvatarUrl: null, // Las cuentas publicitarias no tienen avatar
            additionalData: {
                account_status: account.account_status || null,
                currency: account.currency || null,
                timezone_name: account.timezone_name || null,
                business_name: account.business_name || null
            }
        }));

        // 10. Preparar respuesta final
        const response = {
            success: true,
            user_info: {
                meta_user_id: metaConnection.metaUserId,
                name: metaConnection.userName,
                email: metaConnection.userEmail
            },
            assets: {
                facebook_pages: facebookPages,
                instagram_business_accounts: instagramBusinessAccounts,
                ad_accounts: adAccounts
            },
            total_assets: facebookPages.length + instagramBusinessAccounts.length + adAccounts.length,
            pagination_info: {
                facebook_pages_count: facebookPages.length,
                instagram_accounts_count: instagramBusinessAccounts.length,
                ad_accounts_count: adAccounts.length
            }
        };

        // 11. Log de resumen
        console.log('📊 Resumen de activos obtenidos:');
        console.log(`   - ${facebookPages.length} páginas de Facebook`);
        console.log(`   - ${instagramBusinessAccounts.length} cuentas de Instagram Business`);
        console.log(`   - ${adAccounts.length} cuentas publicitarias`);
        console.log('✅ Activos de Meta obtenidos correctamente');

        res.json(response);

    } catch (error) {
        console.error('❌ Error obteniendo activos de Meta:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Error interno del servidor al obtener activos de Meta',
            details: error.message 
        });
    }
});

/**
 * POST /oauth/meta/map-assets
 * Endpoint para que el frontend guarde los activos de Meta mapeados a una clínica.
 * Requiere que el usuario esté autenticado en tu app y tenga los roles adecuados.
 */
router.post('/meta/map-assets', async (req, res) => {
    const userId = getUserIdFromToken(req);
    if (!userId) {
        return res.status(401).json({ message: 'Usuario no autenticado.' });
    }

    const { clinicaId, selectedAssets } = req.body; // selectedAssets es un array de { id, name, type, pageAccessToken (opcional) }

    // TODO: AÑADIR LÓGICA DE ROLES/PERMISOS AQUÍ
    // Verificar que el userId tiene permisos de administrador/propietario para clinicaId
    // Esto es CRÍTICO para la seguridad y la lógica de negocio.
    // Necesitarás una función que consulte tu base de datos de roles/permisos.
    // Ejemplo:
    // const userHasPermission = await checkUserRoleForClinica(userId, clinicaId, ['admin', 'propietario']);
    // if (!userHasPermission) {
    //     return res.status(403).json({ message: 'Permisos insuficientes para mapear activos a esta clínica.' });
    // }

    try {
        const metaConnection = await MetaConnection.findOne({ where: { userId: userId } });
        if (!metaConnection) {
            return res.status(404).json({ message: 'No hay conexión Meta activa para este usuario.' });
        }

        // Eliminar mapeos existentes para esta clínica y tipos de activos para evitar duplicados
        // Esto es útil si el usuario cambia sus selecciones
        await ClinicMetaAsset.destroy({
            where: {
                clinicaId: clinicaId,
                assetType: ['facebook_page', 'instagram_business_account', 'ad_account']
            }
        });

        const createdAssets = [];
        for (const asset of selectedAssets) {
            const newAsset = await ClinicMetaAsset.create({
                clinicaId: clinicaId,
                metaConnectionId: metaConnection.id,
                assetType: asset.type,
                metaAssetId: asset.id,
                metaAssetName: asset.name,
                pageAccessToken: asset.pageAccessToken || null, // Guardar token de página si existe
            });
            createdAssets.push(newAsset);
        }

        res.status(200).json({ message: 'Activos de Meta mapeados correctamente.', assets: createdAssets });

    } catch (error) {
        console.error('Error al mapear activos de Meta:', error.response ? error.response.data : error.message);
        res.status(500).json({ message: 'Error al mapear activos de Meta.', details: error.response ? error.response.data : error.message });
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

