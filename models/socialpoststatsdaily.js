// models/socialpoststatdaily.js
module.exports = (sequelize, DataTypes) => {
    const SocialPostStatsDaily = sequelize.define('SocialPostStatsDaily', {
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true
        },
        post_id: {
            type: DataTypes.INTEGER,
            allowNull: false,
            references: {
                model: 'SocialPosts', // Actualizado a PascalCase
                key: 'id'
            }
        },
        date: {
            type: DataTypes.DATEONLY,
            allowNull: false
        },
        impressions: {
            type: DataTypes.INTEGER,
            defaultValue: 0,
            comment: 'Número de veces que se mostró el post'
        },
        reach: {
            type: DataTypes.INTEGER,
            defaultValue: 0,
            comment: 'Número de usuarios únicos que vieron el post'
        },
        engagement: {
            type: DataTypes.INTEGER,
            defaultValue: 0,
            comment: 'Número total de interacciones'
        },
        likes: {
            type: DataTypes.INTEGER,
            defaultValue: 0,
            comment: 'Número de me gusta'
        },
        comments: {
            type: DataTypes.INTEGER,
            defaultValue: 0,
            comment: 'Número de comentarios'
        },
        shares: {
            type: DataTypes.INTEGER,
            defaultValue: 0,
            comment: 'Número de veces compartido'
        },
        saved: {
            type: DataTypes.INTEGER,
            defaultValue: 0,
            comment: 'Número de veces guardado (principalmente Instagram)'
        },
        video_views: {
            type: DataTypes.INTEGER,
            defaultValue: 0,
            comment: 'Número de reproducciones de video (si aplica)'
        },
        avg_watch_time: {
            type: DataTypes.FLOAT,
            defaultValue: 0,
            comment: 'Tiempo promedio de visualización en segundos (si aplica)'
        }
    }, {
        tableName: 'SocialPostStatsDaily', // Actualizado a PascalCase
        timestamps: true,
        underscored: true,
        createdAt: 'created_at',
        updatedAt: 'updated_at',
        indexes: [
            {
                name: 'idx_social_post_stats_post_date',
                fields: ['post_id', 'date']
            },
            {
                name: 'idx_social_post_stats_date',
                fields: ['date']
            },
            {
                name: 'idx_social_post_stats_post_date_unique',
                unique: true,
                fields: ['post_id', 'date']
            }
        ]
    });

    // Asociaciones
    SocialPostStatsDaily.associate = function(models) {
        // SocialPostStatsDaily pertenece a un SocialPosts (CORREGIDO: era SocialPost)
        SocialPostStatsDaily.belongsTo(models.SocialPosts, {
            foreignKey: 'post_id',
            targetKey: 'id',
            as: 'post'
        });
    };

    // Métodos estáticos

    /**
     * Agregar o actualizar estadísticas diarias de una publicación
     * @param {Object} statsData - Datos de estadísticas
     * @returns {Promise<Object>} - Registro creado o actualizado
     */
    SocialPostStatsDaily.upsertStats = async function(statsData) {
        const [stats, created] = await this.findOrCreate({
            where: {
                post_id: statsData.post_id,
                date: statsData.date
            },
            defaults: statsData
        });

        if (!created) {
            await stats.update(statsData);
        }

        return stats;
    };

    /**
     * Obtener estadísticas de una publicación en un rango de fechas
     * @param {number} postId - ID de la publicación
     * @param {Date} startDate - Fecha de inicio
     * @param {Date} endDate - Fecha de fin
     * @returns {Promise<Array>} - Estadísticas diarias
     */
    SocialPostStatsDaily.getStatsByDateRange = async function(postId, startDate, endDate) {
        return await this.findAll({
            where: {
                post_id: postId,
                date: {
                    [sequelize.Op.between]: [startDate, endDate]
                }
            },
            order: [['date', 'ASC']]
        });
    };

    /**
     * Obtener las publicaciones más populares de una clínica
     * @param {number} clinicaId - ID de la clínica
     * @param {string} metric - Métrica para ordenar (engagement, reach, impressions)
     * @param {Date} startDate - Fecha de inicio
     * @param {Date} endDate - Fecha de fin
     * @param {number} limit - Límite de resultados
     * @returns {Promise<Array>} - Publicaciones más populares
     */
    SocialPostStatsDaily.getTopPosts = async function(clinicaId, metric = 'engagement', startDate, endDate, limit = 5) {
        // Validar métrica
        const validMetrics = ['engagement', 'reach', 'impressions', 'likes', 'comments', 'shares'];
        if (!validMetrics.includes(metric)) {
            metric = 'engagement';
        }

        return await this.findAll({
            attributes: [
                'post_id',
                [sequelize.fn('SUM', sequelize.col(metric)), 'total']
            ],
            include: [
                {
                    model: sequelize.models.SocialPosts, // CORREGIDO: era SocialPost
                    as: 'post',
                    where: { clinica_id: clinicaId },
                    attributes: ['id', 'title', 'content', 'media_url', 'permalink_url', 'published_at', 'post_type'],
                    include: [
                        {
                            model: sequelize.models.ClinicMetaAsset,
                            as: 'asset',
                            attributes: ['id', 'assetType', 'metaAssetName']
                        }
                    ]
                }
            ],
            where: {
                date: {
                    [sequelize.Op.between]: [startDate, endDate]
                }
            },
            group: ['post_id'],
            order: [[sequelize.literal('total'), 'DESC']],
            limit
        });
    };

    /**
     * Obtener estadísticas agregadas de publicaciones por día
     * @param {number} clinicaId - ID de la clínica
     * @param {Date} startDate - Fecha de inicio
     * @param {Date} endDate - Fecha de fin
     * @returns {Promise<Array>} - Estadísticas agregadas por día
     */
    SocialPostStatsDaily.getAggregatedStatsByDay = async function(clinicaId, startDate, endDate) {
        return await this.findAll({
            attributes: [
                'date',
                [sequelize.fn('SUM', sequelize.col('impressions')), 'impressions'],
                [sequelize.fn('SUM', sequelize.col('reach')), 'reach'],
                [sequelize.fn('SUM', sequelize.col('engagement')), 'engagement'],
                [sequelize.fn('SUM', sequelize.col('likes')), 'likes'],
                [sequelize.fn('SUM', sequelize.col('comments')), 'comments'],
                [sequelize.fn('SUM', sequelize.col('shares')), 'shares']
            ],
            include: [
                {
                    model: sequelize.models.SocialPosts, // CORREGIDO: era SocialPost
                    as: 'post',
                    attributes: [],
                    where: { clinica_id: clinicaId }
                }
            ],
            where: {
                date: {
                    [sequelize.Op.between]: [startDate, endDate]
                }
            },
            group: ['date'],
            order: [['date', 'ASC']]
        });
    };

    return SocialPostStatsDaily;
};
