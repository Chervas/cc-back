// backendclinicaclick/models/ClinicMetaAsset.js
// NO IMPORTA SEQUELIZE DIRECTAMENTE, LO RECIBE COMO ARGUMENTO
module.exports = (sequelize, DataTypes) => { // <-- Recibe sequelize y DataTypes

    const ClinicMetaAsset = sequelize.define('ClinicMetaAsset', {
        id: {
            type: DataTypes.INTEGER,
            autoIncrement: true,
            primaryKey: true,
        },
        clinicaId: { 
            type: DataTypes.INTEGER,
            allowNull: false,
            references: {
                model: 'Clinicas', // Nombre de la tabla, no el modelo
                key: 'id_clinica',
            },
            onUpdate: 'CASCADE',
            onDelete: 'CASCADE',
        },
        metaConnectionId: { 
            type: DataTypes.INTEGER,
            allowNull: false,
            references: {
                model: 'MetaConnections', // Nombre de la tabla, no el modelo
                key: 'id',
            },
            onUpdate: 'CASCADE',
            onDelete: 'CASCADE',
        },
        assetType: { 
            type: DataTypes.STRING,
            allowNull: false,
        },
        metaAssetId: { 
            type: DataTypes.STRING,
            allowNull: false,
        },
        metaAssetName: { 
            type: DataTypes.STRING,
            allowNull: true,
        },
        pageAccessToken: { 
            type: DataTypes.STRING(512),
            allowNull: true,
        },
    }, {
        tableName: 'ClinicMetaAssets',
        timestamps: true,
        indexes: [ 
            {
                unique: true,
                fields: ['clinicaId', 'assetType', 'metaAssetId']
            }
        ]
    });

    // Definir asociaciones
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
    };

    return ClinicMetaAsset;
};

