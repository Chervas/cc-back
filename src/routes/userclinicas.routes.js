// src/routes/userclinicas.routes.js
const express = require('express');
const jwt = require('jsonwebtoken');
const { Clinica, UsuarioClinica, Usuario } = require('../../models');

const router = express.Router();

/**
 * Array de IDs de usuarios administradores
 * Estos usuarios tienen acceso a TODAS las clínicas del sistema
 */
const ADMIN_USER_IDS = [1]; // Añadir más IDs según sea necesario

/**
 * Función auxiliar para obtener el userId del token JWT
 */
const getUserIdFromToken = (req) => {
    try {
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.substring(7); // Remover 'Bearer ' del inicio
            if (token) {
                // ✅ CLAVE CORRECTA: Usar el mismo secreto que se usa en auth.controllers.js
                const decoded = jwt.verify(token, '6798261677hH-!');
                console.log('🔍 Token JWT decodificado para clinicas:', decoded);
                return decoded.userId; // El campo correcto según auth.controllers.js
            }
        }
    } catch (error) {
        console.error("❌ Error decodificando JWT:", error);
    }
    return null;
};

/**
 * Función para verificar si un usuario es administrador
 */
const isAdmin = (userId) => {
    return ADMIN_USER_IDS.includes(userId);
};

/**
 * GET /api/userclinicas/list
 * Obtiene las clínicas a las que tiene acceso el usuario actual
 * - Si es ADMIN: devuelve TODAS las clínicas del sistema
 * - Si es NORMAL: devuelve solo las clínicas asignadas
 * ✅ INCLUYE CAMPO 'roles' para el selector del menú superior
 */
router.get('/list', async (req, res) => {
    try {
        console.log('🏥 Obteniendo clínicas del usuario...');
        
        // Obtener userId del token JWT
        const userId = getUserIdFromToken(req);
        if (!userId) {
            console.log('❌ No se pudo obtener userId del token JWT');
            return res.status(401).json({
                success: false,
                message: 'Token JWT inválido o no proporcionado'
            });
        }

        console.log('🔍 Verificando permisos para userId:', userId);

        // Verificar si el usuario es administrador
        if (isAdmin(userId)) {
            console.log('🔧 Usuario ADMINISTRADOR detectado (ID:', userId, ')');
            console.log('📋 Obteniendo TODAS las clínicas del sistema...');

            // Para administradores: obtener TODAS las clínicas
            const todasLasClinicas = await Clinica.findAll({
                order: [['nombre_clinica', 'ASC']]
            });

            console.log('📊 Clínicas del sistema encontradas:', todasLasClinicas.length);

            // Formatear respuesta para administradores
            const clinicas = todasLasClinicas.map(clinica => ({
                id: clinica.id_clinica,
                name: clinica.nombre_clinica,
                description: clinica.descripcion || '',
                avatar: clinica.url_avatar || null,
                website: clinica.url_web || null,
                contact: {
                    email: clinica.email || null,
                    phone: clinica.telefono || null,
                    address: clinica.direccion || null,
                    city: clinica.ciudad || null
                },
                userRole: 'administrador', // Rol especial para admin
                userSubRole: 'sistema',
                // Permisos completos para administradores
                permissions: {
                    canMapAssets: true,
                    canManageSettings: true,
                    canViewReports: true,
                    isSystemAdmin: true
                }
            }));

            console.log('📊 Clínicas formateadas para admin:', clinicas.map(c => ({
                id: c.id,
                name: c.name,
                role: c.userRole
            })));

            // ✅ AGREGAR ROLES PARA ADMIN
            const rolesAdmin = ['admin'];

            return res.json({
                success: true,
                clinicas: clinicas,
                roles: rolesAdmin, // ✅ CAMPO CRÍTICO para el menú superior
                total: clinicas.length,
                userType: 'administrador',
                message: `${clinicas.length} clínicas del sistema (acceso completo)`
            });

        } else {
            console.log('👤 Usuario NORMAL detectado (ID:', userId, ')');
            console.log('📋 Obteniendo clínicas asignadas al usuario...');

            // Para usuarios normales: obtener solo clínicas asignadas
            const usuario = await Usuario.findByPk(userId, {
                include: [{
                    model: Clinica,
                    as: 'clinicas',
                    through: {
                        where: {
                            rol_clinica: ['propietario', 'personaldeclinica'] // Solo roles apropiados
                        }
                    }
                }],
                order: [[{ model: Clinica, as: 'clinicas' }, 'nombre_clinica', 'ASC']]
            });

            if (!usuario) {
                console.log('❌ Usuario no encontrado con ID:', userId);
                return res.status(404).json({
                    success: false,
                    message: 'Usuario no encontrado'
                });
            }

            console.log('📊 Clínicas asignadas encontradas:', usuario.clinicas?.length || 0);

            // ✅ EXTRAER ROLES ÚNICOS del usuario
            const rolesUnicos = [...new Set(usuario.clinicas.map(clinica => 
                clinica.UsuarioClinica.rol_clinica
            ))];
            console.log('🎯 Roles únicos extraídos:', rolesUnicos);

            // Formatear respuesta para usuarios normales
            const clinicas = (usuario.clinicas || []).map(clinica => ({
                id: clinica.id_clinica,
                name: clinica.nombre_clinica,
                description: clinica.descripcion || '',
                avatar: clinica.url_avatar || null,
                website: clinica.url_web || null,
                contact: {
                    email: clinica.email || null,
                    phone: clinica.telefono || null,
                    address: clinica.direccion || null,
                    city: clinica.ciudad || null
                },
                userRole: clinica.UsuarioClinica.rol_clinica,
                userSubRole: clinica.UsuarioClinica.subrol_clinica,
                // Permisos basados en el rol
                permissions: {
                    canMapAssets: ['propietario', 'personaldeclinica'].includes(clinica.UsuarioClinica.rol_clinica),
                    canManageSettings: clinica.UsuarioClinica.rol_clinica === 'propietario',
                    canViewReports: ['propietario', 'personaldeclinica'].includes(clinica.UsuarioClinica.rol_clinica),
                    isSystemAdmin: false
                }
            }));

            console.log('📊 Clínicas formateadas para usuario:', clinicas.map(c => ({
                id: c.id,
                name: c.name,
                role: c.userRole
            })));

            return res.json({
                success: true,
                clinicas: clinicas,
                roles: rolesUnicos, // ✅ CAMPO CRÍTICO para el menú superior
                total: clinicas.length,
                userType: 'normal',
                message: `${clinicas.length} clínicas asignadas`
            });
        }

    } catch (error) {
        console.error('❌ Error obteniendo clínicas:', error);
        res.status(500).json({
            success: false,
            message: 'Error interno del servidor',
            error: error.message
        });
    }
});

/**
 * GET /api/userclinicas/:id
 * Obtiene una clínica específica si el usuario tiene acceso
 */
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const userId = getUserIdFromToken(req);
        
        if (!userId) {
            return res.status(401).json({
                success: false,
                message: 'Token JWT inválido'
            });
        }

        console.log('🔍 Obteniendo clínica ID:', id, 'para usuario:', userId);

        let clinica;

        if (isAdmin(userId)) {
            // Administradores pueden ver cualquier clínica
            clinica = await Clinica.findByPk(id);
        } else {
            // Usuarios normales solo pueden ver sus clínicas asignadas
            const usuario = await Usuario.findByPk(userId, {
                include: [{
                    model: Clinica,
                    as: 'clinicas',
                    where: { id_clinica: id },
                    through: {
                        where: {
                            rol_clinica: ['propietario', 'personaldeclinica']
                        }
                    }
                }]
            });
            
            clinica = usuario?.clinicas?.[0];
        }

        if (!clinica) {
            return res.status(404).json({
                success: false,
                message: 'Clínica no encontrada o sin acceso'
            });
        }

        res.json({
            success: true,
            clinica: {
                id: clinica.id_clinica,
                name: clinica.nombre_clinica,
                description: clinica.descripcion,
                avatar: clinica.url_avatar,
                website: clinica.url_web,
                contact: {
                    email: clinica.email,
                    phone: clinica.telefono,
                    address: clinica.direccion,
                    city: clinica.ciudad
                }
            }
        });

    } catch (error) {
        console.error('❌ Error obteniendo clínica:', error);
        res.status(500).json({
            success: false,
            message: 'Error interno del servidor',
            error: error.message
        });
    }
});

module.exports = router;

