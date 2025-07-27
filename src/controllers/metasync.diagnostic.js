'use strict';

const axios = require('axios');
const { MetaConnection, ClinicMetaAsset } = require('../../models');

// Constantes
const META_API_BASE_URL = 'https://graph.facebook.com/v23.0';

/**
 * Controlador de diagnóstico para verificar la comunicación con la API de Meta
 * Este controlador proporciona endpoints para probar directamente la comunicación
 * con la API de Meta y ver las respuestas crudas para diagnóstico.
 */

/**
 * Verifica la conexión básica con la API de Meta usando el token de usuario
 */
exports.testUserConnection = async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Obtener conexión de Meta
    const connection = await MetaConnection.findOne({
      where: { userId }
    });
    
    if (!connection || !connection.accessToken) {
      return res.status(400).json({
        message: 'No se encontró conexión de Meta para este usuario o el token es nulo',
        hasConnection: false,
        connectionDetails: {
          exists: !!connection,
          hasToken: !!(connection && connection.accessToken),
          connectionId: connection?.id
        }
      });
    }
    
    console.log(`🔍 Probando conexión para usuario ${userId} con token: ${connection.accessToken.substring(0, 10)}...`);
    
    // Probar conexión con Meta
    const response = await axios.get(`${META_API_BASE_URL}/me`, {
      params: { access_token: connection.accessToken }
    });
    
    console.log(`✅ Respuesta exitosa de Meta API para usuario ${userId}`);
    
    return res.json({
      message: 'Conexión exitosa con Meta API',
      hasConnection: true,
      userData: response.data,
      tokenInfo: {
        tokenPrefix: connection.accessToken.substring(0, 10) + '...',
        tokenLength: connection.accessToken.length
      }
    });
  } catch (error) {
    console.error('❌ Error al probar conexión con Meta:', error.response?.data || error.message);
    
    return res.status(500).json({
      message: 'Error al probar conexión con Meta',
      error: error.response?.data || error.message,
      errorDetails: {
        status: error.response?.status,
        statusText: error.response?.statusText,
        config: {
          url: error.config?.url,
          method: error.config?.method,
          params: error.config?.params
        }
      }
    });
  }
};

/**
 * Verifica la conexión con un activo específico (página, cuenta de Instagram, etc.)
 */
exports.testAssetConnection = async (req, res) => {
  try {
    const assetId = req.params.assetId;
    
    // Obtener activo
    const asset = await ClinicMetaAsset.findByPk(assetId, {
      include: [{ model: MetaConnection, as: 'metaConnection' }]
    });
    
    if (!asset) {
      return res.status(404).json({
        message: `No se encontró el activo con ID ${assetId}`,
        success: false
      });
    }
    
    // Obtener token de acceso (primero intentar pageAccessToken, luego el token de usuario)
    const accessToken = asset.pageAccessToken || asset.metaConnection?.accessToken;
    
    if (!accessToken) {
      return res.status(400).json({
        message: 'No se encontró token de acceso para este activo',
        success: false,
        assetDetails: {
          id: asset.id,
          type: asset.assetType,
          name: asset.metaAssetName,
          hasPageToken: !!asset.pageAccessToken,
          hasUserToken: !!(asset.metaConnection && asset.metaConnection.accessToken)
        }
      });
    }
    
    console.log(`🔍 Probando conexión para activo ${assetId} (${asset.assetType}) con token: ${accessToken.substring(0, 10)}...`);
    
    // Construir URL según tipo de activo
    let apiUrl;
    let params = { access_token: accessToken };
    
    switch (asset.assetType) {
      case 'facebook_page':
        apiUrl = `${META_API_BASE_URL}/${asset.metaAssetId}`;
        params.fields = 'id,name,fan_count,link,picture';
        break;
      case 'instagram_business':
        apiUrl = `${META_API_BASE_URL}/${asset.metaAssetId}`;
        params.fields = 'id,username,profile_picture_url,followers_count,media_count';
        break;
      case 'ad_account':
        apiUrl = `${META_API_BASE_URL}/act_${asset.metaAssetId}`;
        params.fields = 'id,name,account_status,amount_spent,balance';
        break;
      default:
        return res.status(400).json({
          message: `Tipo de activo no soportado: ${asset.assetType}`,
          success: false
        });
    }
    
    // Probar conexión con Meta
    const response = await axios.get(apiUrl, { params });
    
    console.log(`✅ Respuesta exitosa de Meta API para activo ${assetId} (${asset.assetType})`);
    
    return res.json({
      message: `Conexión exitosa con activo ${asset.metaAssetName} (${asset.assetType})`,
      success: true,
      assetData: response.data,
      requestDetails: {
        url: apiUrl,
        params: params,
        tokenType: asset.pageAccessToken ? 'pageAccessToken' : 'userAccessToken'
      }
    });
  } catch (error) {
    console.error(`❌ Error al probar conexión con activo:`, error.response?.data || error.message);
    
    return res.status(500).json({
      message: 'Error al probar conexión con activo',
      success: false,
      error: error.response?.data || error.message,
      errorDetails: {
        status: error.response?.status,
        statusText: error.response?.statusText,
        config: {
          url: error.config?.url,
          method: error.config?.method,
          params: error.config?.params
        }
      }
    });
  }
};

/**
 * Verifica los permisos disponibles para la aplicación
 */
exports.checkPermissions = async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Obtener conexión de Meta
    const connection = await MetaConnection.findOne({
      where: { userId }
    });
    
    if (!connection || !connection.accessToken) {
      return res.status(400).json({
        message: 'No se encontró conexión de Meta para este usuario o el token es nulo',
        success: false
      });
    }
    
    console.log(`🔍 Verificando permisos para usuario ${userId}`);
    
    // Verificar permisos
    const response = await axios.get(`${META_API_BASE_URL}/me/permissions`, {
      params: { access_token: connection.accessToken }
    });
    
    console.log(`✅ Permisos obtenidos exitosamente para usuario ${userId}`);
    
    // Analizar permisos
    const permissions = response.data.data || [];
    const grantedPermissions = permissions.filter(p => p.status === 'granted').map(p => p.permission);
    const declinedPermissions = permissions.filter(p => p.status === 'declined').map(p => p.permission);
    
    // Verificar permisos críticos
    const criticalPermissions = [
      'pages_read_engagement',
      'pages_show_list',
      'instagram_basic',
      'instagram_manage_insights',
      'ads_read'
    ];
    
    const missingCriticalPermissions = criticalPermissions.filter(p => !grantedPermissions.includes(p));
    
    return res.json({
      message: 'Permisos verificados exitosamente',
      success: true,
      permissionsData: {
        granted: grantedPermissions,
        declined: declinedPermissions,
        missingCritical: missingCriticalPermissions,
        hasCriticalPermissions: missingCriticalPermissions.length === 0
      },
      rawResponse: response.data
    });
  } catch (error) {
    console.error('❌ Error al verificar permisos:', error.response?.data || error.message);
    
    return res.status(500).json({
      message: 'Error al verificar permisos',
      success: false,
      error: error.response?.data || error.message
    });
  }
};

/**
 * Obtiene datos de ejemplo de la API de Meta para un activo específico
 */
exports.getSampleData = async (req, res) => {
  try {
    const assetId = req.params.assetId;
    const metric = req.query.metric || 'page_impressions'; // Métrica por defecto
    
    // Obtener activo
    const asset = await ClinicMetaAsset.findByPk(assetId, {
      include: [{ model: MetaConnection, as: 'metaConnection' }]
    });
    
    if (!asset) {
      return res.status(404).json({
        message: `No se encontró el activo con ID ${assetId}`,
        success: false
      });
    }
    
    // Obtener token de acceso
    const accessToken = asset.pageAccessToken || asset.metaConnection?.accessToken;
    
    if (!accessToken) {
      return res.status(400).json({
        message: 'No se encontró token de acceso para este activo',
        success: false
      });
    }
    
    console.log(`🔍 Obteniendo datos de ejemplo para activo ${assetId} (${asset.assetType}), métrica: ${metric}`);
    
    // Construir URL y parámetros según tipo de activo
    let apiUrl;
    let params = { access_token: accessToken };
    
    const today = new Date();
    const thirtyDaysAgo = new Date(today);
    thirtyDaysAgo.setDate(today.getDate() - 30);
    
    // Formatear fechas como YYYY-MM-DD
    const since = thirtyDaysAgo.toISOString().split('T')[0];
    const until = today.toISOString().split('T')[0];
    
    switch (asset.assetType) {
      case 'facebook_page':
        apiUrl = `${META_API_BASE_URL}/${asset.metaAssetId}/insights`;
        params.metric = metric;
        params.period = 'day';
        params.since = since;
        params.until = until;
        break;
      case 'instagram_business':
        apiUrl = `${META_API_BASE_URL}/${asset.metaAssetId}/insights`;
        params.metric = 'impressions,reach,profile_views';
        params.period = 'day';
        params.since = since;
        params.until = until;
        break;
      default:
        return res.status(400).json({
          message: `Tipo de activo no soportado para obtener métricas: ${asset.assetType}`,
          success: false
        });
    }
    
    // Obtener datos de la API de Meta
    const response = await axios.get(apiUrl, { params });
    
    console.log(`✅ Datos de ejemplo obtenidos exitosamente para activo ${assetId} (${asset.assetType})`);
    
    return res.json({
      message: `Datos de ejemplo obtenidos exitosamente para ${asset.metaAssetName} (${asset.assetType})`,
      success: true,
      requestDetails: {
        url: apiUrl,
        params: params
      },
      sampleData: response.data
    });
  } catch (error) {
    console.error(`❌ Error al obtener datos de ejemplo:`, error.response?.data || error.message);
    
    return res.status(500).json({
      message: 'Error al obtener datos de ejemplo',
      success: false,
      error: error.response?.data || error.message,
      errorDetails: {
        status: error.response?.status,
        statusText: error.response?.statusText,
        config: {
          url: error.config?.url,
          method: error.config?.method,
          params: error.config?.params
        }
      }
    });
  }
};

/**
 * Obtiene información detallada sobre un activo específico
 */
exports.getAssetDetails = async (req, res) => {
  try {
    const assetId = req.params.assetId;
    
    // Obtener activo
    const asset = await ClinicMetaAsset.findByPk(assetId, {
      include: [{ model: MetaConnection, as: 'metaConnection' }]
    });
    
    if (!asset) {
      return res.status(404).json({
        message: `No se encontró el activo con ID ${assetId}`,
        success: false
      });
    }
    
    return res.json({
      message: `Detalles del activo ${asset.metaAssetName} (${asset.assetType})`,
      success: true,
      assetDetails: {
        id: asset.id,
        clinicaId: asset.clinicaId,
        metaConnectionId: asset.metaConnectionId,
        metaAssetId: asset.metaAssetId,
        metaAssetName: asset.metaAssetName,
        assetType: asset.assetType,
        hasPageToken: !!asset.pageAccessToken,
        hasUserToken: !!(asset.metaConnection && asset.metaConnection.accessToken),
        pageTokenLength: asset.pageAccessToken?.length,
        userTokenLength: asset.metaConnection?.accessToken?.length,
        createdAt: asset.createdAt,
        updatedAt: asset.updatedAt
      }
    });
  } catch (error) {
    console.error(`❌ Error al obtener detalles del activo:`, error);
    
    return res.status(500).json({
      message: 'Error al obtener detalles del activo',
      success: false,
      error: error.message
    });
  }
};

