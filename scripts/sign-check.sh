#!/usr/bin/env bash
# Проверка, готов ли этот Mac к подписанной сборке: CODARY_SIGN=1 ./scripts/build-mac.sh arm64
# Нужны: платная программа Apple Developer ($99 в год), сертификат «Developer ID Application» в связке ключей и профиль notarytool с паролем приложения.
# Ничего не меняет и секретов не печатает.
set -uo pipefail
PROFILE=${CODARY_NOTARY_PROFILE:-codary-notary}
ok=1
say() { printf '%s\n' "$*"; }

say "1) Xcode и инструменты нотаризации"
if xcrun --find notarytool >/dev/null 2>&1 && xcrun --find stapler >/dev/null 2>&1; then say "   ✓ notarytool и stapler найдены ($(xcrun --find notarytool))"; else ok=0; say "   ✗ нет notarytool/stapler: установите Xcode или Command Line Tools (xcode-select --install)"; fi

say "2) Сертификат «Developer ID Application»"
ids=$(security find-identity -v -p codesigning 2>/dev/null | grep "Developer ID Application" || true)
if [ -n "$ids" ]; then say "$ids" | sed 's/^/   ✓ /'; else
  ok=0
  say "   ✗ не найден. Как получить: Xcode ▸ Settings ▸ Accounts ▸ ваш Apple ID ▸ Manage Certificates ▸ «+» ▸ Developer ID Application"
  say "     (нужна платная программа Apple Developer и роль Account Holder или Admin; бесплатный аккаунт даёт только «Apple Development», им нельзя подписать приложение для других)."
  other=$(security find-identity -v -p codesigning 2>/dev/null | grep -E "^\s+[0-9]+\)" | sed 's/^ */     найдено вместо него: /' || true)
  [ -n "$other" ] && say "$other"
fi

say "3) Профиль нотаризации «$PROFILE» в связке ключей"
if xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1; then say "   ✓ профиль работает (Apple принял вход)"; else
  ok=0
  say "   ✗ профиля нет или он не работает. Создать (пароль приложения вводится в запрос, в историю командной строки не попадает):"
  say "     xcrun notarytool store-credentials \"$PROFILE\" --apple-id <ваш Apple ID> --team-id <TEAM ID>"
  say "     Пароль приложения: appleid.apple.com ▸ Вход и безопасность ▸ Пароли приложений. Team ID: developer.apple.com ▸ Membership details."
fi

if [ "$ok" = 1 ]; then say; say "Всё готово: CODARY_SIGN=1 ./scripts/build-mac.sh arm64  (нотаризация добавляет 2–15 минут)"; exit 0; fi
say; say "Пока не готово — собирать с CODARY_SIGN=1 рано (обычная сборка без флага работает как раньше)."; exit 1
