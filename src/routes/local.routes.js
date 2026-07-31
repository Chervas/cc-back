'use strict';

const express = require('express');
const authMiddleware = require('./auth.middleware');
const {
  hasMarketingClinicScopeAccess,
} = require('../lib/marketingScopeAccess');
const {
  resolveClinicGoogleReviewProfile,
} = require('../services/googleLocalLinks.service');
const businessProfileLocal = require('../services/businessProfileLocal.service');
const googleSpecialHoursAutomation = require('../services/googleSpecialHoursAutomation.service');

const router = express.Router();

function toClinicId(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function sendError(res, error, fallback = 'local_request_failed') {
  const status = Number(error?.status || error?.response?.status || 500);
  if (status >= 500) {
    console.error('❌ Google Business Profile local:', error);
  }
  return res.status(status >= 400 && status < 600 ? status : 500).json({
    success: false,
    error: error?.message || fallback,
  });
}

async function requireClinicMarketingAccess(req, res, next) {
  try {
    const clinicId = toClinicId(req.params.clinicaId);
    if (!clinicId) {
      return res.status(400).json({ success: false, error: 'local_clinic_invalid' });
    }
    const allowed = await hasMarketingClinicScopeAccess({
      userId: req.userData?.userId,
      clinicIds: [clinicId],
      access: 'read',
    });
    if (!allowed) {
      return res.status(403).json({ success: false, error: 'scope_forbidden' });
    }
    req.localClinicId = clinicId;
    req.localResolved = await businessProfileLocal.resolveEffectiveLocations(clinicId);
    return next();
  } catch (error) {
    return sendError(res, error);
  }
}

async function requireClinicBusinessProfileWriteAccess(req, res, next) {
  try {
    const allowed = await hasMarketingClinicScopeAccess({
      userId: req.userData?.userId,
      clinicIds: [req.localClinicId],
      access: 'write',
    });
    if (!allowed) {
      return res.status(403).json({ success: false, error: 'scope_write_forbidden' });
    }
    const affectedClinicIds = await businessProfileLocal.resolvePhotoMutationClinicIds(req.localResolved);
    const sharedAssetAllowed = await hasMarketingClinicScopeAccess({
      userId: req.userData?.userId,
      clinicIds: affectedClinicIds,
      access: 'write',
    });
    if (!sharedAssetAllowed) {
      return res.status(409).json({
        success: false,
        error: 'business_profile_asset_in_use',
        message: 'La ficha también se utiliza en otras clínicas sobre las que no tienes permisos de edición.',
      });
    }
    req.localBusinessProfileMutationClinicIds = affectedClinicIds;
    return next();
  } catch (error) {
    return sendError(res, error);
  }
}

async function requireClinicMarketingClinicWriteAccess(req, res, next) {
  try {
    const allowed = await hasMarketingClinicScopeAccess({
      userId: req.userData?.userId,
      clinicIds: [req.localClinicId],
      access: 'write',
    });
    if (!allowed) {
      return res.status(403).json({ success: false, error: 'scope_write_forbidden' });
    }
    return next();
  } catch (error) {
    return sendError(res, error);
  }
}

router.use(authMiddleware);
router.use('/clinica/:clinicaId', requireClinicMarketingAccess);

router.get('/clinica/:clinicaId/status', async (req, res) => {
  try {
    const purpose = String(req.query?.purpose || '').trim().toLowerCase();
    if (purpose !== 'reviews') {
      return res.json(businessProfileLocal.buildStatus(req.localResolved));
    }

    const profile = await resolveClinicGoogleReviewProfile(req.localClinicId);
    if (!profile?.alias || !profile?.location || !profile?.links?.url_dejar_resena) {
      return res.json(businessProfileLocal.buildStatus(req.localResolved));
    }
    const location = businessProfileLocal.serializeLocation(profile.location, {
      assignmentOrigin: 'review_alias',
    });
    location.reviewAlias = true;
    location.reviewAliasSourceClinicId = req.localClinicId;
    location.reviewAliasClinicId = Number(profile.location.clinica_id || profile.locationClinic?.id_clinica || 0) || null;
    location.reviewAliasClinicName = profile.locationClinic?.nombre_clinica || null;
    return res.json({ success: true, hasMappings: true, locations: [location] });
  } catch (error) {
    return sendError(res, error, 'local_status_failed');
  }
});

router.get('/clinica/:clinicaId/dashboard', async (req, res) => {
  try {
    return res.json(await businessProfileLocal.buildDashboard(req.localResolved, req.query || {}));
  } catch (error) {
    return sendError(res, error, 'local_dashboard_failed');
  }
});

router.get('/clinica/:clinicaId/overview', async (req, res) => {
  try {
    return res.json(await businessProfileLocal.buildOverview(
      req.localResolved,
      req.query.startDate,
      req.query.endDate
    ));
  } catch (error) {
    return sendError(res, error, 'local_overview_failed');
  }
});

router.get('/clinica/:clinicaId/timeseries', async (req, res) => {
  try {
    return res.json(await businessProfileLocal.buildTimeseries(
      req.localResolved,
      req.query.metric || 'profile_views',
      req.query.startDate,
      req.query.endDate
    ));
  } catch (error) {
    return sendError(res, error, 'local_timeseries_failed');
  }
});

router.get('/clinica/:clinicaId/seasonality', async (req, res) => {
  try {
    return res.json(await businessProfileLocal.buildSeasonality(
      req.localResolved,
      req.query.months
    ));
  } catch (error) {
    return sendError(res, error, 'local_seasonality_failed');
  }
});

router.get('/clinica/:clinicaId/reviews', async (req, res) => {
  try {
    return res.json(await businessProfileLocal.listReviews(req.localResolved, req.query || {}));
  } catch (error) {
    return sendError(res, error, 'local_reviews_failed');
  }
});

router.get('/clinica/:clinicaId/posts', async (req, res) => {
  try {
    return res.json(await businessProfileLocal.listPosts(req.localResolved, req.query || {}));
  } catch (error) {
    return sendError(res, error, 'local_posts_failed');
  }
});

router.get('/clinica/:clinicaId/content', async (req, res) => {
  try {
    return res.json(businessProfileLocal.buildContent(req.localResolved));
  } catch (error) {
    return sendError(res, error, 'local_content_failed');
  }
});

router.get('/clinica/:clinicaId/review-insights', async (req, res) => {
  try {
    return res.json(await businessProfileLocal.buildReviewInsights(req.localResolved));
  } catch (error) {
    return sendError(res, error, 'local_review_insights_failed');
  }
});

router.post(
  '/clinica/:clinicaId/import-hours',
  requireClinicMarketingClinicWriteAccess,
  async (req, res) => {
    try {
      return res.json(await businessProfileLocal.importRegularHoursToClinic(req.localResolved));
    } catch (error) {
      return sendError(res, error, 'business_profile_hours_import_failed');
    }
  }
);

router.get('/clinica/:clinicaId/import-hours/status', async (req, res) => {
  try {
    return res.json(await businessProfileLocal.getRegularHoursImportStatus(req.localResolved));
  } catch (error) {
    return sendError(res, error, 'business_profile_hours_import_status_failed');
  }
});

router.post(
  '/clinica/:clinicaId/photos',
  requireClinicBusinessProfileWriteAccess,
  async (req, res) => {
    try {
      return res.status(201).json(await businessProfileLocal.publishPhoto(
        req.localResolved,
        req.body || {}
      ));
    } catch (error) {
      return sendError(res, error, 'business_profile_photo_publish_failed');
    }
  }
);

router.put(
  '/clinica/:clinicaId/special-hours',
  requireClinicBusinessProfileWriteAccess,
  async (req, res) => {
    try {
      return res.json(await businessProfileLocal.updateSpecialHours(
        req.localResolved,
        req.body || {}
      ));
    } catch (error) {
      return sendError(res, error, 'business_profile_special_hours_update_failed');
    }
  }
);

router.get('/clinica/:clinicaId/special-hours/automations', async (req, res) => {
  try {
    return res.json({
      success: true,
      items: await googleSpecialHoursAutomation.listSchedules(req.localClinicId),
    });
  } catch (error) {
    return sendError(res, error, 'business_profile_special_hours_automations_failed');
  }
});

router.post(
  '/clinica/:clinicaId/special-hours/automations',
  requireClinicBusinessProfileWriteAccess,
  async (req, res) => {
    try {
      const item = await googleSpecialHoursAutomation.createSchedule({
        clinicId: req.localClinicId,
        payload: req.body || {},
        actor: {
          userId: req.userData?.userId,
          name: req.userData?.email,
          role: 'clinic',
        },
      });
      return res.status(201).json({ success: true, item });
    } catch (error) {
      return sendError(res, error, 'business_profile_special_hours_automation_create_failed');
    }
  }
);

router.patch(
  '/clinica/:clinicaId/special-hours/automations/:publicId',
  requireClinicBusinessProfileWriteAccess,
  async (req, res) => {
    try {
      const item = await googleSpecialHoursAutomation.setScheduleActive({
        clinicId: req.localClinicId,
        publicId: req.params.publicId,
        active: req.body?.active === true,
        actor: {
          userId: req.userData?.userId,
          name: req.userData?.email,
          role: 'clinic',
        },
      });
      return res.json({ success: true, item });
    } catch (error) {
      return sendError(res, error, 'business_profile_special_hours_automation_update_failed');
    }
  }
);

module.exports = router;
