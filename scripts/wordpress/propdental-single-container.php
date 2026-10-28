<?php
/**
 * Plugin Name: Propdental — single measurement container
 * Description: Published container WVTTNV35 owns GA4, Ads and the existing HubSpot tag. Rollback: remove this MU file first; guarded theme headers and original WPCode options restore previous loaders.
 * Version: 20261028.2
 */
if (!defined('ABSPATH')) { exit; }
function pd_cc_single_container_enabled() {
    return !is_admin() && get_stylesheet() === 'ModMarketing - Propdental v2';
}
function pd_cc_single_container_header_option($value) {
    if (!pd_cc_single_container_enabled() || !is_string($value)) { return $value; }
    return preg_replace_callback('~<script\b[^>]*>.*?</script>~is', function ($m) {
        return strpos($m[0], 'GTM-WKVGKK8') !== false || strpos($m[0], 'G-7STZKBPC9F') !== false ? '' : $m[0];
    }, $value);
}
function pd_cc_single_container_body_option($value) {
    if (!pd_cc_single_container_enabled() || !is_string($value)) { return $value; }
    return preg_replace_callback('~<noscript\b[^>]*>.*?</noscript>~is', function ($m) {
        return strpos($m[0], 'GTM-WKVGKK8') !== false ? '' : $m[0];
    }, $value);
}
add_filter('option_ihaf_insert_header', 'pd_cc_single_container_header_option');
add_filter('option_ihaf_insert_body', 'pd_cc_single_container_body_option');
// Keep Site Kit connected for reports; the same Ads ID is configured once by GTM.
add_filter('googlesitekit_ads_tag_blocked', function ($blocked) {
    return $blocked || pd_cc_single_container_enabled();
});

// Legacy inline events need an explicit destination after removing direct gtag config.
// Do not add another config/page_view or forward these events to unrelated Ads IDs.
function pd_cc_single_container_footer_option($value) {
    if (!pd_cc_single_container_enabled() || !is_string($value)) { return $value; }
    foreach (["'", "\\'"] as $quote) {
        foreach (['mm_formularios_enviados', 'mm_llamadas_realizadas', 'mm_whatsapp_enviado'] as $event) {
            $from = "gtag({$quote}event{$quote}, {$quote}{$event}{$quote});";
            $to = "gtag({$quote}event{$quote}, {$quote}{$event}{$quote}, {send_to: {$quote}G-7STZKBPC9F{$quote}});";
            $value = str_replace($from, $to, $value);
        }
    }
    return $value;
}
add_filter('option_ihaf_insert_footer', 'pd_cc_single_container_footer_option');
