// backendclinicaclick/models/ClinicMetaAsset.js 
// Modelo actualizado con campos nuevos y métodos optimizados
module.exports = (sequelize, DataTypes) => {

    const ClinicMetaAsset = sequelize.define('ClinicMetaAsset', {
        id: {
            type: DataTypes.INTEGER,
            autoIncrement: true,
            primaryKey: true,
        },
        clinicaId: { 
            type: DataTypes.INTEGER,
            allowNull: true,
            references: {
                model: 'Clinicas',
                key: 'id_clinica',
            },
            onUpdate: 'CASCADE',
            onDelete: 'CASCADE',
        },
        grupoClinicaId: {
            type: DataTypes.INTEGER,
            allowNull: true,
            references: {
                model: 'GruposClinicas',
                key: 'id_grupo'
            },
            onUpdate: 'CASCADE',
            onDelete: 'SET NULL'
        },
        assignmentScope: {
            type: DataTypes.ENUM('clinic', 'group'),
            allowNull: false,
            defaultValue: 'clinic',
            comment: 'Indica si el activo se asigna a una clínica específica o al grupo completo'
        },
        metaConnectionId: { 
            type: DataTypes.INTEGER,
            allowNull: false,
            references: {
                model: 'MetaConnections',
                key: 'id',
            },
            onUpdate: 'CASCADE',
            onDelete: 'CASCADE',
        },
        assetType: { 
            type: DataTypes.ENUM('facebook_page', 'instagram_business', 'ad_account', 'whatsapp_business_account', 'whatsapp_phone_number'),
            allowNull: false,
            comment: 'Tipo de activo de Meta'
        },
        metaAssetId: { 
            type: DataTypes.STRING(255),
            allowNull: false,
            comment: 'ID único del activo en Meta'
        },
        metaAssetName: { 
            type: DataTypes.STRING(255),
            allowNull: true,
            comment: 'Nombre descriptivo del activo'
        },
        assetAvatarUrl: { 
            type: DataTypes.STRING(512),
            allowNull: true,
            comment: 'URL del avatar/icono del activo'
        },
        pageAccessToken: { 
            type: DataTypes.STRING(512),
            allowNull: true,
            comment: 'Page Access Token específico (solo para facebook_page)'
        },
        additionalData: { 
            type: DataTypes.JSON,
            allowNull: true,
            comment: 'Datos adicionales del activo (followers, categoría, etc.)'
        },
        isActive: { 
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: true,
            comment: 'Si el mapeo está activo o deshabilitado'
        }
        ,ad_account_status: { type: DataTypes.INTEGER, allowNull: true }
        ,ad_account_disable_reason: { type: DataTypes.STRING(64), allowNull: true }
        ,ad_account_spend_cap: { type: DataTypes.DECIMAL(18,2), allowNull: true }
        ,ad_account_amount_spent: { type: DataTypes.DECIMAL(18,2), allowNull: true }
        ,ad_account_refreshed_at: { type: DataTypes.DATE, allowNull: true }
        // WhatsApp fields
        ,wabaId: { type: DataTypes.STRING(255), allowNull: true }
        ,phoneNumberId: { type: DataTypes.STRING(255), allowNull: true }
        ,waVerifiedName: { type: DataTypes.STRING(255), allowNull: true }
        ,quality_rating: { type: DataTypes.STRING(64), allowNull: true }
        ,messaging_limit: { type: DataTypes.STRING(64), allowNull: true }
        ,waAccessToken: { type: DataTypes.TEXT, allowNull: true }
        ,meta_billed_by: { type: DataTypes.BOOLEAN, allowNull: true }
    }, {
        tableName: 'ClinicMetaAssets',
        timestamps: true,
        indexes: [ 
            {
                unique: true,
                fields: ['metaConnectionId', 'metaAssetId']
            },
            {
                fields: ['isActive']
            },
            {
                fields: ['assetType', 'isActive']
            },
            {
                fields: ['clinicaId', 'isActive']
            },
            {
                fields: ['grupoClinicaId', 'isActive']
            }
        ]
    });

    // ==========================================
    // ASOCIACIONES
    // ==========================================
    ClinicMetaAsset.associate = function(models) {
        // ClinicMetaAsset pertenece a Clinica
        ClinicMetaAsset.belongsTo(models.Clinica, { 
            foreignKey: 'clinicaId', 
            targetKey: 'id_clinica',
            as: 'clinica'
        });

        // ClinicMetaAsset pertenece a MetaConnection
        ClinicMetaAsset.belongsTo(models.MetaConnection, { 
            foreignKey: 'metaConnectionId', 
            targetKey: 'id',
            as: 'metaConnection'
        });

        ClinicMetaAsset.belongsTo(models.GrupoClinica, {
            foreignKey: 'grupoClinicaId',
            targetKey: 'id_grupo',
            as: 'grupoClinica'
        });
    };

    // ==========================================
    // MÉTODOS ESTÁTICOS PARA CONSULTAS
    // ==========================================

    /**
     * Obtener activos mapeados por clínica
     * @param {number} clinicaId - ID de la clínica
     * @param {boolean} includeInactive - Incluir mapeos inactivos
     * @returns {Promise<Array>} Lista de activos mapeados
     */
    ClinicMetaAsset.getAssetsByClinica = async function(clinicaId, includeInactive = false) {
        const whereClause = { clinicaId };
        if (!includeInactive) {
            whereClause.isActive = true;
        }

        return await this.findAll({
            where: whereClause,
            include: [
                {
                    model: sequelize.models.MetaConnection,
                    as: 'metaConnection',
                    attributes: ['id', 'userId', 'userName', 'userEmail'],
                    include: [
                        {
                            model: sequelize.models.Usuario,
                            as: 'usuario',
                            attributes: ['id_usuario', 'nombre', 'email_usuario']
                        }
                    ]
                }
            ],
            order: [['assetType', 'ASC'], ['metaAssetName', 'ASC']]
        });
    };

    /**
     * Obtener activos mapeados por usuario
     * @param {number} userId - ID del usuario
     * @param {boolean} includeInactive - Incluir mapeos inactivos
     * @returns {Promise<Array>} Lista de activos mapeados por el usuario
     */
    ClinicMetaAsset.getAssetsByUser = async function(userId, includeInactive = false) {
        const whereClause = { isActive: includeInactive ? [true, false] : true };

        return await this.findAll({
            where: whereClause,
            include: [
                {
                    model: sequelize.models.MetaConnection,
                    as: 'metaConnection',
                    where: { userId },
                    attributes: ['id', 'userId', 'userName', 'userEmail']
                },
                {
                    model: sequelize.models.Clinica,
                    as: 'clinica',
                    attributes: ['id_clinica', 'nombre_clinica', 'direccion_clinica']
                }
            ],
            order: [['assetType', 'ASC'], ['metaAssetName', 'ASC']]
        });
    };

    // ==========================================
    // MÉTODOS ESTÁTICOS PARA MAPEO
    // ==========================================

    /**
     * Mapear múltiples activos a múltiples clínicas
     * @param {Object} mappingData - Datos del mapeo
     * @param {number} mappingData.userId - ID del usuario
     * @param {Array} mappingData.assets - Lista de activos a mapear
     * @param {Array} mappingData.clinicaIds - Lista de IDs de clínicas
     * @returns {Promise<Array>} Resultados del mapeo
     */
    ClinicMetaAsset.mapAssetsToClinicas = async function(mappingData) {
        const { userId, assets, clinicaIds } = mappingData;
        
        // Obtener metaConnectionId del usuario
        const metaConnection = await sequelize.models.MetaConnection.findOne({
            where: { userId }
        });

        if (!metaConnection) {
            throw new Error('No se encontró conexión Meta para este usuario');
        }

        const results = [];

        // Crear mapeos para cada combinación asset-clínica
        for (const asset of assets) {
            for (const clinicaId of clinicaIds) {
                try {
                    // Verificar si ya existe un mapeo
                    const existing = await this.findOne({
                        where: { 
                            clinicaId,
                            metaConnectionId: metaConnection.id,
                            metaAssetId: asset.metaAssetId
                        }
                    });

                    if (existing) {
                        // Actualizar mapeo existente
                        await existing.update({
                            assetType: asset.assetType,
                            metaAssetName: asset.metaAssetName,
                            assetAvatarUrl: asset.assetAvatarUrl,
                            pageAccessToken: asset.pageAccessToken,
                            additionalData: asset.additionalData,
                            isActive: true
                        });
                        results.push({ 
                            action: 'updated', 
                            mapping: existing,
                            asset: asset.metaAssetId,
                            clinica: clinicaId
                        });
                    } else {
                        // Crear nuevo mapeo
                        const newMapping = await this.create({
                            clinicaId,
                            metaConnectionId: metaConnection.id,
                            assetType: asset.assetType,
                            metaAssetId: asset.metaAssetId,
                            metaAssetName: asset.metaAssetName,
                            assetAvatarUrl: asset.assetAvatarUrl,
                            pageAccessToken: asset.pageAccessToken,
                            additionalData: asset.additionalData,
                            isActive: true
                        });
                        results.push({ 
                            action: 'created', 
                            mapping: newMapping,
                            asset: asset.metaAssetId,
                            clinica: clinicaId
                        });
                    }
                } catch (error) {
                    results.push({ 
                        action: 'error', 
                        asset: asset.metaAssetId, 
                        clinica: clinicaId, 
                        error: error.message 
                    });
                }
            }
        }

        return results;
    };

    /**
     * Desmapear un activo específico
     * @param {number} userId - ID del usuario
     * @param {number} clinicaId - ID de la clínica
     * @param {string} metaAssetId - ID del activo en Meta
     * @returns {Promise<Array>} Resultado de la operación
     */
    ClinicMetaAsset.unmapAsset = async function(userId, clinicaId, metaAssetId) {
        // Obtener metaConnectionId del usuario
        const metaConnection = await sequelize.models.MetaConnection.findOne({
            where: { userId }
        });

        if (!metaConnection) {
            throw new Error('No se encontró conexión Meta para este usuario');
        }

        const result = await this.update(
            { isActive: false },
            {
                where: { 
                    clinicaId,
                    metaConnectionId: metaConnection.id,
                    metaAssetId,
                    isActive: true
                }
            }
        );

        return result[0] > 0; // Retorna true si se actualizó al menos un registro
    };

    // ==========================================
    // MÉTODOS ESTÁTICOS PARA CONSULTAS ESPECÍFICAS
    // ==========================================

    /**
     * Obtener Page Access Token específico
     * @param {number} userId - ID del usuario
     * @param {string} pageId - ID de la página de Facebook
     * @returns {Promise<string|null>} Page Access Token o null
     */
    ClinicMetaAsset.getPageAccessToken = async function(userId, pageId) {
        const asset = await this.findOne({
            where: {
                metaAssetId: pageId,
                assetType: 'facebook_page',
                isActive: true
            },
            include: [
                {
                    model: sequelize.models.MetaConnection,
                    as: 'metaConnection',
                    where: { userId }
                }
            ]
        });
        
        return asset ? asset.pageAccessToken : null;
    };

    /**
     * Verificar si un activo ya está mapeado
     * @param {number} userId - ID del usuario
     * @param {string} metaAssetId - ID del activo en Meta
     * @returns {Promise<boolean>} True si está mapeado
     */
    ClinicMetaAsset.isAssetMapped = async function(userId, metaAssetId) {
        const existing = await this.findOne({
            where: { 
                metaAssetId: metaAssetId,
                isActive: true
            },
            include: [
                {
                    model: sequelize.models.MetaConnection,
                    as: 'metaConnection',
                    where: { userId }
                }
            ]
        });
        return !!existing;
    };

    /**
     * Obtener resumen de mapeos por usuario
     * @param {number} userId - ID del usuario
     * @returns {Promise<Object>} Resumen de mapeos
     */
    ClinicMetaAsset.getMappingSummary = async function(userId) {
        const mappings = await this.getAssetsByUser(userId);
        
        const summary = {
            total_mappings: mappings.length,
            by_type: {
                facebook_page: mappings.filter(m => m.assetType === 'facebook_page').length,
                instagram_business: mappings.filter(m => m.assetType === 'instagram_business').length,
                ad_account: mappings.filter(m => m.assetType === 'ad_account').length
            },
            by_clinica: {},
            clinicas_with_assets: []
        };

        // Agrupar por clínica
        const clinicasMap = new Map();
        mappings.forEach(mapping => {
            const clinicaId = mapping.clinica.id_clinica;
            const clinicaName = mapping.clinica.nombre_clinica;
            
            if (!clinicasMap.has(clinicaId)) {
                clinicasMap.set(clinicaId, {
                    id: clinicaId,
                    name: clinicaName,
                    assets: []
                });
            }
            
            clinicasMap.get(clinicaId).assets.push({
                type: mapping.assetType,
                id: mapping.metaAssetId,
                name: mapping.metaAssetName
            });
        });

        summary.clinicas_with_assets = Array.from(clinicasMap.values());
        
        // Contar por clínica para compatibilidad
        clinicasMap.forEach((clinica, id) => {
            summary.by_clinica[clinica.name] = clinica.assets.length;
        });

        return summary;
    };

    return ClinicMetaAsset;
};
