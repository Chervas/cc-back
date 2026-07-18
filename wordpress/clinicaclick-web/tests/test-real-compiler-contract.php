<?php

require __DIR__ . '/bootstrap.php';

$input = stream_get_contents(STDIN);
$contract = json_decode((string) $input, true);
ccw_test_assert(is_array($contract), 'real compiler did not emit JSON');
$artifact = $contract['artifact'] ?? null;
$runtime = $contract['runtime'] ?? null;
ccw_test_assert(is_array($artifact) && is_array($runtime), 'real compiler contract is incomplete');

$GLOBALS['ccw_test_options'] = array();
update_option(CCW_Config::OPTION_INSTALLATION_ID, (string) $runtime['installation_id']);
update_option(CCW_Config::OPTION_API_BASE, 'https://api.example.test');
update_option(CCW_Config::OPTION_TOKEN, str_repeat('t', 48));

$manifest = CCW_Manifest::validate(
    $artifact['manifest'],
    (string) $artifact['artifact_hash'],
    $runtime
);
foreach ($manifest['files'] as $path => $metadata) {
    ccw_test_assert(array_key_exists($path, $artifact['files']), 'compiler omitted file body: ' . $path);
    $temporary = tempnam(sys_get_temp_dir(), 'ccw-real-');
    file_put_contents($temporary, (string) $artifact['files'][$path]);
    try {
        CCW_Manifest::inspect_file($path, $temporary, $metadata, $runtime, $manifest);
    } finally {
        @unlink($temporary);
    }
}

$html = (string) ($artifact['files']['index.html'] ?? '');
ccw_test_assert(substr_count($html, 'data-cc-native-intake="true"') === 1, 'native intake marker mismatch');
ccw_test_assert(substr_count($html, '<script src=') === 1, 'loader count mismatch');
ccw_test_assert(strpos($html, 'action="/_clinicaclick/intake"') !== false, 'same-origin intake action missing');
echo "ok - real Node compiler HTML/manifest is accepted by the PHP plugin inspector\n";
