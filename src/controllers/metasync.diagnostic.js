'use strict';

const axios = require('axios');
const { MetaConnection, ClinicMetaAsset, Clinica } = require('../../models');
const {
  authorizeRequestedMarketingConnectionScope,
  marketingScopeInputFromRequest,
} = require('../lib/oauthMarketingScopeAccess');
const { hasMarketingClinicScopeAccess } = require('../lib/marketingScopeAccess');
const { resolveMetaConnectionForScope } = require('../services/scopeConnectionResolver.service');

// Constantes
const META_API_BASE_URL = 'https://graph.facebook.com/v23.0';

async function resolveDiagnosticMetaConnection(req, userId) {
  const scopeInput = marketingScopeInputFromRequest(req);
  if (!scopeInput.clinicIdRaw && !scopeInput.groupIdRaw) {
    const error = new Error('Indica clinic_id o group_id para ejecutar el diagnóstico');
    error.code = 'marketing_connection_scope_required';
    error.httpStatus = 400;
    throw error;
  }
  await authorizeRequestedMarketingConnectionScope({
    userId,
    ...scopeInput,
    access: 'write',
    findClinicGroupId: async (clinicId) => {
      const clinic = await Clinica.findByPk(clinicId, {
        attributes: ['grupoClinicaId'],
        raw: true,
      });
      return clinic?.grupoClinicaId || null;
    },
    findGroupClinicIds: async (groupId) => {
      const clinics = await Clinica.findAll({
        where: { grupoClinicaId: groupId },
        attributes: ['id_clinica'],
        raw: true,
      });
      return clinics.map((clinic) => clinic.id_clinica);
    },
    authorizeClinicIds: hasMarketingClinicScopeAccess,
  });
  return resolveMetaConnectionForScope({
    userId,
    ...scopeInput,
    allowLegacyUserFallback: true,
  });
}

async function authorizeDiagnosticAssetAccess(req, asset) {
  const userId = req.userData?.userId || req.user?.id;
  const clinicIds = asset.assignmentScope === 'group' && asset.grupoClinicaId
    ? (await Clinica.findAll({
      where: { grupoClinicaId: asset.grupoClinicaId },
      attributes: ['id_clinica'],
      raw: true,
    })).map((clinic) => clinic.id_clinica)
    : [asset.clinicaId].filter(Boolean);
  const allowed = clinicIds.length && await hasMarketingClinicScopeAccess({
    userId,
    clinicIds,
    access: 'write',
  });
  if (!allowed) {
    const error = new Error('No tienes permisos para diagnosticar este activo');
    error.code = 'asset_scope_forbidden';
    error.httpStatus = 403;
    throw error;
  }
}

function withoutAccessToken(params) {
  const sanitized = { ...(params || {}) };
  delete sanitized.access_token;
  return sanitized;
}

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
    const userId = req.userData.userId;
    
    // Obtener conexión de Meta
    const { connection, source } = await resolveDiagnosticMetaConnection(req, userId);
    
    if (!connection || !connection.accessToken) {
      return res.status(400).json({
        message: source === 'legacy_user_ambiguous'
          ? 'Hay varias conexiones Meta; indica clinic_id o group_id para el diagnóstico'
          : 'No se encontró conexión de Meta para este usuario o el token es nulo',
        hasConnection: false,
        connectionDetails: {
          exists: !!connection,
          hasToken: !!(connection && connection.accessToken),
          connectionId: connection?.id
        }
      });
    }
    
    console.log(`🔍 Probando conexión Meta para usuario ${userId}`);
    
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
        present: true
      }
    });
  } catch (error) {
    if (error?.httpStatus) {
      return res.status(error.httpStatus).json({
        success: false,
        error: error.code,
        message: error.message,
      });
    }
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
          params: withoutAccessToken(error.config?.params)
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

    await authorizeDiagnosticAssetAccess(req, asset);
    
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
    
    console.log(`🔍 Probando conexión para activo ${assetId} (${asset.assetType})`);
    
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
        fields: params.fields || null,
        tokenType: asset.pageAccessToken ? 'pageAccessToken' : 'userAccessToken'
      }
    });
  } catch (error) {
    if (error?.httpStatus) {
      return res.status(error.httpStatus).json({
        success: false,
        error: error.code,
        message: error.message,
      });
    }
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
          params: withoutAccessToken(error.config?.params)
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
    const userId = req.userData?.userId || req.user?.id;
    
    // Obtener conexión de Meta
    const { connection, source } = await resolveDiagnosticMetaConnection(req, userId);
    
    if (!connection || !connection.accessToken) {
      return res.status(400).json({
        message: source === 'legacy_user_ambiguous'
          ? 'Hay varias conexiones Meta; indica clinic_id o group_id para el diagnóstico'
          : 'No se encontró conexión de Meta para este usuario o el token es nulo',
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
    if (error?.httpStatus) {
      return res.status(error.httpStatus).json({
        success: false,
        error: error.code,
        message: error.message,
      });
    }
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
  const period = req.query.period || 'day';
  const qSince = req.query.since || null; // YYYY-MM-DD
  const qUntil = req.query.until || null; // YYYY-MM-DD
  const metricType = req.query.metric_type || null; // e.g., total_value
    
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
    await authorizeDiagnosticAssetAccess(req, asset);
    
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
        params.period = period;
        params.since = qSince || since;
        params.until = qUntil || until;
        break;
      case 'instagram_business':
        apiUrl = `${META_API_BASE_URL}/${asset.metaAssetId}/insights`;
        // Permitir métrica personalizada (por ejemplo: content_views, views, reach)
        params.metric = metric || 'reach';
        params.period = period;
        params.since = qSince || since;
        params.until = qUntil || until;
        if ((metric === 'content_views' || metric === 'views') && !metricType) {
          params.metric_type = 'total_value';
        } else if (metricType) {
          params.metric_type = metricType;
        }
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
        params: withoutAccessToken(params)
      },
      sampleData: response.data
    });
  } catch (error) {
    if (error?.httpStatus) {
      return res.status(error.httpStatus).json({
        success: false,
        error: error.code,
        message: error.message,
      });
    }
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
          params: withoutAccessToken(error.config?.params)
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
    await authorizeDiagnosticAssetAccess(req, asset);
    
    return res.json({
      message: `Detalles del activo ${asset.metaAssetName} (${asset.assetType})`,
      success: true,
      assetDetails: {
        id: asset.id,
        clinicaId: asset.clinicaId,
        metaAssetId: asset.metaAssetId,
        metaAssetName: asset.metaAssetName,
        assetType: asset.assetType,
        hasPageToken: !!asset.pageAccessToken,
        hasUserToken: !!(asset.metaConnection && asset.metaConnection.accessToken),
        createdAt: asset.createdAt,
        updatedAt: asset.updatedAt
      }
    });
  } catch (error) {
    if (error?.httpStatus) {
      return res.status(error.httpStatus).json({
        success: false,
        error: error.code,
        message: error.message,
      });
    }
    console.error(`❌ Error al obtener detalles del activo:`, error);
    
    return res.status(500).json({
      message: 'Error al obtener detalles del activo',
      success: false,
      error: error.message
    });
  }
};
