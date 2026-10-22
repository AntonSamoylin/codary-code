<?php
// Вход в облачную среду Codary Code (ЧЕРНОВИК, на сайт не выложен): проверяет, что клиент вошёл и допущен,
// и перенаправляет на сервер облачных сред с одноразовым подписанным токеном. Настройки — .config/cloud.php:
//   return ['url' => 'https://cloud.codary.ru', 'secret' => '<тот же CC_SECRET, что у менеджера>', 'public' => false, 'allow' => [3]];
require_once __DIR__ . '/site-layout.php';
$client = sl_client();
if (!$client) { header('Location: /lk.php?from=code-cloud'); exit; }
$cfgFile = __DIR__ . '/.config/cloud.php';
$cfg = is_file($cfgFile) ? (require $cfgFile) : [];
$ok = !empty($cfg['url']) && !empty($cfg['secret'])
    && (!empty($cfg['public']) || !empty($client['is_admin']) || in_array((int)$client['id'], array_map('intval', $cfg['allow'] ?? []), true));
if (!$ok) { http_response_code(403); echo 'Облачная среда пока доступна по приглашению. Запишитесь на странице Codary Code.'; exit; }
$b64 = fn(string $s) => rtrim(strtr(base64_encode($s), '+/', '-_'), '=');
$body = $b64(json_encode(['uid' => (string)(int)$client['id'], 'exp' => time() + 120, 'n' => bin2hex(random_bytes(8))], JSON_UNESCAPED_SLASHES));
$sig = $b64(hash_hmac('sha256', $body, $cfg['secret'], true));
header('Cache-Control: no-store');
header('Location: ' . rtrim($cfg['url'], '/') . '/enter?t=' . $body . '.' . $sig);
