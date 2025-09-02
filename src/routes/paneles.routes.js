// src/routes/paneles.routes.js
const express = require('express');
const router = express.Router();
const { Op } = require('sequelize');
const { SocialStatsDaily, ClinicMetaAsset } = require('../../models');

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
        const { idClinica, periodo = 'ultimo_mes', assetType } = req.query;
        
        console.log(`Obteniendo métricas de ${tipo} para clínica ${idClinica}, período: ${periodo}`);
        
        let metricas = {};
        
        switch (tipo) {
            case 'redes-sociales':
                if (!idClinica) {
                    return res.status(400).json({ error: 'idClinica es requerido' });
                }

                const ahora = new Date();
                const inicio = new Date();
                switch (periodo) {
                    case 'ultima_semana':
                        inicio.setDate(ahora.getDate() - 7);
                        break;
                    case 'ultimo_anio':
                        inicio.setFullYear(ahora.getFullYear() - 1);
                        break;
                    case 'ultimo_mes':
                    default:
                        inicio.setMonth(ahora.getMonth() - 1);
                        break;
                }

                const where = {
                    clinica_id: idClinica,
                    date: { [Op.between]: [inicio, ahora] }
                };
                if (assetType) {
                    where.asset_type = assetType;
                }

                let registros;
                try {
                    registros = await SocialStatsDaily.findAll({ where, raw: true });
                } catch (err) {
                    console.error('Error al consultar SocialStatsDaily:', err);
                    return res.status(500).json({
                        error: 'No se pudieron obtener métricas',
                        message: err.message
                    });
                }

                if (assetType && registros.length === 0) {
                    return res.status(404).json({ error: 'Plataforma no sincronizada o sin datos' });
                }

                const mapTipos = {
                    facebook_page: 'facebook',
                    instagram_business: 'instagram',
                    ad_account: 'meta_ads'
                };
                const metricasRedes = {};

                registros.forEach(r => {
                    const key = mapTipos[r.asset_type] || r.asset_type;
                    if (!metricasRedes[key]) {
                        metricasRedes[key] = {
                            seguidores: 0,
                            impresiones: 0,
                            alcance: 0,
                            engagement: 0,
                            clics: 0
                        };
                    }
                    metricasRedes[key].seguidores = Math.max(metricasRedes[key].seguidores, r.followers || 0);
                    metricasRedes[key].impresiones += r.impressions || 0;
                    metricasRedes[key].alcance += r.reach || 0;
                    metricasRedes[key].engagement += r.engagement || 0;
                    metricasRedes[key].clics += r.clicks || 0;
                });

                if (!assetType) {
                    ['facebook', 'instagram', 'tiktok', 'linkedin', 'doctoralia'].forEach(p => {
                        if (!metricasRedes[p]) {
                            metricasRedes[p] = { sincronizado: false };
                        }
                    });
                }

                metricas = metricasRedes;
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

// =============================
// SERIES: Seguidores por día (IG/FB)
// GET /api/paneles/series/seguidores?clinicaId=<id|csv|all>&period=<this-year|last-year|all-time>
router.get('/series/seguidores', async (req, res) => {
    try {
        let { clinicaId, period = 'this-year', startDate, endDate } = req.query;

        // Rango de fechas
        let start, end;
        const now = new Date();
        if (startDate && endDate) {
            start = new Date(startDate);
            end = new Date(endDate);
            end.setHours(23,59,59,999);
        } else {
            start = new Date(now);
            end = new Date(now);
            end.setHours(23,59,59,999);
            if (period === 'this-year') {
                start = new Date(now.getFullYear(), 0, 1);
            } else if (period === 'last-year') {
                start = new Date(now.getFullYear() - 1, 0, 1);
                end = new Date(now.getFullYear() - 1, 11, 31, 23, 59, 59, 999);
            } else {
                // all-time: dejar start muy atrás
                start = new Date(2000, 0, 1);
            }
        }

        // Construir filtro por clínicas
        const whereClinica = {};
        if (clinicaId && clinicaId !== 'all') {
            if (String(clinicaId).includes(',')) {
                whereClinica.clinica_id = { [Op.in]: String(clinicaId).split(',').map(x => parseInt(x)).filter(n => !isNaN(n)) };
            } else {
                whereClinica.clinica_id = parseInt(clinicaId);
            }
        }

        // Obtener filas IG/FB en rango
        const rows = await SocialStatsDaily.findAll({
            where: {
                ...whereClinica,
                asset_type: { [Op.in]: ['instagram_business', 'facebook_page'] },
                date: { [Op.between]: [start, end] }
            },
            raw: true
        });

        // Agregar por plataforma + fecha (sum followers)
        const ig = new Map();
        const fb = new Map();
        for (const r of rows) {
            const d = new Date(r.date); d.setHours(0,0,0,0);
            const key = d.toISOString().slice(0,10);
            const val = Number(r.followers || 0);
            if (r.asset_type === 'instagram_business') {
                ig.set(key, (ig.get(key) || 0) + val);
            } else if (r.asset_type === 'facebook_page') {
                fb.set(key, (fb.get(key) || 0) + val);
            }
        }

        // Serializar a arrays ordenados por fecha
        function mapToSeries(m) {
            return Array.from(m.entries())
                .sort((a,b) => a[0] < b[0] ? -1 : 1)
                .map(([date, followers]) => ({ date, followers }));
        }

        return res.json({
            instagram: mapToSeries(ig),
            facebook: mapToSeries(fb)
        });
    } catch (error) {
        console.error('❌ Error en series/seguidores:', error);
        res.status(500).json({ error: 'Error interno', message: error.message });
    }
});

// =============================
// Vinculaciones por clínica(s)
// GET /api/paneles/vinculaciones?clinicaId=<id|csv|all>
router.get('/vinculaciones', async (req, res) => {
    try {
        let { clinicaId } = req.query;
        const where = { isActive: true };
        if (clinicaId && clinicaId !== 'all') {
            if (String(clinicaId).includes(',')) {
                where.clinicaId = { [Op.in]: String(clinicaId).split(',').map(x => parseInt(x)).filter(n => !isNaN(n)) };
            } else {
                where.clinicaId = parseInt(clinicaId);
            }
        }
        const assets = await ClinicMetaAsset.findAll({ where, raw: true });
        const anyIG = assets.some(a => a.assetType === 'instagram_business');
        const anyFB = assets.some(a => a.assetType === 'facebook_page');
        res.json({ instagram: anyIG, facebook: anyFB, google: false, tiktok: false });
    } catch (error) {
        console.error('❌ Error en vinculaciones:', error);
        res.status(500).json({ error: 'Error interno', message: error.message });
    }
});
