<?php
// Relay for the Czech traffic-info feed (JSDI, dopravniinfo.cz), which refuses requests
// from outside Czechia. The weekly closures update on GitHub reads it through here.
// Only the 14 region feeds can be fetched; nothing else.
$allowed = ['19','35','116','51','108','86','78','132','124','94','43','27','60','141'];
$r = isset($_GET['region']) ? $_GET['region'] : '';
if (!in_array($r, $allowed, true)) { http_response_code(400); exit('bad region'); }
$url = 'https://api.dopravniinfo.cz/RegionData.ashx?region=' . $r;
$body = false; $code = 0;
if (function_exists('curl_init')) {
  $c = curl_init($url);
  curl_setopt_array($c, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 90, CURLOPT_FOLLOWLOCATION => true,
    CURLOPT_USERAGENT => 'EuroVeloNav-by-NEXIS-Rail relay', CURLOPT_ENCODING => '']);
  $body = curl_exec($c); $code = curl_getinfo($c, CURLINFO_HTTP_CODE); curl_close($c);
} else {
  $body = @file_get_contents($url, false, stream_context_create(['http' => ['timeout' => 90, 'user_agent' => 'EuroVeloNav-by-NEXIS-Rail relay']]));
  $code = $body === false ? 502 : 200;
}
if ($body === false || $code >= 400) { http_response_code(502); exit('upstream ' . $code); }
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
echo $body;
