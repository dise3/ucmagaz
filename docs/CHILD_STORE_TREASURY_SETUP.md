# Памятка: настройка казны в ДОЧЕРНЕМ магазине

> **Для AI-агента.** Репозиторий **главного** магазина (`ucmagaz`) уже обновлён.  
> Эту инструкцию выполнять в **отдельном** репозитории/проекте **дочернего** магазина (свой Supabase, свой `server.ts`, свой Telegram-бот).

---

## Роль магазинов

| Магазин | База | Что делает |
|---------|------|------------|
| **Главный** (ucmagaz) | Supabase главного | Принимает заявки на вывод (`wdone_`), выставляет **курс** для дочернего, переводит крипту |
| **Дочерний** | Supabase дочернего | Копит ₽ после **своих** оплат, конвертирует в USDT по курсу с главного, запрашивает вывод |

**Не смешивать таблицы.** Ручное «зачислить ₽ с главного» (`/api/treasury/credit`) в обычном потоке **не нужно**.

---

## 1. Переменные `.env` дочернего сервера

```env
# Куда слать заявки на вывод (Telegram главного бота)
MAIN_STORE_ADMIN_CHAT_IDS=123456789,987654321
MAIN_STORE_BOT_TOKEN=...   # опционально, если шлёте через API главного бота с дочернего

# Секрет для запросов С ГЛАВНОГО (тот же, что TREASURY_API_SECRET у главного)
TREASURY_API_SECRET=длинный_общий_секрет
```

На **главном** уже должно быть:

```env
CHILD_STORE_API_URL=https://api-дочернего-магазина.ru
TREASURY_API_SECRET=тот_же_секрет
```

---

## 2. База данных (Supabase дочернего)

Выполнить SQL из файла (скопировать в дочерний проект):

**`docs/supabase_treasury_child.sql`** (в главном репо: `/docs/supabase_treasury_child.sql`)

Таблицы:

- `child_treasury` — `balance_usdt`, `usdt_rate_rub`
- `child_daily_rub_ledger` — ₽ по дням (МСК), `converted_at`
- `child_treasury_order_log` — защита от двойного учёта заказа
- `withdrawal_requests` — заявки на вывод

Удалить из обычного потока зависимость от `shop_balance` + ручного `credit`, если они были только для старой схемы.

---

## 3. Модуль `server/treasury_child.ts` (создать на дочернем)

Скопировать логику по образцу `treasury_main.ts` **главного**, но:

- таблицы с префиксом `child_*`;
- функции: `recordChildOrderRevenue`, `getChildTreasurySummary`, `convertChildRubToUsdt`, `createWithdrawalRequest`, `completeWithdrawalRequest`;
- `getMskDayKey` / `getTodayMskKey` — как на главном (UTC+3).

### 3.1 После оплаты — автоматически ₽ в журнал

В **`POST /api/payment-callback`**, сразу после `status: 'paid'` и получения `order`:

```typescript
try {
  await recordChildOrderRevenue(supabase, order.id, Number(order.price_rub) || 0, order.created_at);
} catch (e) {
  console.error('[treasury_child] recordChildOrderRevenue', e);
}
```

Сегодняшний день (МСК) только копится в `child_daily_rub_ledger`, **не** в `balance_usdt`.

### 3.2 Конвертация (вызывает только главный)

`POST /api/treasury/convert`  
Заголовок: `x-treasury-secret: <TREASURY_API_SECRET>`  
Body: `{ "rate": 95 }` — рублей за 1 USDT.

Логика:

1. Взять все строки `child_daily_rub_ledger` где `converted_at IS NULL` и `day_date < сегодня (МСК)`.
2. `totalRub = sum(rub_total)`, `usdtAdded = totalRub / rate`.
3. `child_treasury.balance_usdt += usdtAdded`, `usdt_rate_rub = rate`.
4. Пометить эти дни `converted_at = now()`.
5. Ответ JSON:

```json
{
  "ok": true,
  "totalRub": 45000,
  "usdtAdded": 473.68,
  "rate": 95,
  "newBalanceUsdt": 1200.5
}
```

Если админ главного не ставил курс несколько дней — при следующем вызове закрываются **все** накопленные прошлые дни одним курсом.

### 3.3 Сводка (для кнопки главного «Курс для дочернего»)

`GET /api/treasury/summary`  
Тот же заголовок секрета.

Ответ JSON (поля обязательны, имена как ниже):

```json
{
  "balanceUsdt": 1200.5,
  "lastRate": 95,
  "todayRub": 12000,
  "todayMsk": "2026-06-04",
  "unconvertedRub": 45000,
  "unconvertedDays": [
    { "day_date": "2026-06-02", "rub_total": 20000 },
    { "day_date": "2026-06-03", "rub_total": 25000 }
  ]
}
```

### 3.4 Завершение вывода (главный жмёт «Выполнено»)

`POST /api/treasury/withdrawal/complete`  
Body: `{ "requestId": 5 }`  
Секрет в заголовке.

- Проверить `withdrawal_requests.id = requestId`, `status = 'pending'`.
- `status = 'completed'`, `completed_at = now()`.
- `child_treasury.balance_usdt -= amount_usdt` (не уходить в минус).
- Уведомить админа **дочернего** в Telegram.
- `{ "ok": true }`.

### 3.5 Middleware секрета

На все `/api/treasury/*` (кроме публичных):

```typescript
if (req.headers['x-treasury-secret'] !== process.env.TREASURY_API_SECRET) {
  return res.status(403).json({ ok: false, error: 'Forbidden' });
}
```

**Не реализовывать** `/api/treasury/credit` в продакшене (устарело).

---

## 4. Telegram-бот дочернего

### Показ баланса (админ)

Текст из `getChildTreasurySummary` локально:

- Сегодня: X₽ (ещё не по курсу)
- К конвертации: список дней + итого ₽
- **К выводу: Z USDT** (`balance_usdt`)

### Кнопка «Вывести средства»

1. Админ вводит сумму **USDT** (≤ `balance_usdt`) и реквизиты (Binance UID и т.д.).
2. `INSERT withdrawal_requests (amount_usdt, payout_details, status='pending')`.
3. Отправить сообщение в чат(ы) **`MAIN_STORE_ADMIN_CHAT_IDS`** главного бота:

```
🏪 Заявка на вывод #5 (дочерний)

💵 500 USDT
📋 Binance: ...

[Выполнено] → callback_data: wdone_5
```

4. Списать USDT с `balance_usdt` **не** при создании заявки — только при `complete` с главного (или резервировать отдельным полем `reserved_usdt` — на выбор, но главный уже шлёт complete).

Рекомендация: при создании заявки уменьшать `balance_usdt` или ставить `reserved` — иначе двойная заявка на один баланс. Минимум: проверка `amount_usdt <= balance_usdt` при создании и `balance_usdt -= amount` сразу, при отмене — возврат.

### После `complete` с главного

Дочерний бот пишет админу: «Вывод #5 выполнен».

---

## 5. Что уже сделано на ГЛАВНОМ (не дублировать)

Файлы главного репозитория:

- `server/treasury_main.ts` — `getChildTreasurySummary`, `convertChildRubToUsdt`, `completeChildWithdrawal`
- `server/server.ts`:
  - кнопка **«💱 Курс для дочернего»** (`adm_child_convert`);
  - ввод курса → `POST` convert на дочерний;
  - **`wdone_{id}`** → `withdrawal/complete`;
  - **`recordOrderRevenue`** только для заказов **главного** магазина в `payment-callback`.

Кнопка «Зачислить ₽ дочернему» **удалена**.

---

## 6. Проверка end-to-end

1. Оплата заказа на **дочернем** → в `child_daily_rub_ledger` +₽ за сегодня.
2. На **главном**: админ → «Курс для дочернего» → курс 95 → успех, USDT на дочернем вырос.
3. На **дочернем**: бот показывает USDT к выводу; заявка уходит в главный чат с `wdone_N`.
4. На **главном**: «Выполнено» → дочерний API `complete` → статус completed, баланс уменьшился.

---

## 7. Частые ошибки

| Симптом | Причина |
|---------|---------|
| «CHILD_STORE_API_URL не задан» | `.env` на главном |
| **404 при вводе курса** | на **дочернем** нет `POST /api/treasury/convert` или неверный `CHILD_STORE_API_URL` (см. §7.1) |
| 403 на treasury API | разные `TREASURY_API_SECRET` |
| «Нет ₽ за прошлые дни» | все продажи сегодня или не вызывается `recordChildOrderRevenue` |
| Главный не видит кнопку wdone | заявка не отправлена в `ADMIN_CHAT_ID` главного |

### 7.1 Ошибка 404 «Request failed with status code 404»

Главный при вводе курса вызывает:

```http
POST {CHILD_STORE_API_URL}/api/treasury/convert
Header: x-treasury-secret: ...
Body: { "rate": 95 }
```

**404 = дочерний сервер ответил «маршрут не найден».**

Проверка с машины, где крутится главный (подставьте URL и секрет):

```bash
# 1) Сводка (открывается кнопкой «Курс для дочернего»)
curl -s -H "x-treasury-secret: ВАШ_СЕКРЕТ" \
  "https://API-ДОЧЕРНЕГО/api/treasury/summary"

# 2) Конвертация (именно здесь обычно 404)
curl -s -X POST -H "Content-Type: application/json" \
  -H "x-treasury-secret: ВАШ_СЕКРЕТ" \
  -d '{"rate":95}' \
  "https://API-ДОЧЕРНЕГО/api/treasury/convert"
```

| Результат curl | Что делать |
|----------------|------------|
| summary 404 | добавить оба роута на дочерний `server.ts` |
| summary 200, convert 404 | добавить только `POST /api/treasury/convert` |
| оба 403 | выровнять `TREASURY_API_SECRET` |
| оба 200 | перезапустить **главный** pm2 после правки `.env` |

**Частая ошибка в `.env` главного:**

```env
# ❌ лишний /api — получится .../api/api/treasury/convert → 404
CHILD_STORE_API_URL=https://shop.ru/api

# ✅ только origin сервера дочернего
CHILD_STORE_API_URL=https://shop.ru
```

После добавления роутов: `pm2 restart` (или аналог) **дочернего** сервера.

Готовый блок роутов: `docs/treasury_child.routes.snippet.ts`

---

## 8. Файлы для копирования в дочерний репо

| Из главного репо | Куда на дочернем |
|------------------|------------------|
| `docs/supabase_treasury_child.sql` | выполнить в Supabase |
| `docs/treasury_child.reference.ts` | → `server/treasury_child.ts` (готовая логика) |
| `docs/CHILD_STORE_TREASURY_SETUP.md` | эта памятка |

### Роуты в `server.ts` дочернего (добавить)

```typescript
import {
  recordChildOrderRevenue,
  getChildTreasurySummary,
  convertChildRubToUsdt,
  completeWithdrawalRequest,
} from './treasury_child.ts';

function treasuryAuth(req, res, next) {
  if (req.headers['x-treasury-secret'] !== process.env.TREASURY_API_SECRET) {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }
  next();
}

app.get('/api/treasury/summary', treasuryAuth, async (_req, res) => {
  const s = await getChildTreasurySummary(supabase);
  res.json(s);
});

app.post('/api/treasury/convert', treasuryAuth, async (req, res) => {
  const rate = Number(req.body?.rate);
  const result = await convertChildRubToUsdt(supabase, rate);
  res.json(result);
});

app.post('/api/treasury/withdrawal/complete', treasuryAuth, async (req, res) => {
  const requestId = Number(req.body?.requestId);
  const result = await completeWithdrawalRequest(supabase, requestId);
  res.json(result);
});
```

Готово, когда все 3 endpoint'а дочернего отвечают 200 и сценарий из §6 проходит.
