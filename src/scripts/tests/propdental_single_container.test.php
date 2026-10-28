<?php

declare(strict_types=1);

// Offline fixtures only: never boot WordPress, connect to a database or send events.
define('ABSPATH', '/fixture/');
$admin = false;
$theme = 'ModMarketing - Propdental v2';
$filters = [];
function is_admin() { global $admin; return $admin; }
function get_stylesheet() { global $theme; return $theme; }
function add_filter($name, $callback) { global $filters; $filters[$name] = $callback; }
require __DIR__ . '/../../../scripts/wordpress/propdental-single-container.php';
function check($condition, $message) {
    if (!$condition) { throw new RuntimeException($message); }
}

$keepHeader = '<meta name="google-site-verification" content="fixture"><script>window.other = true;</script>';
$header = '<script src="https://www.googletagmanager.com/gtag/js?id=G-7STZKBPC9F"></script>'
    . "<script>gtag('config', 'G-7STZKBPC9F');</script>"
    . "<script>loadContainer('GTM-WKVGKK8');</script>" . $keepHeader;
$keepBody = '<a href="/pedir-hora/">Pide cita</a><script>window.other = true;</script>';
$body = '<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-WKVGKK8"></iframe></noscript>' . $keepBody;
check(pd_cc_single_container_header_option($header) === $keepHeader, 'Preserve verification and unrelated scripts');
check(pd_cc_single_container_body_option($body) === $keepBody, 'Preserve unrelated body content');
check($filters['googlesitekit_ads_tag_blocked'](false) === true, 'Only the redundant Site Kit emitter is blocked');

$footer = "document.addEventListener('wpcf7mailsent', function(){gtag('event', 'mm_formularios_enviados');});"
    . "gtag('event', 'mm_llamadas_realizadas');gtag('event', 'mm_whatsapp_enviado');"
    . "gtag('event', 'unrelated');";
foreach ([$footer, addslashes($footer)] as $stored) {
    $fixed = pd_cc_single_container_footer_option($stored);
    check(substr_count($fixed, 'send_to:') === 3, 'Each legacy event has exactly one destination');
    check(substr_count($fixed, 'G-7STZKBPC9F') === 3, 'Events go only to the existing GA4 property');
    check(strpos($fixed, 'config') === false, 'Never add another configuration or page view');
    check(pd_cc_single_container_footer_option($fixed) === $fixed, 'Routing filter is idempotent');
}
check(pd_cc_single_container_header_option(null) === null, 'Missing option preserved');
$admin = true;
check(pd_cc_single_container_header_option($header) === $header, 'Admin retains the original option');
check(pd_cc_single_container_footer_option($footer) === $footer, 'Admin retains the original inline events');
$admin = false;
$theme = 'another-theme';
check(pd_cc_single_container_body_option($body) === $body, 'Another theme is not altered');
check($filters['googlesitekit_ads_tag_blocked'](false) === false, 'Another theme retains Site Kit behavior');
check($filters['googlesitekit_ads_tag_blocked'](true) === true, 'Never reverse an existing Site Kit block');

echo "propdental_single_container.test.php OK\n";
