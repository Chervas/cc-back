// models/socialstatdaily.js
module.exports = (sequelize, DataTypes) => {
    const SocialStatsDaily = sequelize.define('SocialStatsDaily', {
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true
        },
        clinica_id: {
            type: DataTypes.INTEGER,
            allowNull: false,
            references: {
                model: 'Clinicas',
                key: 'id_clinica'
            }
        },
        asset_id: {
            type: DataTypes.INTEGER,
            allowNull: false,
            references: {
                model: 'ClinicMetaAssets',
                key: 'id'
            }
        },
        asset_type: {
            type: DataTypes.ENUM('facebook_page', 'instagram_business', 'ad_account'),
            allowNull: false
        },
        date: {
            type: DataTypes.DATEONLY,
            allowNull: false
        },
        impressions: {
            type: DataTypes.INTEGER,
            defaultValue: 0
        },
        reach: {
            type: DataTypes.INTEGER,
            defaultValue: 0
        },
        engagement: {
            type: DataTypes.INTEGER,
            defaultValue: 0
        },
        clicks: {
            type: DataTypes.INTEGER,
            defaultValue: 0
        },
        // Agregados diarios solicitados por CSV
        reach_total: { type: DataTypes.INTEGER, defaultValue: 0 },
        views: { type: DataTypes.INTEGER, defaultValue: 0 },
        likes: { type: DataTypes.INTEGER, defaultValue: 0 },
        reactions: { type: DataTypes.INTEGER, defaultValue: 0 },
        posts_count: { type: DataTypes.INTEGER, defaultValue: 0 },
        // Ads por plataforma
        reach_instagram: { type: DataTypes.INTEGER, defaultValue: 0 },
        reach_facebook: { type: DataTypes.INTEGER, defaultValue: 0 },
        impressions_instagram: { type: DataTypes.INTEGER, defaultValue: 0 },
        impressions_facebook: { type: DataTypes.INTEGER, defaultValue: 0 },
        views_facebook: { type: DataTypes.INTEGER, defaultValue: 0 },
        spend_instagram: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
        spend_facebook: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
        followers: {
            type: DataTypes.INTEGER,
            defaultValue: 0
        },
        followers_day: {
            type: DataTypes.INTEGER,
            defaultValue: 0
        },
        profile_visits: {
            type: DataTypes.INTEGER,
            defaultValue: 0
        }
    }, {
        tableName: 'SocialStatsDaily', // Actualizado a PascalCase
        timestamps: true,
        underscored: true,
        createdAt: 'created_at',
        updatedAt: 'updated_at',
        indexes: [
            {
                name: 'idx_social_stats_daily_clinica_asset_date',
                fields: ['clinica_id', 'asset_id', 'date']
            },
            {
                name: 'idx_social_stats_daily_asset_date',
                fields: ['asset_id', 'date']
            },
            {
                name: 'idx_social_stats_daily_date',
                fields: ['date']
            }
        ]
    });

    // Asociaciones
    SocialStatsDaily.associate = function(models) {
        // SocialStatsDaily pertenece a una Clínica
        SocialStatsDaily.belongsTo(models.Clinica, {
            foreignKey: 'clinica_id',
            targetKey: 'id_clinica',
            as: 'clinica'
        });

        // SocialStatsDaily pertenece a un ClinicMetaAsset
        SocialStatsDaily.belongsTo(models.ClinicMetaAsset, {
            foreignKey: 'asset_id',
            targetKey: 'id',
            as: 'asset'
        });
    };

    // Métodos estáticos
    
    /**
     * Obtener estadísticas diarias para una clínica específica
     * @param {number} clinicaId - ID de la clínica
     * @param {Date} startDate - Fecha de inicio
     * @param {Date} endDate - Fecha de fin
     * @returns {Promise<Array>} - Estadísticas diarias
     */
    SocialStatsDaily.getStatsByClinica = async function(clinicaId, startDate, endDate) {
        return await this.findAll({
            where: {
                clinica_id: clinicaId,
                date: {
                    [sequelize.Op.between]: [startDate, endDate]
                }
            },
            order: [['date', 'ASC']],
            include: [
                {
                    model: sequelize.models.ClinicMetaAsset,
                    as: 'asset',
                    attributes: ['id', 'assetType', 'metaAssetName']
                }
            ]
        });
    };

    /**
     * Obtener estadísticas diarias para un activo específico
     * @param {number} assetId - ID del activo
     * @param {Date} startDate - Fecha de inicio
     * @param {Date} endDate - Fecha de fin
     * @returns {Promise<Array>} - Estadísticas diarias
     */
    SocialStatsDaily.getStatsByAsset = async function(assetId, startDate, endDate) {
        return await this.findAll({
            where: {
                asset_id: assetId,
                date: {
                    [sequelize.Op.between]: [startDate, endDate]
                }
            },
            order: [['date', 'ASC']]
        });
    };

    /**
     * Agregar o actualizar estadísticas diarias
     * @param {Object} stats - Datos de estadísticas
     * @returns {Promise<Object>} - Registro creado o actualizado
     */
    SocialStatsDaily.upsertStats = async function(stats) {
        const [record, created] = await this.findOrCreate({
            where: {
                clinica_id: stats.clinica_id,
                asset_id: stats.asset_id,
                date: stats.date
            },
            defaults: stats
        });

        if (!created) {
            await record.update(stats);
        }

        return record;
    };

    /**
     * Obtener estadísticas agregadas por período
     * @param {number} clinicaId - ID de la clínica
     * @param {string} period - Período ('day', 'week', 'month', 'year')
     * @param {Date} startDate - Fecha de inicio
     * @param {Date} endDate - Fecha de fin
     * @returns {Promise<Array>} - Estadísticas agregadas
     */
    SocialStatsDaily.getAggregatedStats = async function(clinicaId, period, startDate, endDate) {
        let groupByClause;
        
        switch (period) {
            case 'week':
                groupByClause = [
                    sequelize.fn('YEAR', sequelize.col('date')),
                    sequelize.fn('WEEK', sequelize.col('date')),
                    'asset_id'
                ];
                break;
            case 'month':
                groupByClause = [
                    sequelize.fn('YEAR', sequelize.col('date')),
                    sequelize.fn('MONTH', sequelize.col('date')),
                    'asset_id'
                ];
                break;
            case 'year':
                groupByClause = [
                    sequelize.fn('YEAR', sequelize.col('date')),
                    'asset_id'
                ];
                break;
            default: // 'day' o cualquier otro valor
                return await this.getStatsByClinica(clinicaId, startDate, endDate);
        }

        return await this.findAll({
            attributes: [
                [sequelize.fn('DATE_FORMAT', sequelize.col('date'), '%Y-%m-%d'), 'date'],
                'asset_id',
                'asset_type',
                [sequelize.fn('SUM', sequelize.col('impressions')), 'impressions'],
                [sequelize.fn('SUM', sequelize.col('reach')), 'reach'],
                [sequelize.fn('SUM', sequelize.col('engagement')), 'engagement'],
                [sequelize.fn('SUM', sequelize.col('clicks')), 'clicks'],
                [sequelize.fn('MAX', sequelize.col('followers')), 'followers'],
                [sequelize.fn('SUM', sequelize.col('followers_day')), 'followers_day'],
                [sequelize.fn('SUM', sequelize.col('profile_visits')), 'profile_visits']
            ],
            where: {
                clinica_id: clinicaId,
                date: {
                    [sequelize.Op.between]: [startDate, endDate]
                }
            },
            group: groupByClause,
            include: [
                {
                    model: sequelize.models.ClinicMetaAsset,
                    as: 'asset',
                    attributes: ['id', 'assetType', 'metaAssetName']
                }
            ],
            raw: true
        });
    };

    return SocialStatsDaily;
};
