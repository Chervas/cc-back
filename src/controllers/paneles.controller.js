const express = require('express');
const router = express.Router();

// GET /api/paneles/dashboard/:idClinica
router.get('/dashboard/:idClinica', async (req, res) => {
    try {
        const { idClinica } = req.params;
        const { periodo = 'ultimo_mes' } = req.query;
        
        // Aquí implementar lógica para obtener datos del dashboard
        const dashboardData = {
            resumen: {
                pacientes_totales: 1314,
                ingresos_mes: 45680,
                citas_programadas: 127,
                satisfaccion_promedio: 4.8
            },
            redes_sociales: {
                facebook: {
                    seguidores: 2840,
                    crecimiento_semanal: 5.2,
                    engagement: 3.8
                },
                instagram: {
                    seguidores: 4200,
                    engagement_rate: 4.2,
                    crecimiento_semanal: 0.4
                },
                tiktok: {
                    seguidores: 1800,
                    visualizaciones: 45000,
                    crecimiento_semanal: 18.5
                },
                linkedin: {
                    seguidores: 950,
                    impresiones: 8500,
                    crecimiento_semanal: 3.7
                },
                doctoralia: {
                    valoracion: 4.8,
                    total_resenas: 124,
                    nuevas_resenas_mes: 8
                }
            }
        };
        
        res.json(dashboardData);
    } catch (error) {
        console.error('Error al obtener datos del dashboard:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// GET /api/paneles/usuario-info
router.get('/usuario-info', async (req, res) => {
    try {
        // Obtener información del usuario desde el token/sesión
        const usuarioInfo = {
            id_usuario: 1,
            nombre: 'Dr. Carlos Arriaga',
            email: 'carlos@clinicaarriaga.com',
            clinica_actual: {
                id_clinica: 1,
                nombre: 'Clínica Arriaga',
                direccion: 'Calle Principal 123, Madrid'
            }
        };
        
        res.json(usuarioInfo);
    } catch (error) {
        console.error('Error al obtener info del usuario:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// GET /api/paneles/notificaciones-tareas
router.get('/notificaciones-tareas', async (req, res) => {
    try {
        const notificacionesTareas = {
            notificaciones: 2,
            tareas: 15,
            notificaciones_detalle: [
                {
                    id: 1,
                    tipo: 'cita',
                    mensaje: 'Nueva cita programada para mañana',
                    fecha: new Date()
                }
            ],
            tareas_detalle: [
                {
                    id: 1,
                    titulo: 'Revisar historiales pendientes',
                    prioridad: 'alta',
                    fecha_limite: new Date()
                }
            ]
        };
        
        res.json(notificacionesTareas);
    } catch (error) {
        console.error('Error al obtener notificaciones:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

module.exports = router;