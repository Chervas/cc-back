<?php

if (!defined('ABSPATH') && !defined('CCW_TESTING')) {
    exit;
}

final class CCW_Router
{
    const CONSENT_RUNTIME_VERSION = '3.4.7';
    const CONSENT_WAIT_FOR_UPDATE_MS = 1500;
    const CONSENT_OWNERSHIP_SAFETY_MS = 8000;

    /** @var CCW_Cache */
    private $cache;

    public function __construct(CCW_Cache $cache = null)
    {
        $this->cache = $cache ?: new CCW_Cache();
    }

    public function register()
    {
        add_action('init', array($this, 'rewrite_rules'));
        add_filter('query_vars', array($this, 'query_vars'));
        add_action('template_redirect', array($this, 'serve'), -1000);
        add_action('wp_head', array($this, 'measurement_tag'), -1000);
        add_filter('robots_txt', array($this, 'robots_txt'), 100, 2);
    }

    public function rewrite_rules()
    {
        add_rewrite_rule('^cita/?$', 'index.php?ccw_artifact_path=index.html', 'top');
        add_rewrite_rule('^cita/(.+?)/?$', 'index.php?ccw_artifact_path=$matches[1]', 'top');
    }

    public function query_vars($vars)
    {
        $vars[] = 'ccw_artifact_path';
        return $vars;
    }

    public function serve()
    {
        $requested = (string) get_query_var('ccw_artifact_path', '');
        if ($requested === '') {
            return;
        }
        $matched = null;
        try {
            $uri_path = (string) parse_url((string) ($_SERVER['REQUEST_URI'] ?? ''), PHP_URL_PATH);
            $matched = $this->cache->match_route(rawurldecode($uri_path));
            if ($matched !== null) {
                $path = $this->route_to_file($matched['relative_path']);
                $resolved = $this->cache->resolve_pointer($matched['pointer'], $path);
            } else {
                $path = $this->route_to_file($requested);
                $resolved = $this->cache->resolve($path);
            }
        } catch (CCW_Error $error) {
            $resolved = null;
        }
        if ($resolved === null) {
            $pointer = $matched !== null ? $matched['pointer'] : array();
            if ($matched === null) {
                try {
                    $pointer = $this->cache->pointer();
                } catch (CCW_Error $error) {
                    $pointer = array();
                }
            }
            status_header(($pointer['status'] ?? '') === 'retired' ? 410 : 404);
            header('Content-Type: text/plain; charset=utf-8');
            header('X-Content-Type-Options: nosniff');
            echo (($pointer['status'] ?? '') === 'retired') ? 'Esta página ya no está disponible.' : 'Página no encontrada.';
            exit;
        }

        $etag = '"sha256-' . hash_file('sha256', $resolved['path']) . '"';
        if (trim((string) ($_SERVER['HTTP_IF_NONE_MATCH'] ?? '')) === $etag) {
            status_header(304);
            header('ETag: ' . $etag);
            exit;
        }

        status_header(200);
        header('Content-Type: ' . $resolved['content_type']);
        header('Content-Length: ' . (string) filesize($resolved['path']));
        header('ETag: ' . $etag);
        header('X-Clinicaclick-Artifact: ' . $resolved['artifact_hash']);
        header('X-Content-Type-Options: nosniff');
        $extension = strtolower((string) pathinfo($resolved['path'], PATHINFO_EXTENSION));
        header($extension === 'html'
            ? 'Cache-Control: public, max-age=300, stale-if-error=86400'
            : 'Cache-Control: public, max-age=31536000, immutable');
        foreach ($resolved['headers'] as $name => $value) {
            $canonical_name = implode('-', array_map('ucfirst', explode('-', $name)));
            header($canonical_name . ': ' . $value, true);
        }
        if (strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET')) !== 'HEAD') {
            readfile($resolved['path']);
        }
        exit;
    }

    public function measurement_tag()
    {
        try {
            CCW_Config::assert_cache_storage_safe();
        } catch (CCW_Error $error) {
            return;
        }
        // During migration the legacy measurement plugin remains the single
        // owner of global tracking. The new publisher can still serve and
        // measure its signed /cita/ artifact, which embeds its own loader,
        // without bootstrapping a second loader on the existing WordPress
        // pages. Deactivating the legacy plugin hands ownership to this
        // plugin automatically on the next request.
        if ($this->legacy_measurement_plugin_active()) {
            return;
        }
        $runtime = CCW_Config::runtime_configuration();
        $measurement = is_array($runtime['measurement'] ?? null) ? $runtime['measurement'] : array();
        if (empty($measurement['enabled']) || !CCW_Config::is_configured()) {
            return;
        }
        $scope_type = (string) ($measurement['scope_type'] ?? '');
        $scope_id = (int) ($measurement['scope_id'] ?? 0);
        if (!in_array($scope_type, array('clinic', 'group'), true) || $scope_id < 1) {
            return;
        }
        $origin = CCW_Config::api_base();
        $src = $origin . '/assets/loader.js';
        $scope_attribute = $scope_type === 'clinic' ? 'data-clinic-id' : 'data-group-id';
        $consent_enabled = !empty($measurement['consent_mode_enabled']);
        $provider = in_array((string) ($measurement['consent_provider'] ?? ''), array('clinicaclick', 'external_cmp'), true)
            ? (string) $measurement['consent_provider']
            : 'external_cmp';
        $attributes = array(
            'src' => $src,
            $scope_attribute => (string) $scope_id,
            'data-api-url' => $origin,
            'data-event-bridge-url' => CCW_Intake_Bridge::EVENT_ENDPOINT_PATH,
            'data-consent-mode-enabled' => $consent_enabled ? 'true' : 'false',
            'data-consent-provider' => $provider,
        );
        $rendered = array();
        foreach ($attributes as $name => $value) {
            $rendered[] = esc_attr($name) . '="' . esc_attr($value) . '"';
        }
        // Only public browser configuration is rendered. The IntakeConfig
        // HMAC remains server-side for the same-origin bridge.
        if ($consent_enabled) {
            echo $this->consent_bootstrap($provider) . "\n";
        }
        echo '<script ' . implode(' ', $rendered) . ' async></script>' . "\n";
    }

    public function legacy_measurement_plugin_active()
    {
        $active = (array) get_option('active_plugins', array());
        if (function_exists('get_site_option')) {
            $network = (array) get_site_option('active_sitewide_plugins', array());
            $active = array_merge($active, array_keys($network));
        }
        foreach ($active as $plugin) {
            $normalized = strtolower(str_replace('\\', '/', trim((string) $plugin)));
            if ($normalized === 'clinicaclick/clinicaclick.php') {
                return true;
            }
        }
        return false;
    }

    private function consent_bootstrap($provider)
    {
        $version = self::CONSENT_RUNTIME_VERSION;
        $wait = (int) self::CONSENT_WAIT_FOR_UPDATE_MS;
        $provider_attribute = esc_attr($provider);
        $common = <<<'JS'
(function(w,d){
var dl=w.dataLayer=w.dataLayer||[],bootstrap=w.ClinicaClickConsentBootstrap=w.ClinicaClickConsentBootstrap||{},previous=null,keys=['ad_storage','analytics_storage','ad_user_data','ad_personalization','functionality_storage','security_storage','personalization_storage'];
if(!bootstrap.previousGoogleConsentCaptured){
for(var i=0;i<dl.length;i++){var entry=dl[i],value=entry&&entry[2];if(!entry||entry[0]!=='consent'||(entry[1]!=='default'&&entry[1]!=='update')||!value||typeof value!=='object')continue;previous=previous||{};for(var j=0;j<keys.length;j++)if(value[keys[j]]==='granted'||value[keys[j]]==='denied')previous[keys[j]]=value[keys[j]];}
bootstrap.previousGoogleConsent=previous;bootstrap.previousGoogleConsentCaptured=true;
}
w.gtag=w.gtag||function(){dl.push(arguments);};
if(!bootstrap.defaultDeniedApplied){
var denied={ad_storage:'denied',analytics_storage:'denied',ad_user_data:'denied',ad_personalization:'denied',functionality_storage:'granted',security_storage:'granted',personalization_storage:'denied'};
var initial={};for(var key in denied)if(Object.prototype.hasOwnProperty.call(denied,key))initial[key]=denied[key];initial.wait_for_update=__WAIT__;
w.gtag('consent','default',initial);w.gtag('set','ads_data_redaction',true);bootstrap.defaultDeniedApplied=true;
}
bootstrap.lastSource='wordpress_inline';bootstrap.released=false;
JS;
        $common = str_replace('__WAIT__', (string) $wait, $common);
        $ownership = '';
        if ($provider === 'clinicaclick') {
            $safety = (int) self::CONSENT_OWNERSHIP_SAFETY_MS;
            $ownership = <<<'JS'
bootstrap.releaseOwnership=bootstrap.releaseOwnership||function(){if(bootstrap.ownershipSafetyTimer){w.clearTimeout(bootstrap.ownershipSafetyTimer);bootstrap.ownershipSafetyTimer=null;}try{if(d.documentElement&&d.documentElement.classList)d.documentElement.classList.remove('cc-consent-bootstrap-owned');}catch(e){}bootstrap.ownsConsentUi=false;};
if(bootstrap.ownershipSafetyTimer){w.clearTimeout(bootstrap.ownershipSafetyTimer);bootstrap.ownershipSafetyTimer=null;}
try{var root=d.documentElement;if(root&&root.classList)root.classList.add('cc-consent-bootstrap-owned');if(!d.getElementById('cc-consent-bootstrap-style')){var style=d.createElement('style');style.id='cc-consent-bootstrap-style';style.textContent='html.cc-consent-bootstrap-owned #cmplz-cookiebanner-container,html.cc-consent-bootstrap-owned .cmplz-cookiebanner,html.cc-consent-bootstrap-owned .cmplz-manage-consent{display:none!important;visibility:hidden!important;pointer-events:none!important}';(d.head||root).appendChild(style);}bootstrap.ownsConsentUi=true;bootstrap.ownershipSafetyTimer=w.setTimeout(function(){bootstrap.releaseOwnership();},__SAFETY__);}catch(e){bootstrap.releaseOwnership();}
JS;
            $ownership = str_replace('__SAFETY__', (string) $safety, $ownership);
        }
        return '<script data-clinicaclick-consent-bootstrap="' . esc_attr($version)
            . '" data-consent-provider="' . $provider_attribute . '">' . "\n"
            . $common . $ownership . "\n})(window,document);\n</script>";
    }

    public function robots_txt($output, $public)
    {
        try {
            $registry = $this->cache->route_registry();
            if (empty($registry['routes'])) {
                if ($this->cache->resolve('sitemap.xml') === null) return $output;
                $registry['routes']['legacy'] = array('publication_id' => 'legacy', 'route_prefix' => '/cita/');
            }
            foreach ($registry['routes'] as $publication_id => $entry) {
                $pointer = $publication_id === 'legacy'
                    ? $this->cache->pointer()
                    : $this->cache->route_pointer($publication_id, (string) ($entry['route_prefix'] ?? ''));
                if ($this->cache->resolve_pointer($pointer, 'sitemap.xml') === null) continue;
                $line = 'Sitemap: ' . home_url(rtrim((string) $entry['route_prefix'], '/') . '/sitemap.xml');
                if (strpos((string) $output, $line) === false) {
                    $output = rtrim((string) $output) . "\n" . $line . "\n";
                }
            }
        } catch (CCW_Error $error) {
            return $output;
        }
        return $output;
    }

    public function route_to_file($requested)
    {
        $requested = trim(rawurldecode((string) $requested), '/');
        if ($requested === '' || $requested === 'index.html') {
            return 'index.html';
        }
        if (preg_match('/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/', $requested)) {
            return $requested . '/index.html';
        }
        return CCW_Manifest::safe_path($requested);
    }
}
