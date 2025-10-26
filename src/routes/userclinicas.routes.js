// src/routes/userclinicas.routes.js
const express = require('express');
const jwt = require('jsonwebtoken');
const { Clinica, UsuarioClinica, Usuario, GrupoClinica } = require('../../models');

const router = express.Router();

/**
 * Array de IDs de usuarios administradores
 * Estos usuarios tienen acceso a TODAS las clínicas del sistema
 */
// ✅ CAMBIO 1: Se define la lista de IDs de administradores
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
                const decoded = jwt.verify(token, process.env.JWT_SECRET);
                console.log('🔍 Token JWT decodificado para clínicas:', decoded);
                return decoded.userId; // El campo correcto según auth.controllers.js
            }
        }
    } catch (error) {
        console.error('❌ Error decodificando JWT:', error);
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

        // ✅ CAMBIO 2: Obtener el usuario para poder añadirle la propiedad isAdmin
        const usuario = await Usuario.findByPk(userId);
        if (!usuario) {
            console.log('❌ Usuario no encontrado con ID:', userId);
            return res.status(404).json({
                success: false,
                message: 'Usuario no encontrado'
            });
        }

        // ✅ CAMBIO 3: Añade la bandera 'isAdmin' si el ID del usuario está en la lista
        usuario.isAdmin = ADMIN_USER_IDS.includes(usuario.id_usuario);

        // Verificar si el usuario es administrador
        if (isAdmin(userId)) {
            console.log('👑 Usuario ADMINISTRADOR detectado (ID:', userId, ')');
            console.log('🏥 Obteniendo TODAS las clínicas del sistema...');

            // Para administradores: obtener TODAS las clínicas
            const adminAssignments = await UsuarioClinica.findAll({
                where: { id_usuario: userId },
                attributes: ['id_clinica', 'rol_clinica', 'subrol_clinica']
            });

            const assignmentByClinic = new Map();
            adminAssignments.forEach(assignment => {
                assignmentByClinic.set(Number(assignment.id_clinica), {
                    role: assignment.rol_clinica,
                    subrole: assignment.subrol_clinica
                });
            });

            const normalizeRole = (role) => {
                if (!role) {
                    return 'administrador';
                }
                if (role === 'personaldeclinica') {
                    return 'medico';
                }
                if (role === 'admin') {
                    return 'administrador';
                }
                return role;
            };

            const todasLasClinicas = await Clinica.findAll({
                // ✅ CORRECCIÓN: Incluir relación con GrupoClinica
                include: [{
                    model: GrupoClinica,
                    as: 'grupoClinica',
                    required: false,
                    attributes: ['id_grupo', 'nombre_grupo']
                }],
                order: [['nombre_clinica', 'ASC']]
            });

            console.log('🏥 Clínicas del sistema encontradas:', todasLasClinicas.length);

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
                // ✅ CORRECCIÓN: Agregar información de grupo
                groupId: clinica.grupoClinicaId || null,
                groupName: clinica.grupoClinica?.nombre_grupo || null,
                grupoClinica: clinica.grupoClinica ? {
                    id_grupo: clinica.grupoClinica.id_grupo,
                    nombre_grupo: clinica.grupoClinica.nombre_grupo
                } : null,
                userRole: normalizeRole(assignmentByClinic.get(clinica.id_clinica)?.role),
                userSubRole: assignmentByClinic.get(clinica.id_clinica)?.subrole || 'sistema',
                // Permisos completos para administradores
                permissions: {
                    canMapAssets: true,
                    canManageSettings: true,
                    canViewReports: true,
                    isSystemAdmin: true
                }
            }));

            console.log('🏥 Clínicas formateadas para admin:', clinicas.map(c => ({
                id: c.id,
                name: c.name,
                role: c.userRole,
                groupId: c.groupId,
                groupName: c.groupName
            })));

            // ✅ AGREGAR ROLES PARA ADMIN
            const rolesAdminSet = new Set(['administrador']);
            adminAssignments.forEach(assignment => {
                rolesAdminSet.add(normalizeRole(assignment.rol_clinica));
            });
            const rolesAdmin = Array.from(rolesAdminSet);

            return res.json({
                success: true,
                clinicas: clinicas,
                roles: rolesAdmin, // ✅ CAMPO CRÍTICO para el menú superior
                total: clinicas.length,
                userType: 'administrador',
                message: `${clinicas.length} clínicas del sistema (acceso completo)`,
                // ✅ CAMBIO 4: Incluir el usuario con la bandera isAdmin
                user: usuario,
                userRole: 'administrador' // ✅ CAMBIO 5: Establecer el rol principal como administrador
            });

        } else {
            console.log('👤 Usuario NORMAL detectado (ID:', userId, ')');
            console.log('🏥 Obteniendo clínicas asignadas al usuario...');

            // Para usuarios normales: obtener solo clínicas asignadas
            const usuario = await Usuario.findByPk(userId, {
                include: [{
                    model: Clinica,
                    as: 'clinicas',
                    // ✅ CORRECCIÓN: Incluir relación con GrupoClinica en clínicas asignadas
                    include: [{
                        model: GrupoClinica,
                        as: 'grupoClinica',
                        required: false,
                        attributes: ['id_grupo', 'nombre_grupo']
                    }],
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

            console.log('🏥 Clínicas asignadas encontradas:', usuario.clinicas?.length || 0);

            // ✅ EXTRAER ROLES ÚNICOS del usuario
            const rolesUnicos = [...new Set(usuario.clinicas.map(clinica =>
                clinica.UsuarioClinica.rol_clinica
            ))];
            console.log('👤 Roles únicos extraídos:', rolesUnicos);

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
                // ✅ CORRECCIÓN: Agregar información de grupo para usuarios normales
                groupId: clinica.grupoClinicaId || null,
                groupName: clinica.grupoClinica?.nombre_grupo || null,
                grupoClinica: clinica.grupoClinica ? {
                    id_grupo: clinica.grupoClinica.id_grupo,
                    nombre_grupo: clinica.grupoClinica.nombre_grupo
                } : null,
                userRole: clinica.UsuarioClinica.rol_clinica,
                userSubRole: clinica.UsuarioClinica.subrol_clinica,
                // Permisos basados en el rol asignado
                permissions: {
                    canMapAssets: ['propietario', 'personaldeclinica'].includes(clinica.UsuarioClinica.rol_clinica),
                    canManageSettings: clinica.UsuarioClinica.rol_clinica === 'propietario',
                    canViewReports: ['propietario', 'personaldeclinica'].includes(clinica.UsuarioClinica.rol_clinica),
                    isSystemAdmin: false
                }
            }));

            console.log('🏥 Clínicas formateadas para usuario:', clinicas.map(c => ({
                id: c.id,
                name: c.name,
                role: c.userRole,
                groupId: c.groupId,
                groupName: c.groupName
            })));

            return res.json({
                success: true,
                clinicas: clinicas,
                roles: rolesUnicos, // ✅ CAMPO CRÍTICO para el menú superior
                total: clinicas.length,
                userType: 'normal',
                message: `${clinicas.length} clínicas asignadas`,
                // ✅ CAMBIO 6: Incluir el usuario (sin isAdmin para usuarios normales)
                user: usuario,
                userRole: rolesUnicos.length > 0 ? rolesUnicos[0] : 'paciente' // ✅ CAMBIO 7: Primer rol disponible
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

        // ✅ EXTRAER ROLES ÚNICOS del usuario
        const rolesUnicos = [...new Set(usuario.clinicas.map(clinica =>
            clinica.UsuarioClinica.rol_clinica
        ))];

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
            },
            roles: rolesUnicos // ✅ AGREGAR ESTA LÍNEA
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
