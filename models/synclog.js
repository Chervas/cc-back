// models/synclog.js
module.exports = (sequelize, DataTypes) => {
    const SyncLog = sequelize.define('SyncLog', {
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true
        },
        job_type: {
            type: DataTypes.STRING(50),
            allowNull: false,
            comment: 'Tipo de trabajo de sincronización'
        },
        status: {
            type: DataTypes.ENUM('pending', 'running', 'completed', 'failed'),
            allowNull: false,
            defaultValue: 'pending',
            comment: 'Estado del proceso de sincronización'
        },
        clinica_id: {
            type: DataTypes.INTEGER,
            allowNull: true,
            references: {
                model: 'Clinicas',
                key: 'id_clinica'
            },
            comment: 'ID de la clínica relacionada (si aplica)'
        },
        asset_id: {
            type: DataTypes.INTEGER,
            allowNull: true,
            references: {
                model: 'ClinicMetaAssets',
                key: 'id'
            },
            comment: 'ID del activo relacionado (si aplica)'
        },
        asset_type: {
            type: DataTypes.STRING(50),
            allowNull: true,
            comment: 'Tipo de activo relacionado'
        },
        start_time: {
            type: DataTypes.DATE,
            allowNull: true,
            comment: 'Hora de inicio del proceso'
        },
        end_time: {
            type: DataTypes.DATE,
            allowNull: true,
            comment: 'Hora de finalización del proceso'
        },
        records_processed: {
            type: DataTypes.INTEGER,
            defaultValue: 0,
            comment: 'Número de registros procesados'
        },
        error_message: {
            type: DataTypes.TEXT,
            allowNull: true,
            comment: 'Mensaje de error (si aplica)'
        },
         status_report: {
            type: DataTypes.JSON,
            allowNull: true,
            comment: 'Información detallada del estado del job'
        }
    }, {
        tableName: 'SyncLogs', // Actualizado a PascalCase
        timestamps: true,
        underscored: true,
        createdAt: 'created_at',
        updatedAt: 'updated_at',
        indexes: [
            {
                name: 'idx_sync_logs_job_type_status',
                fields: ['job_type', 'status']
            },
            {
                name: 'idx_sync_logs_clinica_asset',
                fields: ['clinica_id', 'asset_id']
            },
            {
                name: 'idx_sync_logs_created_at',
                fields: ['created_at']
            }
        ]
    });

    // Asociaciones
    SyncLog.associate = function(models) {
        // SyncLog puede pertenecer a una Clínica
        SyncLog.belongsTo(models.Clinica, {
            foreignKey: 'clinica_id',
            targetKey: 'id_clinica',
            as: 'clinica'
        });

        // SyncLog puede pertenecer a un ClinicMetaAsset
        SyncLog.belongsTo(models.ClinicMetaAsset, {
            foreignKey: 'asset_id',
            targetKey: 'id',
            as: 'asset'
        });
    };

    // Métodos estáticos

    /**
     * Crear un nuevo registro de sincronización
     * @param {Object} logData - Datos del registro
     * @returns {Promise<Object>} - Registro creado
     */
    SyncLog.createLog = async function(logData) {
        return await this.create(logData);
    };

    /**
     * Iniciar un proceso de sincronización
     * @param {Object} logData - Datos del registro
     * @returns {Promise<Object>} - Registro creado
     */
    SyncLog.startSync = async function(logData) {
        return await this.create({
            ...logData,
            status: 'running',
            start_time: new Date()
        });
    };

    /**
     * Completar un proceso de sincronización
     * @param {number} logId - ID del registro
     * @param {Object} updateData - Datos a actualizar
     * @returns {Promise<Object>} - Registro actualizado
     */
    SyncLog.completeSync = async function(logId, updateData = {}) {
        const log = await this.findByPk(logId);
        if (!log) {
            throw new Error(`No se encontró el registro de sincronización con ID ${logId}`);
        }

        return await log.update({
            status: 'completed',
            end_time: new Date(),
            ...updateData
        });
    };

    /**
     * Marcar un proceso de sincronización como fallido
     * @param {number} logId - ID del registro
     * @param {string} errorMessage - Mensaje de error
     * @returns {Promise<Object>} - Registro actualizado
     */
    SyncLog.failSync = async function(logId, errorMessage) {
        const log = await this.findByPk(logId);
        if (!log) {
            throw new Error(`No se encontró el registro de sincronización con ID ${logId}`);
        }

        return await log.update({
            status: 'failed',
            end_time: new Date(),
            error_message: errorMessage
        });
    };

    /**
     * Obtener los últimos registros de sincronización
     * @param {Object} options - Opciones de consulta
     * @returns {Promise<Array>} - Registros de sincronización
     */
    SyncLog.getLatestLogs = async function(options = {}) {
        const { limit = 50, jobType, status, clinicaId, assetId } = options;
        
        const whereClause = {};
        
        if (jobType) {
            whereClause.job_type = jobType;
        }
        
        if (status) {
            whereClause.status = status;
        }
        
        if (clinicaId) {
            whereClause.clinica_id = clinicaId;
        }
        
        if (assetId) {
            whereClause.asset_id = assetId;
        }

        return await this.findAll({
            where: whereClause,
            limit: parseInt(limit),
            order: [['created_at', 'DESC']],
            include: [
                {
                    model: sequelize.models.Clinica,
                    as: 'clinica',
                    attributes: ['id_clinica', 'nombre_clinica']
                },
                {
                    model: sequelize.models.ClinicMetaAsset,
                    as: 'asset',
                    attributes: ['id', 'assetType', 'metaAssetName']
                }
            ]
        });
    };

    /**
     * Obtener estadísticas de sincronización
     * @returns {Promise<Object>} - Estadísticas de sincronización
     */
    SyncLog.getSyncStats = async function() {
        const totalJobs = await this.count();
        const completedJobs = await this.count({ where: { status: 'completed' } });
        const failedJobs = await this.count({ where: { status: 'failed' } });
        const pendingJobs = await this.count({ where: { status: 'pending' } });
        const runningJobs = await this.count({ where: { status: 'running' } });

        // Obtener tiempo promedio de sincronización (solo para trabajos completados)
        const avgTimeResult = await this.findAll({
            attributes: [
                [
                    sequelize.fn(
                        'AVG',
                        sequelize.fn(
                            'TIMESTAMPDIFF',
                            sequelize.literal('SECOND'),
                            sequelize.col('start_time'),
                            sequelize.col('end_time')
                        )
                    ),
                    'avg_time'
                ]
            ],
            where: {
                status: 'completed',
                start_time: { [sequelize.Op.ne]: null },
                end_time: { [sequelize.Op.ne]: null }
            },
            raw: true
        });

        const avgTime = avgTimeResult[0].avg_time || 0;

        // Obtener estadísticas por tipo de trabajo
        const jobTypeStats = await this.findAll({
            attributes: [
                'job_type',
                [sequelize.fn('COUNT', sequelize.col('id')), 'total'],
                [
                    sequelize.fn(
                        'SUM',
                        sequelize.literal(`CASE WHEN status = 'completed' THEN 1 ELSE 0 END`)
                    ),
                    'completed'
                ],
                [
                    sequelize.fn(
                        'SUM',
                        sequelize.literal(`CASE WHEN status = 'failed' THEN 1 ELSE 0 END`)
                    ),
                    'failed'
                ]
            ],
            group: ['job_type'],
            raw: true
        });

        return {
            total_jobs: totalJobs,
            completed_jobs: completedJobs,
            failed_jobs: failedJobs,
            pending_jobs: pendingJobs,
            running_jobs: runningJobs,
            avg_time_seconds: avgTime,
            by_job_type: jobTypeStats
        };
    };

    return SyncLog;
};

