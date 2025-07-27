// models/socialpost.js
module.exports = (sequelize, DataTypes) => {
    const SocialPost = sequelize.define('SocialPost', {
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
            type: DataTypes.ENUM('facebook_page', 'instagram_business'),
            allowNull: false
        },
        post_id: {
            type: DataTypes.STRING(255),
            allowNull: false,
            comment: 'ID único del post en la plataforma (Facebook/Instagram)'
        },
        post_type: {
            type: DataTypes.STRING(50),
            allowNull: false,
            comment: 'Tipo de publicación (photo, video, carousel, etc.)'
        },
        title: {
            type: DataTypes.TEXT,
            allowNull: true,
            comment: 'Título o primera parte del contenido'
        },
        content: {
            type: DataTypes.TEXT,
            allowNull: true,
            comment: 'Contenido completo del post'
        },
        media_url: {
            type: DataTypes.TEXT,
            allowNull: true,
            comment: 'URL de la imagen o video principal'
        },
        permalink_url: {
            type: DataTypes.STRING(512),
            allowNull: true,
            comment: 'URL permanente para ver el post'
        },
        published_at: {
            type: DataTypes.DATE,
            allowNull: true,
            comment: 'Fecha de publicación'
        }
    }, {
        tableName: 'SocialPosts', // Actualizado a PascalCase
        timestamps: true,
        underscored: true,
        createdAt: 'created_at',
        updatedAt: 'updated_at',
        indexes: [
            {
                name: 'idx_social_posts_clinica_asset',
                fields: ['clinica_id', 'asset_id']
            },
            {
                name: 'idx_social_posts_post_id',
                fields: ['post_id']
            },
            {
                name: 'idx_social_posts_published_at',
                fields: ['published_at']
            },
            {
                name: 'idx_social_posts_asset_post_unique',
                unique: true,
                fields: ['asset_id', 'post_id']
            }
        ]
    });

    // Asociaciones
    SocialPost.associate = function(models) {
        // SocialPost pertenece a una Clínica
        SocialPost.belongsTo(models.Clinica, {
            foreignKey: 'clinica_id',
            targetKey: 'id_clinica',
            as: 'clinica'
        });

        // SocialPost pertenece a un ClinicMetaAsset
        SocialPost.belongsTo(models.ClinicMetaAsset, {
            foreignKey: 'asset_id',
            targetKey: 'id',
            as: 'asset'
        });

        // SocialPost tiene muchas SocialPostStatsDaily
        SocialPost.hasMany(models.SocialPostStatsDaily, {
            foreignKey: 'post_id',
            sourceKey: 'id',
            as: 'stats'
        });
    };

    // Métodos estáticos

    /**
     * Buscar o crear una publicación
     * @param {Object} postData - Datos de la publicación
     * @returns {Promise<Object>} - Publicación creada o encontrada
     */
    SocialPost.findOrCreatePost = async function(postData) {
        const [post, created] = await this.findOrCreate({
            where: {
                asset_id: postData.asset_id,
                post_id: postData.post_id
            },
            defaults: postData
        });

        if (!created && postData.title) {
            // Actualizar datos si la publicación ya existe
            await post.update({
                title: postData.title,
                content: postData.content,
                media_url: postData.media_url,
                permalink_url: postData.permalink_url,
                published_at: postData.published_at
            });
        }

        return post;
    };

    /**
     * Obtener publicaciones de una clínica
     * @param {number} clinicaId - ID de la clínica
     * @param {Object} options - Opciones de consulta (limit, offset, startDate, endDate)
     * @returns {Promise<Object>} - Publicaciones y total
     */
    SocialPost.getPostsByClinica = async function(clinicaId, options = {}) {
        const { limit = 10, offset = 0, startDate, endDate } = options;
        
        const whereClause = { clinica_id: clinicaId };
        
        if (startDate && endDate) {
            whereClause.published_at = {
                [sequelize.Op.between]: [startDate, endDate]
            };
        }

        const { count, rows } = await this.findAndCountAll({
            where: whereClause,
            limit: parseInt(limit),
            offset: parseInt(offset),
            order: [['published_at', 'DESC']],
            include: [
                {
                    model: sequelize.models.ClinicMetaAsset,
                    as: 'asset',
                    attributes: ['id', 'assetType', 'metaAssetName']
                }
            ]
        });

        return {
            total: count,
            posts: rows
        };
    };

    /**
     * Obtener publicaciones de un activo específico
     * @param {number} assetId - ID del activo
     * @param {Object} options - Opciones de consulta (limit, offset, startDate, endDate)
     * @returns {Promise<Object>} - Publicaciones y total
     */
    SocialPost.getPostsByAsset = async function(assetId, options = {}) {
        const { limit = 10, offset = 0, startDate, endDate } = options;
        
        const whereClause = { asset_id: assetId };
        
        if (startDate && endDate) {
            whereClause.published_at = {
                [sequelize.Op.between]: [startDate, endDate]
            };
        }

        const { count, rows } = await this.findAndCountAll({
            where: whereClause,
            limit: parseInt(limit),
            offset: parseInt(offset),
            order: [['published_at', 'DESC']]
        });

        return {
            total: count,
            posts: rows
        };
    };

    /**
     * Obtener una publicación con sus estadísticas
     * @param {number} postId - ID de la publicación
     * @returns {Promise<Object>} - Publicación con estadísticas
     */
    SocialPost.getPostWithStats = async function(postId) {
        return await this.findByPk(postId, {
            include: [
                {
                    model: sequelize.models.SocialPostStatsDaily,
                    as: 'stats',
                    order: [['date', 'ASC']]
                },
                {
                    model: sequelize.models.ClinicMetaAsset,
                    as: 'asset',
                    attributes: ['id', 'assetType', 'metaAssetName']
                }
            ]
        });
    };

    return SocialPost;
};

