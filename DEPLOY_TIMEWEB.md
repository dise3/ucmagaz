# Деплой UC Магазин на Timeweb Cloud

Пошаговая инструкция: VPS → домен → SSL → фронт и бэк на одном адресе.

---

## Шаг 1. Создание VPS в Timeweb

1. Войдите на [cloud.timeweb.com](https://cloud.timeweb.com)
2. **Облачные серверы** → **Создать сервер**
3. Настройки:
   - **ОС:** Ubuntu 22.04
   - **Конфигурация:** 4 GB RAM, 2 vCPU (например, тариф «Оптимальный» ~500–800 ₽/мес)
   - **Регион:** Москва или Амстердам
   - **Сеть:** включить внешний IP
4. Нажмите **Создать сервер**
5. Запомните **IP-адрес** и пароль root (придёт на email)

---

## Шаг 2. Покупка домена

1. На [timeweb.com](https://timeweb.com) → **Домены** → **Зарегистрировать домен**
2. Введите нужное имя (например, `ucmagaz.ru`)
3. Оформите заказ
4. В панели Timeweb Cloud: **Сеть** → **Доменные имена** → привяжите домен к проекту (если нужно)

---

## Шаг 3. DNS: привязка домена к VPS

1. **Панель хостинга Timeweb** → **Домены** → выберите свой домен
2. Раздел **Управление DNS** / **DNS-записи**
3. Добавьте A-записи:

| Тип | Имя | Значение    | TTL |
|-----|-----|-------------|-----|
| A   | @   | IP вашего VPS | 3600 |
| A   | www | IP вашего VPS | 3600 |

4. Подождите 5–30 минут на обновление DNS

---

## Шаг 4. Подключение к серверу по SSH

```bash
ssh root@ВАШ_IP
```

Введите пароль из письма. При первом входе может потребоваться сменить пароль.

---

## Шаг 5. Установка ПО на сервере

### Обновление системы

```bash
apt update && apt upgrade -y
```

### Node.js 20

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
node -v   # должно быть v20.x
```

### Зависимости для Playwright (Chromium)

```bash
apt install -y libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 libpango-1.0-0 libcairo2
```

### PM2

```bash
npm install -g pm2
```

### Nginx

```bash
apt install -y nginx
```

### Certbot (для SSL)

```bash
apt install -y certbot python3-certbot-nginx
```

---

## Шаг 6. Загрузка проекта на сервер

### Вариант А: через Git

```bash
cd /var/www
git clone https://github.com/ВАШ_ЛОГИН/ucmagaz.git
cd ucmagaz
```

### Вариант Б: через SCP (с вашего компьютера)

На **локальной машине**:

```bash
cd /путь/к/проекту
scp -r . root@ВАШ_IP:/var/www/ucmagaz/
```

На **сервере**:

```bash
mkdir -p /var/www/ucmagaz
# После выполнения scp — файлы появятся в /var/www/ucmagaz
```

### Важно: файл start.jpg

Если используется приветственное фото бота, положите `start.jpg` в `client/public/`:

```bash
# На сервере
ls /var/www/ucmagaz/client/public/start.jpg   # должен существовать
```

---

## Шаг 7. Настройка бэкенда

```bash
cd /var/www/ucmagaz/server

# Установка зависимостей
npm install

# Chromium для Playwright
npx playwright install chromium

# .env
cp .env.example .env
nano .env
```

В `.env` укажите:

```
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_KEY=ваш_ключ
CODEEPAY_API_KEY=ваш_ключ
PORT=8080
FRONTEND_URL=https://ваш-домен.ru
BACKEND_URL=https://ваш-домен.ru
BOT_TOKEN=токен_бота
ADMIN_CHAT_ID=ваш_chat_id
```

Сохраните: `Ctrl+O`, `Enter`, `Ctrl+X`.

---

## Шаг 8. Сборка фронтенда

```bash
cd /var/www/ucmagaz/client

# Фронт и бэк на одном домене — API по относительным путям (/api/...)
echo 'VITE_API_NGROK=' > .env

# Либо явно укажите полный URL:
# echo 'VITE_API_NGROK=https://ваш-домен.ru' > .env

npm install
npm run build
```

При пустом `VITE_API_NGROK` запросы идут на тот же домен (`/api/...`). При одном домене это корректно.

---

## Шаг 9. Настройка Nginx

```bash
nano /etc/nginx/sites-available/ucmagaz
```

Вставьте (замените `ваш-домен.ru` на ваш домен):

```nginx
server {
    listen 80;
    server_name ваш-домен.ru www.ваш-домен.ru;

    # API → Node.js на порту 8080
    location /api {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Webhook бота
    location /api/bot-webhook {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Статика фронтенда
    root /var/www/ucmagaz/client/dist;
    index index.html;
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

Активируйте конфиг:

```bash
ln -sf /etc/nginx/sites-available/ucmagaz /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx
```

---

## Шаг 10. SSL (Let's Encrypt)

```bash
certbot --nginx -d ваш-домен.ru -d www.ваш-домен.ru
```

Следуйте подсказкам (email, согласие). Certbot обновит nginx и добавит HTTPS.

Проверка автопродления:

```bash
certbot renew --dry-run
```

---

## Шаг 11. Запуск бэкенда (PM2)

```bash
cd /var/www/ucmagaz
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
# Выполните команду, которую выведет pm2 startup
```

Проверка:

```bash
pm2 status
pm2 logs ucmagaz-server
```

---

## Шаг 12. Установка Telegram Webhook

```bash
cd /var/www/ucmagaz/server
npm run set-webhook
```

Или явно:

```bash
npx ts-node set-webhook.ts https://ваш-домен.ru
```

---

## Шаг 13. Сессии Midasbuy (при первом деплое)

```bash
cd /var/www/ucmagaz/server
npm run test:activate
# Введите email аккаунта Midasbuy при запросе
```

Сделайте это для каждого аккаунта, который будет использоваться. Сессии сохранятся в `server/sessions/`.

---

## Чек-лист

- [ ] VPS создан, домен куплен
- [ ] DNS настроен (A-записи на IP)
- [ ] Node.js, PM2, nginx, certbot установлены
- [ ] Проект загружен в `/var/www/ucmagaz`
- [ ] `server/.env` заполнен
- [ ] `client` собран (`npm run build`)
- [ ] `client/public/start.jpg` есть (если нужен)
- [ ] Nginx настроен и перезапущен
- [ ] SSL получен (certbot)
- [ ] PM2 запущен, `pm2 save` и `pm2 startup`
- [ ] Webhook установлен
- [ ] Для каждого Midasbuy-аккаунта выполнен `test:activate`

---

## Полезные команды

```bash
# Логи бэкенда
pm2 logs ucmagaz-server

# Перезапуск
pm2 restart ucmagaz-server

# Обновление проекта
cd /var/www/ucmagaz
git pull   # или загрузить файлы через scp
cd server && npm install
cd ../client && npm run build
pm2 restart ucmagaz-server
```

---

## Если фронт и бэк на разных доменах

Если клиент (например, на Firebase) и API на разных адресах, перед сборкой задайте полный URL API:

```bash
cd /var/www/ucmagaz/client
echo "VITE_API_NGROK=https://api.ваш-домен.ru" > .env
npm run build
```

CORS в `server/server.ts` уже настроен (`origin: '*'`).
