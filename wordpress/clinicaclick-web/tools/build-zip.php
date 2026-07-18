<?php

declare(strict_types=1);

$root = dirname(__DIR__);
$version = '2.0.0-alpha.4';
$output = $root . '/dist/clinicaclick-web-' . $version . '.zip';

$files = [
    'clinicaclick.php' => 'clinicaclick-web/clinicaclick.php',
    'uninstall.php' => 'clinicaclick-web/uninstall.php',
    'readme.txt' => 'clinicaclick-web/readme.txt',
    'README.md' => 'clinicaclick-web/README.md',
];

$includes = glob($root . '/includes/*.php') ?: [];
sort($includes, SORT_STRING);
foreach ($includes as $source) {
    $files[substr($source, strlen($root) + 1)] = 'clinicaclick-web/includes/' . basename($source);
}
if (is_file($root . '/config/installation.php') && !is_link($root . '/config/installation.php')) {
    $files['config/installation.php'] = 'clinicaclick-web/config/installation.php';
}
asort($files, SORT_STRING);

if (!is_dir(dirname($output)) && !mkdir(dirname($output), 0750, true)) {
    fwrite(STDERR, "Could not create dist directory\n");
    exit(1);
}
// Keep the distributable directory unambiguous: only the version declared by
// this builder may remain. Source archives are reproducible, so retaining old
// alpha packages only creates a risk of installing an obsolete contract.
foreach (glob($root . '/dist/clinicaclick-web-*.zip') ?: [] as $archive) {
    if ($archive === $output || !is_file($archive) || is_link($archive)) {
        continue;
    }
    if (!unlink($archive)) {
        fwrite(STDERR, "Could not remove obsolete archive: " . basename($archive) . "\n");
        exit(1);
    }
}
$local = '';
$central = '';
$offset = 0;
$dosTime = 0;
$dosDate = ((2026 - 1980) << 9) | (7 << 5) | 17;
foreach ($files as $relative => $archivePath) {
    $source = $root . '/' . $relative;
    if (!is_file($source) || is_link($source)) {
        fwrite(STDERR, "Missing or unsafe source: {$relative}\n");
        exit(1);
    }
    $body = file_get_contents($source);
    if (!is_string($body)) {
        fwrite(STDERR, "Could not read: {$relative}\n");
        exit(1);
    }
    $nameLength = strlen($archivePath);
    $size = strlen($body);
    $crc = (int) hexdec(hash('crc32b', $body));
    $localHeader = pack(
        'VvvvvvVVVvv',
        0x04034b50,
        20,
        0,
        0,
        $dosTime,
        $dosDate,
        $crc,
        $size,
        $size,
        $nameLength,
        0
    ) . $archivePath;
    $local .= $localHeader . $body;

    $central .= pack(
        'VvvvvvvVVVvvvvvVV',
        0x02014b50,
        0x0314,
        20,
        0,
        0,
        $dosTime,
        $dosDate,
        $crc,
        $size,
        $size,
        $nameLength,
        0,
        0,
        0,
        0,
        0100644 << 16,
        $offset
    ) . $archivePath;
    $offset += strlen($localHeader) + $size;
}

$count = count($files);
$end = pack(
    'VvvvvVVv',
    0x06054b50,
    0,
    0,
    $count,
    $count,
    strlen($central),
    strlen($local),
    0
);
$temporary = $output . '.tmp';
if (file_put_contents($temporary, $local . $central . $end, LOCK_EX) === false || !rename($temporary, $output)) {
    @unlink($temporary);
    @unlink($output);
    fwrite(STDERR, "Could not finalize deterministic zip\n");
    exit(1);
}

echo hash_file('sha256', $output) . "  {$output}\n";
