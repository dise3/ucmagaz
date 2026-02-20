#!/bin/bash
# Скрипт обновления сервера (запускать на VPS из корня проекта)
set -e

echo "🔄 Обновление UC Магазин..."
cd "$(dirname "$0")"

if [ -d .git ]; then
  git pull
fi

cd server
npm install
npx playwright install chromium --with-deps 2>/dev/null || true

cd ..
pm2 restart ucmagaz-server 2>/dev/null || pm2 start ecosystem.config.cjs

echo "✅ Готово. Статус:"
pm2 status
