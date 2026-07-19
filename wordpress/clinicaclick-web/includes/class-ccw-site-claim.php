<?php

if (!defined('ABSPATH') && !defined('CCW_TESTING')) {
    exit;
}

final class CCW_Site_Claim
{
    const QUERY_VAR = 'ccw_site_claim';
    const PATH = '.well-known/clinicaclick-wordpress-claim';

    public function register()
    {
        add_filter('query_vars', array($this, 'query_vars'));
        add_action('init', array($this, 'rewrite_rules'));
        add_action('template_redirect', array($this, 'maybe_serve'), 0);
    }

    public function query_vars($vars)
    {
        $vars[] = self::QUERY_VAR;
        return $vars;
    }

    public function rewrite_rules()
    {
        add_rewrite_rule(
            '^' . preg_quote(self::PATH, '#') . '/?$',
            'index.php?' . self::QUERY_VAR . '=1',
            'top'
        );
    }

    /** @return array<string,string>|null */
    public static function claim_document()
    {
        if (!CCW_Config::site_claim_is_pending()) {
            return null;
        }
        $home = rtrim((string) home_url('/'), '/');
        $parts = parse_url($home);
        if (
            !is_array($parts)
            || strtolower((string) ($parts['scheme'] ?? '')) !== 'https'
            || empty($parts['host'])
            || isset($parts['user'])
            || isset($parts['pass'])
            || isset($parts['port'])
            || isset($parts['query'])
            || isset($parts['fragment'])
            || !empty($parts['path'])
        ) {
            return null;
        }
        return array(
            'installation_id' => CCW_Config::installation_id(),
            'claim_token_sha256' => CCW_Config::site_claim_digest(),
            'canonical_home_url' => $home,
        );
    }

    public function maybe_serve()
    {
        if ((string) get_query_var(self::QUERY_VAR, '') !== '1') {
            return;
        }
        $document = self::claim_document();
        if ($document === null || (function_exists('is_ssl') && !is_ssl())) {
            status_header(404);
            nocache_headers();
            exit;
        }
        $body = wp_json_encode($document, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if (!is_string($body) || strlen($body) > 2048) {
            status_header(404);
            nocache_headers();
            exit;
        }
        status_header(200);
        nocache_headers();
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store, max-age=0');
        header('X-Content-Type-Options: nosniff');
        echo $body;
        exit;
    }
}
