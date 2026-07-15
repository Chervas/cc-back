// backendclinicaclick/models/MetaConnection.js
// NO IMPORTA SEQUELIZE DIRECTAMENTE, LO RECIBE COMO ARGUMENTO
module.exports = (sequelize, DataTypes) => { // <-- Recibe sequelize y DataTypes

    const MetaConnection = sequelize.define('MetaConnection', {
        id: {
            type: DataTypes.INTEGER,
            autoIncrement: true,
            primaryKey: true,
        },
        userId: { 
            type: DataTypes.INTEGER,
            allowNull: true,
            references: {
                model: 'Usuarios', // Nombre de la tabla, no el modelo
                key: 'id_usuario', 
            },
            onUpdate: 'CASCADE',
            onDelete: 'SET NULL',
        },
        metaUserId: { 
            type: DataTypes.STRING,
            allowNull: false,
        },
        accessToken: { 
            type: DataTypes.STRING(512), 
            allowNull: false,
        },
        expiresAt: { 
            type: DataTypes.DATE,
            allowNull: true,
        },
        userName: { 
            type: DataTypes.STRING,
            allowNull: true,
        },
        userEmail: { 
            type: DataTypes.STRING,
            allowNull: true,
        },
    }, {
        tableName: 'MetaConnections',
        timestamps: true,
        indexes: [
            { name: 'idx_meta_connections_user_id', fields: ['userId'] },
            { name: 'idx_meta_connections_provider_id', fields: ['metaUserId'] },
            {
                name: 'uniq_meta_connections_user_provider',
                unique: true,
                fields: ['userId', 'metaUserId']
            }
        ],
    });

    // Definir asociaciones
    MetaConnection.associate = function(models) {
        // MetaConnection pertenece a Usuario
        MetaConnection.belongsTo(models.Usuario, { 
            foreignKey: 'userId', 
            targetKey: 'id_usuario',
            as: 'usuario'
        });
        if (models.MetaConnectionAssignment) {
            MetaConnection.hasMany(models.MetaConnectionAssignment, {
                foreignKey: 'metaConnectionId',
                as: 'assignments'
            });
        }
    };

    return MetaConnection;
};
