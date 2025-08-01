// src/routes/paneles.routes.js
const express = require('express');
const router = express.Router();

// GET /api/paneles/dashboard/:idClinica
router.get('/dashboard/:idClinica', async (req, res) => {
    try {
        const { idClinica } = req.params;
        const { periodo = 'ultimo_mes' } = req.query;
        
        console.log(`Obteniendo dashboard para clínica ${idClinica}, período: ${periodo}`);
        
        // Aquí implementar lógica para obtener datos del dashboard
        // Por ahora devolvemos datos de prueba
        const dashboardData = {
            resumen: {
                pacientes_totales: 1314,
                crecimiento_pacientes: 4.6,
                ingresos_mes: 45680,
                citas_programadas: 127,
                satisfaccion_promedio: 4.8,
                evolucion_pacientes: [
                    { fecha: '2024-01', valor: 1200 },
                    { fecha: '2024-02', valor: 1250 },
                    { fecha: '2024-03', valor: 1280 },
                    { fecha: '2024-04', valor: 1300 },
                    { fecha: '2024-05', valor: 1314 }
                ]
            },
            redes_sociales: {
                facebook: {
                    seguidores: 2840,
                    crecimiento_semanal: 5.2,
                    engagement: 3.8,
                    datos_grafico: [
                        { fecha: '2024-05-01', valor: 2700 },
                        { fecha: '2024-05-08', valor: 2750 },
                        { fecha: '2024-05-15', valor: 2800 },
                        { fecha: '2024-05-22', valor: 2820 },
                        { fecha: '2024-05-29', valor: 2840 }
                    ]
                },
                instagram: {
                    seguidores: 4200,
                    engagement_rate: 4.2,
                    crecimiento_semanal: 0.4,
                    datos_grafico: [
                        { fecha: '2024-05-01', valor: 4.0 },
                        { fecha: '2024-05-08', valor: 4.1 },
                        { fecha: '2024-05-15', valor: 4.0 },
                        { fecha: '2024-05-22', valor: 4.3 },
                        { fecha: '2024-05-29', valor: 4.2 }
                    ]
                },
                tiktok: {
                    seguidores: 1800,
                    visualizaciones: 45000,
                    crecimiento_semanal: 18.5,
                    datos_grafico: [
                        { fecha: '2024-05-01', valor: 38000 },
                        { fecha: '2024-05-08', valor: 40000 },
                        { fecha: '2024-05-15', valor: 42000 },
                        { fecha: '2024-05-22', valor: 43500 },
                        { fecha: '2024-05-29', valor: 45000 }
                    ]
                },
                linkedin: {
                    seguidores: 950,
                    impresiones: 8500,
                    crecimiento_semanal: 3.7,
                    datos_grafico: [
                        { fecha: '2024-05-01', valor: 8000 },
                        { fecha: '2024-05-08', valor: 8200 },
                        { fecha: '2024-05-15', valor: 8300 },
                        { fecha: '2024-05-22', valor: 8400 },
                        { fecha: '2024-05-29', valor: 8500 }
                    ]
                },
                doctoralia: {
                    valoracion: 4.8,
                    total_resenas: 124,
                    nuevas_resenas_mes: 8,
                    distribucion_valoraciones: [
                        { estrellas: 5, cantidad: 89 },
                        { estrellas: 4, cantidad: 25 },
                        { estrellas: 3, cantidad: 7 },
                        { estrellas: 2, cantidad: 2 },
                        { estrellas: 1, cantidad: 1 }
                    ]
                },
                comparacion_general: {
                    facebook: 2840,
                    instagram: 4200,
                    tiktok: 1800,
                    linkedin: 950,
                    doctoralia: 124
                }
            },
            web: {
                visitas_mes: 12500,
                conversiones: 85,
                tasa_conversion: 0.68,
                fuentes_trafico: {
                    organico: 45,
                    directo: 25,
                    redes_sociales: 20,
                    publicidad: 10
                }
            },
            publicidad: {
                google_ads: {
                    impresiones: 45000,
                    clics: 1200,
                    ctr: 2.67,
                    costo_total: 850
                },
                meta_ads: {
                    impresiones: 32000,
                    clics: 980,
                    ctr: 3.06,
                    costo_total: 650
                }
            }
        };
        
        res.json(dashboardData);
    } catch (error) {
        console.error('Error al obtener datos del dashboard:', error);
        res.status(500).json({ 
            error: 'Error interno del servidor',
            message: error.message 
        });
    }
});

// GET /api/paneles/usuario-info
router.get('/usuario-info', async (req, res) => {
    try {
        // Obtener información del usuario desde el token/sesión
        // Por ahora devolvemos datos de prueba
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
        res.status(500).json({ 
            error: 'Error interno del servidor',
            message: error.message 
        });
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
                    fecha: new Date(),
                    leida: false
                },
                {
                    id: 2,
                    tipo: 'pago',
                    mensaje: 'Pago pendiente de procesar',
                    fecha: new Date(),
                    leida: false
                }
            ],
            tareas_detalle: [
                {
                    id: 1,
                    titulo: 'Revisar historiales pendientes',
                    descripcion: 'Completar revisión de 5 historiales médicos',
                    prioridad: 'alta',
                    fecha_limite: new Date(Date.now() + 24 * 60 * 60 * 1000), // mañana
                    completada: false
                },
                {
                    id: 2,
                    titulo: 'Actualizar precios de servicios',
                    descripcion: 'Revisar y actualizar lista de precios',
                    prioridad: 'media',
                    fecha_limite: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // próxima semana
                    completada: false
                }
            ]
        };
        
        res.json(notificacionesTareas);
    } catch (error) {
        console.error('Error al obtener notificaciones:', error);
        res.status(500).json({ 
            error: 'Error interno del servidor',
            message: error.message 
        });
    }
});

// GET /api/paneles/metricas/:tipo
router.get('/metricas/:tipo', async (req, res) => {
    try {
        const { tipo } = req.params;
        const { idClinica, periodo = 'ultimo_mes' } = req.query;
        
        console.log(`Obteniendo métricas de ${tipo} para clínica ${idClinica}, período: ${periodo}`);
        
        let metricas = {};
        
        switch (tipo) {
            case 'redes-sociales':
                metricas = {
                    facebook: { seguidores: 2840, engagement: 3.8 },
                    instagram: { seguidores: 4200, engagement: 4.2 },
                    tiktok: { seguidores: 1800, visualizaciones: 45000 },
                    linkedin: { seguidores: 950, impresiones: 8500 },
                    doctoralia: { valoracion: 4.8, resenas: 124 }
                };
                break;
            case 'web':
                metricas = {
                    visitas: 12500,
                    conversiones: 85,
                    tasa_conversion: 0.68
                };
                break;
            case 'publicidad':
                metricas = {
                    google_ads: { impresiones: 45000, clics: 1200, costo: 850 },
                    meta_ads: { impresiones: 32000, clics: 980, costo: 650 }
                };
                break;
            default:
                return res.status(400).json({ error: 'Tipo de métrica no válido' });
        }
        
        res.json(metricas);
    } catch (error) {
        console.error('Error al obtener métricas:', error);
        res.status(500).json({ 
            error: 'Error interno del servidor',
            message: error.message 
        });
    }
});

// POST /api/paneles/refresh
router.post('/refresh', async (req, res) => {
    try {
        const { idClinica } = req.body;
        
        console.log(`Refrescando datos para clínica ${idClinica}`);
        
        // Aquí implementar lógica para refrescar datos desde fuentes externas
        // Por ahora simulamos una actualización exitosa
        
        res.json({ 
            success: true, 
            message: 'Datos actualizados correctamente',
            timestamp: new Date()
        });
    } catch (error) {
        console.error('Error al refrescar datos:', error);
        res.status(500).json({ 
            error: 'Error interno del servidor',
            message: error.message 
        });
    }
});

module.exports = router;

