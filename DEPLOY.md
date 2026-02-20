# Деплой UC Магазин

## Обзор

- **Сервер (API + бот + активатор)** — VPS (Node.js, PM2)
- **Клиент** — Firebase Hosting
- **БД** — Supabase (уже настроена)

---

## 1. Подготовка VPS

Рекомендуемые характеристики: **4 GB RAM, 2 vCPU, Ubuntu 22.04, 40 GB SSD**.

### Установка Node.js 20

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### Установка зависимостей Playwright (Chromium)

```bash
sudo apt-get update
sudo apt-get install -y libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 libpango-1.0-0 libcairo2
```

Playwright установит браузер при первом запуске: `npx playwright install chromium`

### PM2

```bash
sudo npm install -g pm2
```

---

## 2. Деплой сервера на VPS

### Клонирование и настройка

```bash
# Клонировать репозиторий (или скопировать файлы)
cd /opt  # или другой каталог
git clone <ваш-репо> ucmagaz
cd ucmagaz

# Установить зависимости
cd server
npm install

# Установить Chromium для Playwright
npx playwright install chromium
```

### Создание .env

```bash
cp .env.example .env
nano .env
```

Заполните все переменные. **Важно:**
- `BACKEND_URL` — публичный HTTPS URL сервера (домен или IP с SSL)
- `FRONTEND_URL` — URL клиента (Firebase: https://ucmagaz.web.app)
- Telegram webhook работает только по HTTPS

### Папка sessions

Папка `server/sessions/` хранит сессии Midasbuy (куки). При первом деплое она будет пустой — один раз выполните `npm run test:activate` для каждого аккаунта, чтобы создать сессии. **Не удаляйте** `sessions/` после этого.

### Запуск через PM2

```bash
# Из корня проекта
cd /opt/ucmagaz
pm2 start ecosystem.config.cjs

# Проверить статус
pm2 status
pm2 logs ucmagaz-server
```

### Автозапуск при перезагрузке

```bash
pm2 startup
pm2 save
```

---

## 3. Nginx (опционально, для HTTPS и прокси)

Если используете домен с SSL (Let's Encrypt):

```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Без домена можно использовать **Cloudflare Tunnel** или **ngrok** для HTTPS.

---

## 4. Установка Telegram Webhook

После запуска сервера и получения публичного URL:

```bash
cd server
npm run set-webhook
# Использует BACKEND_URL из .env

# Или указать URL явно:
npx ts-node set-webhook.ts https://your-domain.com
```

---

## 5. Деплой клиента (Firebase Hosting)

### Локально

```bash
cd client

# Указать URL бэкенда (подставляется при сборке)
echo "VITE_API_NGROK=https://your-backend-url.com" > .env
npm run build

# Деплой
npm run deploy
# или: firebase deploy --only hosting
```

Для Firebase нужен `firebase login` и проект, привязанный в `firebase.json`.

---

## 6. Чек-лист после деплоя

- [ ] Сервер запущен (`pm2 status`)
- [ ] Webhook установлен (`npm run set-webhook`)
- [ ] `BACKEND_URL` и `FRONTEND_URL` указаны верно
- [ ] В `client/.env` перед сборкой задан `VITE_API_NGROK` (URL бэкенда)
- [ ] Supabase миграции выполнены (`supabase_setup.sql`)
- [ ] При первом запуске — хотя бы один раз `npm run test:activate` по каждому аккаунту Midasbuy

---

## Обновление

```bash
cd /opt/ucmagaz
git pull
cd server
npm install
pm2 restart ucmagaz-server
```

---

## Полезные команды

```bash
# Логи
pm2 logs ucmagaz-server

# Перезапуск
pm2 restart ucmagaz-server

# Тест активатора
cd server && npm run test:activate

# Установка webhook
cd server && npm run set-webhook
```
