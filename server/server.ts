import dotenv from 'dotenv';
dotenv.config();
console.log('dotenv loaded');
import { v4 as uuidv4 } from 'uuid';
import { nsClient } from './ns_service.ts';
import express from 'express';
import { activateSingleCode } from './activator.ts';
import axios from 'axios';
import FormData from 'form-data';
import cors from 'cors';
import { fulfillOrder } from './bot_manager.ts';
import {
    recordOrderRevenue,
    getChildTreasurySummary,
    formatChildTreasuryMessage,
    convertChildRubToUsdt,
    completeChildWithdrawal,
    formatRub,
} from './treasury_main.ts';
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const START_IMAGE_PATH = join(__dirname, '..', 'client', 'public', 'start.jpg');

const PORT = process.env.PORT || 8080;
const app = express();

// --- НАСТРОЙКИ MIDDLEWARE ---
app.use(cors({ origin: '*' }));
app.use(express.json());

// Раздача статики из client/dist
app.use(express.static(join(__dirname, '..', 'client', 'dist')));

// --- ИНИЦИАЛИЗАЦИЯ SUPABASE ---
const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_KEY!
);

const BOT_TOKEN = process.env.BOT_TOKEN;
console.log('process.env.ADMIN_CHAT_ID:', process.env.ADMIN_CHAT_ID);
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID ? process.env.ADMIN_CHAT_ID.split(',').map(id => id.trim()) : [];
console.log('ADMIN_CHAT_ID loaded:', ADMIN_CHAT_ID);
const BACKEND_URL = process.env.BACKEND_URL;

const automationTimers = new Map<number, NodeJS.Timeout>();

// Состояния админов для кнопочного ввода (chatId -> { action, extra? })
type AdminState = {
    action: string;
    uc?: number;
    title?: string;
    price?: number;
    message?: string;
    serviceId?: number;
};
const adminStates = new Map<string, AdminState>();

// --- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ TELEGRAM ---

const sendTg = async (chatId: string | number | string[], text: string, replyMarkup?: any) => {
    if (Array.isArray(chatId)) {
        for (const id of chatId) {
            await sendTg(id, text, replyMarkup);
        }
        return;
    }
    try {
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: chatId,
            text: text,
            parse_mode: 'HTML',
            reply_markup: replyMarkup
        });
    } catch (e: any) {
        console.error('❌ Ошибка отправки TG:', e.response?.data || e.message);
    }
};

const sendLocalPhoto = async (chatId: string | number | string[], photoPath: string, caption?: string, replyMarkup?: any) => {
    if (Array.isArray(chatId)) {
        for (const id of chatId) {
            await sendLocalPhoto(id, photoPath, caption, replyMarkup);
        }
        return;
    }
    try {
        const photoBuffer = fs.readFileSync(photoPath);

        const formData = new FormData();
        formData.append('chat_id', chatId.toString());
        formData.append('photo', photoBuffer, 'start.jpg');
        if (caption) {
            formData.append('caption', caption);
            formData.append('parse_mode', 'HTML');
        }
        if (replyMarkup) {
            formData.append('reply_markup', JSON.stringify(replyMarkup));
        }

        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, formData, {
            headers: formData.getHeaders()
        });
    } catch (e: any) {
        console.error('❌ Ошибка отправки локального фото TG:', e.response?.data || e.message);
        throw e; // Re-throw to allow fallback
    }
};

const getUserInfo = async (chatId: string | number) => {
    try {
        const response = await axios.get(`https://api.telegram.org/bot${BOT_TOKEN}/getChat?chat_id=${chatId}`);
        const user = response.data.result;
        return {
            username: user.username || null,
            first_name: user.first_name || '',
            last_name: user.last_name || ''
        };
    } catch (e: any) {
        console.error('❌ Ошибка получения user info:', e.message);
        return { username: null, first_name: '', last_name: '' };
    }
};

// Функция для получения имени пользователя для админских уведомлений
const getDisplayName = async (order: any) => {
    // Если есть username в заказе (веб-пользователь), используем его
    if (order.username) {
        return order.username.startsWith('@') ? order.username : `@${order.username}`;
    }

    // Если это Telegram пользователь, получаем данные через API
    if (order.user_chat_id) {
        const userInfo = await getUserInfo(order.user_chat_id);
        return userInfo.username ? `@${userInfo.username}` : `${userInfo.first_name} ${userInfo.last_name}`.trim();
    }

    // Запасной вариант
    return 'Неизвестный пользователь';
};

const editTg = async (chatId: string | number, msgId: number, text: string, replyMarkup?: any) => {
    try {
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
            chat_id: chatId,
            message_id: msgId,
            text: text,
            parse_mode: 'HTML',
            reply_markup: replyMarkup
        });
    } catch (e: any) {
        if (e.response?.status === 400 && e.response?.data?.description?.includes('message is not modified') === false) {
            // Сообщение с фото нельзя редактировать через editMessageText — удаляем и отправляем новое
            try {
                await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`, { chat_id: chatId, message_id: msgId });
                await sendTg(chatId, text, replyMarkup);
            } catch (fallbackErr: any) {
                console.error('❌ Fallback при правке TG:', fallbackErr.message);
            }
        } else {
            console.error('❌ Ошибка правки сообщения TG:', e.message);
        }
    }
};

// Парсит несколько кодов: "325 ABC 120 DEF" или построчно "325 ABC\n120 DEF"
const parseMultipleCodes = (input: string): { uc: number; code: string }[] => {
    const result: { uc: number; code: string }[] = [];
    const tokens = input.trim().split(/\s+/);
    let currentUc: number | null = null;
    let codeParts: string[] = [];
    for (const t of tokens) {
        if (/^\d+$/.test(t)) {
            if (currentUc !== null && codeParts.length > 0) {
                result.push({ uc: currentUc, code: codeParts.join(' ') });
            }
            currentUc = parseInt(t);
            codeParts = [];
        } else {
            codeParts.push(t);
        }
    }
    if (currentUc !== null && codeParts.length > 0) {
        result.push({ uc: currentUc, code: codeParts.join(' ') });
    }
    return result;
};

const answerCallback = async (queryId: string, text: string) => {
    try {
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
            callback_query_id: queryId,
            text: text
        });
    } catch (e) { }
};

const calculateProfit = async (days: number) => {
    let startDate: Date;
    let endDate: Date | undefined;

    if (days === 1) {
        // Для одного дня: с 00:00 до 23:59 сегодняшнего дня по МСК
        const now = new Date();
        const mskOffset = 3; // МСК = UTC+3

        startDate = new Date();
        startDate.setUTCHours(-mskOffset, 0, 0, 0); // 00:00 МСК = 21:00 предыдущего дня UTC

        endDate = new Date();
        endDate.setUTCHours(23 - mskOffset, 59, 59, 999); // 23:59 МСК = 20:59 UTC

        console.log(`[DEBUG] Today period (MSK): ${startDate.toISOString()} to ${endDate.toISOString()}`);
        console.log(`[DEBUG] Local time: ${startDate.toLocaleString()} to ${endDate.toLocaleString()}`);
    } else if (days === 30) {
        // Для месяца: с 1 числа текущего месяца по сегодня
        const now = new Date();
        const mskOffset = 3; // МСК = UTC+3

        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
        startDate.setUTCHours(-mskOffset, 0, 0, 0); // 00:00 МСК 1 числа

        endDate = new Date();
        endDate.setUTCHours(23 - mskOffset, 59, 59, 999); // 23:59 МСК сегодня

        console.log(`[DEBUG] Month period (MSK): ${startDate.toISOString()} to ${endDate.toISOString()}`);
        console.log(`[DEBUG] Local time: ${startDate.toLocaleString()} to ${endDate.toLocaleString()}`);
    } else if (days === -1) {
        // Для прошлого месяца: с 1 по последнее число прошлого месяца
        const now = new Date();
        const mskOffset = 3; // МСК = UTC+3

        const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0); // Последнее число прошлого месяца

        startDate = new Date(lastMonth.getFullYear(), lastMonth.getMonth(), 1);
        startDate.setUTCHours(-mskOffset, 0, 0, 0); // 00:00 МСК 1 числа прошлого месяца

        endDate = new Date(lastMonthEnd.getFullYear(), lastMonthEnd.getMonth(), lastMonthEnd.getDate());
        endDate.setUTCHours(23 - mskOffset, 59, 59, 999); // 23:59 МСК последнего числа прошлого месяца

        console.log(`[DEBUG] Last month period (MSK): ${startDate.toISOString()} to ${endDate.toISOString()}`);
        console.log(`[DEBUG] Local time: ${startDate.toLocaleString()} to ${endDate.toLocaleString()}`);
    } else {
        // Для недели: последние 7 дней от текущего момента
        startDate = new Date();
        startDate.setDate(startDate.getDate() - days);
        startDate.setHours(0, 0, 0, 0);

        endDate = new Date();
        endDate.setHours(23, 59, 59, 999);
    }

    // Получаем настройки для расчета себестоимости
    const { data: settings } = await supabase
        .from('settings')
        .select('usd_rate, pp_price_usd, pp_markup_rub, ticket_price_usd, ticket_markup_rub, prime_price_usd, prime_1m_usd, prime_3m_usd, prime_6m_usd, prime_12m_usd, prime_plus_1m_usd, prime_plus_3m_usd, prime_plus_6m_usd, prime_plus_12m_usd')
        .single();

    const { data: baseDenoms } = await supabase
        .from('base_denominations')
        .select('amount_uc, price_usd');

    let query = supabase
        .from('orders')
        .select('id, final_amount, commission_amount, order_type, amount_uc, price_rub')
        .in('status', ['completed', 'paid', 'partial'])
        .in('order_type', ['uc', 'prime', 'pp', 'tickets', 'prime_plus'])
        .gte('created_at', startDate.toISOString());

    // Добавляем endDate если он установлен
    if (endDate) {
        query = query.lte('created_at', endDate.toISOString());
    }

    const { data } = await query;
    const { data: products } = await supabase
        .from('products')
        .select('amount_uc, markup_rub');

    console.log(`[DEBUG] calculateProfit: Found ${data?.length || 0} orders for period ${startDate.toISOString()} to ${endDate?.toISOString() || 'now'}`);
    if (data) {
        console.log(`[DEBUG] Orders:`, data.map(o => ({ id: o.id || 'unknown', type: o.order_type, price: o.price_rub, final: o.final_amount, uc: o.amount_uc })));
    }

    let totalMarkup = 0;
    let totalCommission = 0;

    if (data && settings) {
        const usdRate = settings.usd_rate || 80;
        console.log(`[DEBUG] USD rate: ${usdRate}`);
        console.log(`[DEBUG] Base denominations:`, baseDenoms);
        console.log(`[DEBUG] Products with markups:`, products);

        for (const order of data) {
            const priceRub = order.price_rub || 0;
            const commission = order.commission_amount || 0;
            let baseCost = 0;

            // Расчет реальной себестоимости
            if (order.order_type === 'uc' && order.amount_uc) {
                // Для UC: ищем базовую цену в base_denominations
                const denom = baseDenoms?.find((d: any) => d.amount_uc === order.amount_uc);
                console.log(`[DEBUG] Order #${order.id}: Looking for UC=${order.amount_uc}, found denom:`, denom);
                if (denom) {
                    baseCost = denom.price_usd * usdRate;
                } else {
                    console.log(`[DEBUG] Order #${order.id}: No exact denomination found for UC=${order.amount_uc}`);
                }
            } else if (order.order_type === 'pp') {
                // Для PP: берем базовую цену из настроек и умножаем на количество единиц (каждая единица = 10k UC)
                const ppUnits = (order.amount_uc || 0) / 10000;
                baseCost = (settings.pp_price_usd || 0) * ppUnits * usdRate;
            } else if (order.order_type === 'tickets') {
                // Для билетов: берем базовую цену из настроек
                baseCost = (settings.ticket_price_usd || 0) * usdRate;
            } else if (order.order_type === 'prime') {
                // Для Prime: определяем период по количеству месяцев и берем соответствующую базовую цену
                const amountUc = order.amount_uc || 0;
                let primeBasePrice = 0;

                if (amountUc === 1) {
                    primeBasePrice = settings.prime_1m_usd || 0; // 1 месяц
                } else if (amountUc === 3) {
                    primeBasePrice = settings.prime_3m_usd || 0; // 3 месяца
                } else if (amountUc === 6) {
                    primeBasePrice = settings.prime_6m_usd || 0; // 6 месяцев
                } else if (amountUc === 12) {
                    primeBasePrice = settings.prime_12m_usd || 0; // 12 месяцев
                } else {
                    // Если количество месяцев не определено, используем final_amount как запасной вариант
                    const finalAmount = order.final_amount || 0;
                    if (finalAmount <= 200) {
                        primeBasePrice = settings.prime_1m_usd || 0;
                    } else if (finalAmount <= 600) {
                        primeBasePrice = settings.prime_3m_usd || 0;
                    } else if (finalAmount <= 1000) {
                        primeBasePrice = settings.prime_6m_usd || 0;
                    } else {
                        primeBasePrice = settings.prime_12m_usd || 0;
                    }
                }

                baseCost = primeBasePrice * usdRate;
            } else if (order.order_type === 'prime_plus') {
                // Для Prime Plus: определяем период по количеству месяцев и берем соответствующую базовую цену
                const amountUc = order.amount_uc || 0;
                let primePlusBasePrice = 0;

                if (amountUc === 1) {
                    primePlusBasePrice = settings.prime_plus_1m_usd || 0; // 1 месяц
                } else if (amountUc === 3) {
                    primePlusBasePrice = settings.prime_plus_3m_usd || 0; // 3 месяца
                } else if (amountUc === 6) {
                    primePlusBasePrice = settings.prime_plus_6m_usd || 0; // 6 месяцев
                } else if (amountUc === 12) {
                    primePlusBasePrice = settings.prime_plus_12m_usd || 0; // 12 месяцев
                } else {
                    // Если количество месяцев не определено, используем final_amount как запасной вариант
                    const finalAmount = order.final_amount || 0;
                    if (finalAmount <= 400) {
                        primePlusBasePrice = settings.prime_plus_1m_usd || 0;
                    } else if (finalAmount <= 900) {
                        primePlusBasePrice = settings.prime_plus_3m_usd || 0;
                    } else if (finalAmount <= 1500) {
                        primePlusBasePrice = settings.prime_plus_6m_usd || 0;
                    } else {
                        primePlusBasePrice = settings.prime_plus_12m_usd || 0;
                    }
                }

                baseCost = primePlusBasePrice * usdRate;
            }

            let markup = 0;

            // Получаем наценку из базы данных
            if (order.order_type === 'uc' && order.amount_uc) {
                const product = products?.find((p: any) => p.amount_uc === order.amount_uc);
                markup = product?.markup_rub || 0;
            } else if (order.order_type === 'pp') {
                const ppUnits = (order.amount_uc || 0) / 10000;
                markup = (settings?.pp_markup_rub || 0) * ppUnits;
            } else if (order.order_type === 'tickets') {
                const ticketUnits = (order.amount_uc || 0) / 100;
                markup = (settings?.ticket_markup_rub || 0) * ticketUnits;
            } else if (order.order_type === 'prime') {
                // Для Prime наценка уже включена в цену
                markup = priceRub - baseCost;
            } else if (order.order_type === 'prime_plus') {
                // Для Prime Plus наценка уже включена в цену
                markup = priceRub - baseCost;
            }

            totalMarkup += markup;
            totalCommission += commission;
            console.log(`[DEBUG] Order #${order.id}: price=${priceRub}, baseCost=${baseCost}, markup=${markup}, commission=${commission}`);
        }
    }

    // Комиссия от общей суммы наценок (4.85% для SBP)
    const commissionFromMarkup = totalMarkup * 0.0485;
    const totalProfit = totalMarkup - commissionFromMarkup;

    console.log(`[DEBUG] Total markup: ${totalMarkup}, commission from markup: ${commissionFromMarkup}, final profit: ${totalProfit}`);

    return { totalProfit, ordersCount: data?.length || 0 };
};

// Клавиатура главного меню админ-панели
const getAdminMainKeyboard = () => ({
    inline_keyboard: [
        [{ text: "💰 Курсы", callback_data: "adm_rates" }, { text: "💎 UC/Маржа", callback_data: "adm_markup" }],
        [{ text: "📦 Коды", callback_data: "adm_codes" }, { text: "👑 ПП и билеты", callback_data: "adm_pp" }],
        [{ text: "🎮 Prime", callback_data: "adm_prime" }, { text: "💵 Базовые номиналы UC", callback_data: "adm_price_usd" }],
        [{ text: "📊 Наценки /list", callback_data: "adm_list" }, { text: "🛒 Управление товарами", callback_data: "admin_manage" }],
        [{ text: "📢 Рассылки", callback_data: "adm_broadcasts" }, { text: "💵 Прибыль", callback_data: "adm_profit" }],
        [{ text: "💱 Курс для дочернего", callback_data: "adm_child_convert" }],
        [{ text: "🔄 Активировать аккаунты", callback_data: "adm_activate_accounts" }],
        [{ text: "🎮 Наценка Steam %", callback_data: "adm_steam_markup" }, { text: "🎮Наценка PSN", callback_data: "adm_psgift_markup" }]
    ]
});

// Функция для отправки рассылки
async function sendBroadcast(adminChatId: string, message: string, photoId: string | null) {
    // Получаем всех активных пользователей для рассылки
    const { data: allUsers } = await supabase
        .from('broadcast_users')
        .select('chat_id')
        .eq('is_active', true);

    const users = allUsers?.map(user => user.chat_id) || [];

    if (users.length === 0) {
        await sendTg(adminChatId, '❌ Нет пользователей для рассылки', getAdminMainKeyboard());
        return;
    }

    await sendTg(adminChatId, `🚀 <b>Рассылка запущена!</b>\n\n📊 Отправка ${users.length} пользователям\n⏳ Это может занять время...`, getAdminMainKeyboard());

    // Отправляем сообщения всем пользователям
    for (let i = 0; i < users.length; i++) {
        const chatId = users[i];
        try {
            if (photoId) {
                // Отправляем фото с подписью
                await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
                    chat_id: chatId,
                    photo: photoId,
                    caption: message
                });
            } else {
                await sendTg(chatId, message);
            }
            console.log(`[Рассылка] Отправлено ${i + 1}/${users.length} (${chatId})`);

            // Задержка чтобы не заблокировали
            if (i < users.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        } catch (error) {
            console.error(`[Рассылка] Ошибка отправки ${chatId}:`, error);
        }
    }
}

// Функция для добавления пользователя в базу рассылки
async function addBroadcastUser(chatId: string | number, username?: string, firstName?: string, lastName?: string) {
    try {
        await supabase
            .from('broadcast_users')
            .upsert({
                chat_id: Number(chatId),
                username: username || null,
                first_name: firstName || null,
                last_name: lastName || null
            }, {
                onConflict: 'chat_id'
            });
    } catch (error) {
        console.error(`[BROADCAST USER] Ошибка добавления пользователя ${chatId}:`, error);
    }
}

// --- API РОУТЫ ---

app.get('/', (req, res) => res.send('✅ Server is running'));

app.post('/api/steam/check-user', async (req, res) => {
    try {
        const { login } = req.body;

        if (!login) {
            return res.status(400).json({ error: 'Логин не указан' });
        }

        // Адаптация под Python логику:
        // Python: call("POST", "/api/v2/steam/check_user", json_body={"steam_id": "..."})
        // Наш JS: call(метод, путь, параметры_запроса, тело_запроса)
        const resp = await nsClient.call(
            "POST",
            "/api/v2/steam/check_user",
            null, // params (Query string) - тут пусто
            { "steam_id": login.trim() } // jsonBody (BODY) - как в Python примере
        );

        // В Python примере: resp["accountStatus"]
        // В JS: resp.accountStatus
        console.log(`[STEAM CHECK] Логин: ${login}, Результат: ${resp.accountStatus}`);

        res.json({
            valid: resp.accountStatus // возвращаем true или false
        });

    } catch (e: any) {
        // Логируем ошибку для отладки
        console.error('❌ Ошибка API при проверке Steam:', e.response?.data || e.message);

        // В случае ошибки (например, неверная подпись или сервер NS упал)
        // возвращаем статус false, чтобы не дать оплатить невалидный логин
        res.status(200).json({ valid: false, error: 'Технические работы на стороне провайдера' });
    }
});

// API эндпоинт для cron активации аккаунтов
app.post('/api/activate-accounts', async (req, res) => {
    try {
        const { error } = await supabase
            .from('midas_accounts')
            .update({ is_active: true });

        if (error) {
            console.error('❌ Ошибка активации аккаунтов (cron):', error);
            return res.status(500).json({ error: error.message });
        }

        console.log('✅ Все аккаунты Midasbuy активированы (cron)');
        res.json({ success: true, message: 'Аккаунты активированы' });
    } catch (err) {
        console.error('❌ Ошибка активации аккаунтов (cron):', err);
        res.status(500).json({ error: 'Внутренняя ошибка' });
    }
});

// 5.5. ТЕСТ АКТИВАТОРА (ВРЕМЕННО)
app.get('/api/test-activate', async (req, res) => {
    const { uid, code, headless } = req.query as { uid: string, code: string, headless: string };
    if (!uid || !code) return res.json({ error: 'Need uid and code' });

    const { data: accounts } = await supabase.from('midas_accounts').select('*').eq('is_active', true).limit(1);
    if (!accounts || accounts.length === 0) return res.json({ error: 'No active accounts' });

    const account = accounts[0];
    const result = await activateSingleCode({ email: account.email, pass: account.password }, uid, code, headless === 'false');

    res.json({ result, account: account.email });
});

// 1.5. Получение товаров Prime (Prime и Prime Plus)
app.get('/api/prime-prices', async (req, res) => {
    try {
        const { data: settings } = await supabase.from('settings').select('*').single();

        if (!settings) return res.status(500).json({ error: 'DB Data not found' });

        const usdRateStore = settings.usd_rate_store || settings.usd_rate || 90;
        const primeProducts = [
            {
                id: 'prime',
                title: 'Prime',
                periods: [
                    { months: 1, price: Math.ceil((Number(settings.prime_1m_usd) || 5) * usdRateStore + (Number(settings.prime_markup_1m_rub) || 0)) },
                    { months: 3, price: Math.ceil((Number(settings.prime_3m_usd) || 13.5) * usdRateStore + (Number(settings.prime_markup_3m_rub) || 0)) },
                    { months: 6, price: Math.ceil((Number(settings.prime_6m_usd) || 25) * usdRateStore + (Number(settings.prime_markup_6m_rub) || 0)) },
                    { months: 9, price: Math.ceil((Number(settings.prime_9m_usd) || 37.5) * usdRateStore + (Number(settings.prime_markup_9m_rub) || 0)) },
                    { months: 12, price: Math.ceil((Number(settings.prime_12m_usd) || 47) * usdRateStore + (Number(settings.prime_markup_12m_rub) || 0)) }
                ],
                image_url: '/prime.jpg',
                description: 'Prime Gaming подписка'
            },
            {
                id: 'prime_plus',
                title: 'Prime Plus',
                periods: [
                    { months: 1, price: Math.ceil((Number(settings.prime_plus_1m_usd) || 8.33) * usdRateStore + (Number(settings.prime_plus_markup_1m_rub) || 0)) },
                    { months: 3, price: Math.ceil((Number(settings.prime_plus_3m_usd) || 23.33) * usdRateStore + (Number(settings.prime_plus_markup_3m_rub) || 0)) },
                    { months: 6, price: Math.ceil((Number(settings.prime_plus_6m_usd) || 43.33) * usdRateStore + (Number(settings.prime_plus_markup_6m_rub) || 0)) },
                    { months: 9, price: Math.ceil((Number(settings.prime_plus_9m_usd) || 62.5) * usdRateStore + (Number(settings.prime_plus_markup_9m_rub) || 0)) },
                    { months: 12, price: Math.ceil((Number(settings.prime_plus_12m_usd) || 80) * usdRateStore + (Number(settings.prime_plus_markup_12m_rub) || 0)) }
                ],
                image_url: '/prime-plus.jpg',
                description: 'Prime Gaming Plus подписка'
            }
        ];
        res.json(primeProducts);
    } catch (e) { res.status(500).json({ error: 'Internal Error' }); }
});

// 2. Получение товаров (UC по ID) — цены складываются из базовых номиналов (60, 325, 660, 1800, 3850, 8100)
app.get('/api/products', async (req, res) => {
    try {
        const { store } = req.query; // 'store' или 'promo'
        const { data: settings } = await supabase.from('settings').select('*').single();
        const { data: products } = await supabase.from('products').select('*').order('sort_order');
        const { data: baseDenoms } = await supabase.from('base_denominations').select('*').order('amount_uc', { ascending: false });

        if (!settings || !products || !baseDenoms) return res.status(500).json({ error: 'DB Data not found' });

        const usdRate = store === 'promo' ? (settings.usd_rate_promo || settings.usd_rate || 90) : (settings.usd_rate_store || settings.usd_rate || 90);

        const calculateUCPrice = (ucAmount: number, baseDenominations: any[], usdRate: number, markupRub: number, feePercent: number, isPromo: boolean) => {
            let totalUsd = 0;
            let remaining = ucAmount;
            for (const denom of baseDenominations) {
                if (remaining >= denom.amount_uc) {
                    const count = Math.floor(remaining / denom.amount_uc);
                    totalUsd += count * denom.price_usd;
                    remaining -= count * denom.amount_uc;
                }
            }
            if (remaining > 0) {
                const minDenom = baseDenominations.find((d: any) => d.amount_uc === 60);
                if (minDenom) totalUsd += (remaining / 60) * minDenom.price_usd;
            }
            const basePrice = (totalUsd * usdRate) + markupRub;
            return Math.ceil(basePrice);
        };

        const list = products.map(p => {
            const productMarkup = p.markup_rub || 0;
            const finalPrice = calculateUCPrice(p.amount_uc, baseDenoms, usdRate, productMarkup, settings.fee_percent, store === 'promo');
            return {
                id: p.id,
                amount_uc: p.amount_uc,
                price: finalPrice,
                image_url: p.image_url
            };
        });
        res.json(list);
    } catch (e) { res.status(500).json({ error: 'Internal Error' }); }
});

// 3. ПОЛУЧЕНИЕ ПРОМОКОДОВ (ДЛЯ СКИНОВ/КОДОВ)
app.get('/api/promo-products', async (req, res) => {
    try {
        const { data: settings } = await supabase.from('settings').select('*').single();
        const { data: stock } = await supabase.from('codes_stock').select('value').eq('is_used', false);

        if (!settings || !stock) return res.status(500).json({ error: 'Data not found' });

        const counts: any = {};
        stock.forEach(s => counts[s.value] = (counts[s.value] || 0) + 1);

        const { data: baseDenoms } = await supabase.from('base_denominations').select('*').order('amount_uc', { ascending: false });
        const usdRate = settings.usd_rate_promo || settings.usd_rate || 90;
        const calcUsdFromBase = (ucAmount: number) => {
            if (!baseDenoms?.length) return (ucAmount / 60) * 1;
            let totalUsd = 0, remaining = ucAmount;
            for (const d of baseDenoms) {
                if (remaining >= d.amount_uc) {
                    const c = Math.floor(remaining / d.amount_uc);
                    totalUsd += c * d.price_usd;
                    remaining -= c * d.amount_uc;
                }
            }
            if (remaining > 0) {
                const m = baseDenoms.find((x: any) => x.amount_uc === 60);
                if (m) totalUsd += (remaining / 60) * m.price_usd;
            }
            return totalUsd;
        };
        const list = Object.keys(counts).map(val => {
            const amount = parseInt(val);
            const baseUsd = calcUsdFromBase(amount);
            const finalPrice = Math.ceil((baseUsd * usdRate + 100) * (1 + settings.fee_percent));

            return {
                id: amount,
                amount_uc: amount,
                price: finalPrice,
                image_url: '/1.png',
                stock_count: counts[val]
            };
        });
        res.json(list);
    } catch (e) { res.status(500).json({ error: 'Internal Error' }); }
});

// 4. Создание платежа
app.post('/api/create-payment', async (req, res) => {
    console.log("Запрос на оплату пришел:", req.body);
    try {
        const {
            uid,
            amount,
            price,
            method_slug,
            user_chat_id,
            is_code,
            type,
            buyer_first_name,
            buyer_last_name,
            account_login,
            account_password,
            game_nickname,
        } = req.body;

        if (user_chat_id) {
            try {
                await addBroadcastUser(
                    user_chat_id || 0,
                    undefined,
                    buyer_first_name,
                    buyer_last_name
                );
            } catch (err) {
                console.error("Ошибка при добавлении пользователя в рассылку:", err);
            }
        }

        // Вставка в базу данных
        const { data: order, error } = await supabase
            .from('orders')
            .insert([{
                uid_player: uid || 'PROMOCODE',
                amount_uc: amount,
                price_rub: price,
                status: 'pending',
                user_chat_id: user_chat_id || 0,
                is_code_order: !!is_code,
                order_type: type || 'uc',
                buyer_first_name: buyer_first_name || null,
                buyer_last_name: buyer_last_name || null,
                account_login: account_login || null,
                account_password: account_password || null,
                game_nickname: game_nickname || null,
            }])
            .select()
            .single();

        // 1. СНАЧАЛА проверяем, нет ли ошибки от Supabase
        if (error) {
            console.error('Ошибка Supabase при создании заказа:', error);
            return res.status(400).json({ error: `Ошибка БД: ${error.message}` });
        }

        // 2. Проверяем, что объект order вообще существует
        if (!order) {
            console.error('Заказ не был возвращен из базы данных');
            return res.status(500).json({ error: 'Не удалось создать запись в базе данных' });
        }

        // 3. Теперь безопасно логируем
        console.log('Order created successfully:', { id: order.id, amount_uc: order.amount_uc });

        let description = '';
        if (type === 'pp') {
            description = `Покупка ${amount} ПП для ID: ${uid}`;
        } else if (type === 'tickets') {
            description = `Покупка ${amount} билетов для ID: ${uid}`;
        } else if (type === 'skin') {
            description = `Покупка скина ${uid}`;
        } else if (type === 'prime') {
            description = `Покупка подписки Prime Gaming`;
        } else if (type === 'prime_plus') {
            description = `Покупка подписки Prime Gaming Plus`;
        } else if (type === 'login') {
            description = `Пополнение по входу ${amount} UC`;
        } else if (type === 'steam_topup') {
            description = `Пополнение Steam (логин: ${uid}) на $${amount}`;
        } else if (type === 'ps_gift') {
            description = `Подарочная карта PlayStation (ID товара: ${amount})`;
        } else {
            description = is_code ? `Покупка кода на ${amount} UC` : `Пополнение ${amount} UC для ID: ${uid}`;
        }

        const paymentData = {
            method_slug: method_slug || 'sbp',
            amount: Number(price),
            description: description,
            metadata: {
                order_id: order.id,
                notification_url: `${process.env.BACKEND_URL || 'ВАШ_URL'}/api/payment-callback`
            }
        };

        // Инициализация платежа
        const response = await axios.post('https://codeepay.ru/initiate_payment', paymentData, {
            headers: { 'X-Api-Key': process.env.CODEEPAY_API_KEY }
        });

        console.log('✅ Payment response from codeepay:', response.data);

        // Обновляем payment_id в заказе
        await supabase
            .from('orders')
            .update({ payment_id: String(response.data.order_id) })
            .eq('id', order.id);

        res.json({ url: response.data.url, order_id: order.id });

    } catch (e: any) {
        console.error('Payment Error (General):', e.message);
        res.status(500).json({ error: e.message });
    }
});

// 5. Проверка статуса
app.get('/api/check-status/:orderId', async (req, res) => {
    try {
        const { orderId } = req.params;
        const { data, error } = await supabase
            .from('orders')
            .select('status')
            .eq('id', parseInt(orderId))
            .single();

        if (error || !data) return res.status(404).json({ status: 'not_found' });
        res.json({ status: data.status });
    } catch (err) { res.status(500).json({ error: 'Status check failed' }); }
});

// 6. Callback от платежной системы
app.post('/api/payment-callback', async (req, res) => {
    console.log('Request from IP:', req.ip, 'Body:', JSON.stringify(req.body, null, 2));
    res.status(200).send('OK');
    try {
        console.log('Webhook received:', JSON.stringify(req.body, null, 2));
        const { order_id, metadata, final_amount, commission_amount } = req.body;
        const localOrderId = parseInt(metadata?.order_id);

        if (localOrderId) {
            console.log('Updating order:', localOrderId);
            const { data: order } = await supabase
                .from('orders')
                .update({ status: 'paid', final_amount, commission_amount })
                .eq('id', localOrderId)
                .select()
                .single();

            console.log('Updated order status to paid for:', localOrderId);

            if (!order) return res.status(404).send('Not Found');

            // Учёт выручки главного магазина (дочерний — свой payment-callback + recordChildOrderRevenue)
            try {
                await recordOrderRevenue(supabase, order.id, Number(order.price_rub) || 0, order.created_at);
            } catch (e) {
                console.error('[treasury_main] recordOrderRevenue', e);
            }

            if (order.order_type === 'steam_topup' || order.order_type === 'ps_gift') {
                try {
                    console.log(`[NS API] Обработка заказа #${order.id} (${order.order_type})`);

                    let serviceId: number;
                    let fields: any[];

                    if (order.order_type === 'steam_topup') {
                        // --- ЛОГИКА STEAM ---
                        serviceId = 1;
                        fields = [
                            { key: "account", value: String(order.uid_player).trim() }, // Строка
                            { key: "amount", value: Number(order.amount_uc) }           // Число (USD)
                        ];
                    } else {
                        // --- ЛОГИКА PLAYSTATION ---
                        serviceId = Number(order.amount_uc);
                        fields = [{ key: "quantity", value: 1 }];
                    }

                    // ФИКС: Обязательно вызываем функцию со скобками ()
                    const nsCustomId = uuidv4();

                    // 1. Создаем заказ в NS API
                    await nsClient.call("POST", "/api/v2/create_order", null, {
                        service_id: serviceId,
                        custom_id: nsCustomId,
                        fields: fields
                    });

                    // 2. Оплачиваем заказ (списание баланса NS)
                    const payResult = await nsClient.call("POST", "/api/v2/pay_order", null, {
                        custom_id: nsCustomId
                    });

                    if (payResult.status === 'completed') {
                        if (order.order_type === 'ps_gift' && payResult.pins && payResult.pins.length > 0) {
                            const pinCode = payResult.pins[0];
                            await sendTg(order.user_chat_id,
                                `🎁 <b>Ваш код PlayStation готов!</b>\n\n` +
                                `Код: <code>${pinCode}</code>\n\n` +
                                `<i>Активируйте его в настройках вашего аккаунта PS Store.</i>`
                            );
                        } else {
                            await sendTg(order.user_chat_id,
                                `✅ <b>Steam успешно пополнен!</b>\n\n` +
                                `Логин: <code>${order.uid_player}</code>\n` +
                                `Сумма: $${order.amount_uc}`
                            );
                        }

                        await supabase.from('orders').update({ status: 'completed' }).eq('id', order.id);
                        if (order.order_type === 'ps_gift') {
                            await sendTg(ADMIN_CHAT_ID, `✅ Заказ #${order.id} PlayStation успешно выполнен. Код выдан пользователю.`);
                        } else {
                            await sendTg(ADMIN_CHAT_ID, `✅ Заказ #${order.id} Steam успешно выполнен. Пополнение прошло на ${order.amount_uc}.`);
                        }

                    } else if (payResult.status === 'in_progress') {
                        await sendTg(order.user_chat_id, `⏳ Ваш заказ находится в обработке на стороне провайдера. Мы пришлем уведомление сразу после активации.`);
                    } else {
                        // Если статус 'insufficient' или другой
                        throw new Error(`Статус API: ${payResult.status}`);
                    }

                    return;

                } catch (e: any) {
                    // Распаковка детальной ошибки
                    const errorData = e.response?.data;
                    console.error('❌ ДЕТАЛЬНАЯ ОШИБКА NS API:', JSON.stringify(errorData, null, 2));

                    let errorMessage = 'Неизвестная ошибка';
                    if (errorData) {
                        errorMessage = errorData.detail || errorData.message || JSON.stringify(errorData);
                    } else {
                        errorMessage = e.message;
                    }

                    const username = await getDisplayName(order);

                    await sendTg(ADMIN_CHAT_ID,
                        `❌ <b>ОШИБКА АВТОВЫДАЧИ #${order.id}</b>\n` +
                        `Тип: ${order.order_type}\n` +
                        `Юзер: ${username}\n` +
                        `Причина: <code>${errorMessage}</code>\n\n` +
                        `⚠️ <b>ВЫДАЙТЕ ВРУЧНУЮ!</b>`
                    );
                    return;
                }
            }
            // --- КОНЕЦ БЛОКА NS API ---

            if (order.is_code_order && order.uid_player !== 'MANUAL_ORDER') {
                const { data: codeEntry } = await supabase
                    .from('codes_stock')
                    .select('*')
                    .eq('value', order.amount_uc)
                    .eq('is_used', false)
                    .limit(1)
                    .single();

                if (codeEntry) {
                    await supabase.from('codes_stock').update({ is_used: true }).eq('id', codeEntry.id);
                    await sendTg(order.user_chat_id, `🎁 <b>Ваш промокод на ${order.amount_uc} UC:</b>\n\n<code>${codeEntry.code}</code>\n\nАктивируйте на Midasbuy.`);
                    const username = await getDisplayName(order);
                    await sendTg(ADMIN_CHAT_ID, `✅ Код на ${order.amount_uc} UC выдан автоматически (Заказ #${order.id}) для ${username}`);
                    await supabase.from('orders').update({ status: 'completed' }).eq('id', order.id);
                } else {
                    const username = await getDisplayName(order);
                    await sendTg(ADMIN_CHAT_ID, `⚠️ <b>НЕТ КОДОВ!</b> Заказ #${order.id} на ${order.amount_uc} UC для ${username}. Выдайте вручную!`);
                }
                return;
            }

            if (order.amount_uc < 1800 && order.order_type === 'uc') {
                const username = await getDisplayName(order);
                const adminMsg = `🤖 <b>АВТО-ВЫДАЧА #${order.id}</b>\n\n👤 <b>${username}</b>\n🆔 UID: <code>${order.uid_player}</code>\n💎 Сумма: <b>${order.amount_uc} UC</b>\n💵 Руб: ${order.price_rub}\n\n🤖 <i>Бот выдает автоматически.</i>`;

                await sendTg(ADMIN_CHAT_ID, adminMsg);
                await sendTg(order.user_chat_id, `💳 <b>Оплата прошла успешно!</b>\n\n💎 <b>${order.amount_uc} UC</b> будут выданы автоматически в течение 5-15 минут на UID: <code>${order.uid_player}</code>\n\nЕсли возникнут вопросы, пишите в поддержку.`);

                try {
                    await fulfillOrder(order.id, order.uid_player, order.amount_uc, order.user_chat_id);
                } catch (e) {
                    await sendTg(ADMIN_CHAT_ID, `❌ Ошибка бота в заказе #${order.id}`);
                }
            } else if (order.order_type === 'pp' || order.order_type === 'tickets' || order.order_type === 'skin' || order.order_type === 'prime' || order.order_type === 'prime_plus') {
                const username = await getDisplayName(order);
                const item = order.order_type === 'pp' ? 'ПП' : order.order_type === 'tickets' ? 'билетов' : order.order_type === 'skin' ? 'скина' : order.order_type === 'prime' ? 'Prime' : 'Prime Plus';
                const adminMsg = `💰 <b>ЗАКАЗ ${item.toUpperCase()} #${order.id}</b>\n\n👤 <b>${username}</b>\n${order.order_type === 'skin' ? `🎭 Скин: <code>${order.uid_player}</code>\n` : `🆔 UID: <code>${order.uid_player}</code>\n👑 Сумма: <b>${order.amount_uc} ${item}</b>\n`}💵 Руб: ${order.price_rub}`;
                const keyboard = { inline_keyboard: [[{ text: "✅ Выдал (Уведомить)", callback_data: `done_${order.id}` }]] };
                await sendTg(ADMIN_CHAT_ID, adminMsg, keyboard);

                const userMsg = order.order_type === 'skin' ? `🎭 <b>Ваш скин будет выдан вручную в ближайшее время.</b>\n\nЕсли возникнут вопросы, пишите в поддержку.` : order.order_type === 'prime' || order.order_type === 'prime_plus' ? `🎮 <b>Ваша подписка ${item} будет активирована вручную в ближайшее время.</b>\n\nЕсли возникнут вопросы, пишите в поддержку.` : `👑 <b>${order.amount_uc} ${item}</b> будут выданы вручную в ближайшее время.\n\nЕсли возникнут вопросы, пишите в поддержку.`;
                await sendTg(order.user_chat_id, userMsg);
            } else {
                // Крупные заказы 1800+ - автовыдача с задержкой 2 минуты и возможностью перехвата
                const username = await getDisplayName(order);
                const adminMsg = `💰 <b>КРУПНЫЙ ЗАКАЗ #${order.id}</b>\n\n👤 <b>${username}</b>\n🆔 UID: <code>${order.uid_player}</code>\n💎 Сумма: ${order.amount_uc} UC\n💵 Руб: ${order.price_rub}\n\n⏰ <i>Автовыдача через 2 минуты. Можете перехватить.</i>`;

                const keyboard = { inline_keyboard: [[{ text: "🛑 Перехватить (Отменить бота)", callback_data: `hold_${order.id}` }]] };
                await sendTg(ADMIN_CHAT_ID, adminMsg, keyboard);
                await sendTg(order.user_chat_id, `💳 <b>Оплата прошла успешно!</b>\n\n💎 <b>${order.amount_uc} UC</b> будут выданы автоматически в течение 2-5 минут на UID: <code>${order.uid_player}</code>\n\nЕсли возникнут вопросы, пишите в поддержку.`);

                // Устанавливаем таймер на автовыдачу через 2 минуты (120000 мс)
                const automationTimer = setTimeout(async () => {
                    try {
                        console.log(`[AUTO-FULFILL] Starting automated fulfillment for order ${order.id} (${order.amount_uc} UC)`);
                        await fulfillOrder(order.id, order.uid_player, order.amount_uc, order.user_chat_id);
                        await sendTg(ADMIN_CHAT_ID, `✅ Автовыдача заказа #${order.id} (${order.amount_uc} UC) завершена`);
                    } catch (e) {
                        console.error(`[AUTO-FULFILL] Error in order ${order.id}:`, e);
                        await sendTg(ADMIN_CHAT_ID, `❌ Ошибка автовыдачи заказа #${order.id}. Выдайте вручную!`);
                    }
                }, 120000); // 2 минуты

                automationTimers.set(order.id, automationTimer);
            }
        }
    } catch (e) {
        console.error('Callback error:', e);
        res.status(500).send('Error');
    }
});

// 7. Получение настроек
app.get('/api/settings', async (req, res) => {
    try {
        const { data: settings } = await supabase.from('settings').select('*').single();
        if (!settings) return res.status(500).json({ error: 'Settings not found' });
        res.json(settings);
    } catch (e) { res.status(500).json({ error: 'Internal Error' }); }
});

// 8. Ручной заказ (для промо-магазина)
app.post('/api/manual-order', async (req, res) => {
    try {
        const { items, user_chat_id } = req.body;

        if (!items || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ error: 'Items required' });
        }

        if (!user_chat_id) {
            return res.status(400).json({ error: 'User chat ID required' });
        }

        // Отправка менеджеру
        const totalAmount = items.reduce((sum: number, item: any) => sum + (item.amount * item.quantity), 0);
        const totalPrice = items.reduce((sum: number, item: any) => sum + (item.price * item.quantity), 0);
        const itemDetails = items.map((item: any) => `${item.amount} UC × ${item.quantity} = ${(item.price * item.quantity).toLocaleString()}₽`).join('\n');

        const userInfo = await getUserInfo(user_chat_id);
        const username = userInfo.username ? `@${userInfo.username}` : `${userInfo.first_name} ${userInfo.last_name}`.trim();

        const adminMsg = `🛒 <b>РУЧНОЙ ЗАКАЗ ПРОМО</b>\n\n👤 <b>${username}</b>\n💎 Общее: ${totalAmount} UC\n💵 Сумма: ${totalPrice.toLocaleString()}₽\n\n📋 Товары:\n${itemDetails}\n\n🤖 Выдать вручную!`;

        const keyboard = {
            inline_keyboard: [[{ text: "✅ Выдал (Уведомить)", callback_data: `manual_done_${user_chat_id}_${totalAmount}` }]]
        };

        await sendTg(ADMIN_CHAT_ID, adminMsg, keyboard);

        // Уведомление пользователю
        await sendTg(user_chat_id, `🛒 <b>Ваш заказ принят!</b>\n\n💎 ${totalAmount} UC будут выданы вручную в ближайшее время.\n\nЕсли возникнут вопросы, пишите в поддержку.`);

        res.json({ success: true });
    } catch (e: any) {
        console.error('Manual order error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// 9. Получение товаров скинов
app.get('/api/skin-products', async (req, res) => {
    try {
        const { data: skins } = await supabase.from('skins_products').select('*');
        res.json(skins || []);
    } catch (e) { res.status(500).json({ error: 'Internal Error' }); }
});

// 9. ВЕБХУК TELEGRAM
app.post('/api/bot-webhook', async (req, res) => {
    res.status(200).send('OK');
    const { message, callback_query } = req.body;
    console.log('[WEBHOOK] Received webhook');
    console.log('[WEBHOOK] Message:', message ? 'yes' : 'no', 'Callback:', callback_query ? 'yes' : 'no');

    let chatId = '';

    if (message && message.text) {
        const text = message.text;
        chatId = message.chat.id.toString();
        console.log(`[WEBHOOK] Processing message: "${text}" from chat ${chatId}`);
        console.log(`[WEBHOOK] Is admin? ${ADMIN_CHAT_ID.includes(chatId)}`);

        // Добавляем пользователя в базу рассылки
        if (!ADMIN_CHAT_ID.includes(chatId)) {
            addBroadcastUser(
                chatId,
                message.chat.username,
                message.chat.first_name,
                message.chat.last_name
            );
        }

        if (ADMIN_CHAT_ID.includes(chatId)) {
            // Обработка ввода в режиме ожидания (кнопочная панель)
            const state = adminStates.get(chatId);
            if (state) {
                if (state.action === 'await_курс_store') {
                    const rate = parseFloat(text.trim().replace(',', '.'));
                    if (!isNaN(rate)) {
                        const { error } = await supabase.from('settings').update({ usd_rate_store: rate }).eq('id', 1);
                        await sendTg(chatId, error ? `❌ Ошибка` : `📉 Курс Store: ${rate} руб/$`, getAdminMainKeyboard());
                    } else await sendTg(chatId, '❌ Введите число');
                    adminStates.delete(chatId);
                    return;
                }
                if (state.action === 'await_курс_promo') {
                    const rate = parseFloat(text.trim().replace(',', '.'));
                    if (!isNaN(rate)) {
                        const { error } = await supabase.from('settings').update({ usd_rate_promo: rate }).eq('id', 1);
                        await sendTg(chatId, error ? `❌ Ошибка` : `📉 Курс Promo: ${rate} руб/$`, getAdminMainKeyboard());
                    } else await sendTg(chatId, '❌ Введите число');
                    adminStates.delete(chatId);
                    return;
                }
                if (state.action === 'await_маржа' && state.uc !== undefined) {
                    const val = parseInt(text.trim());
                    if (!isNaN(val)) {
                        const { error } = await supabase.from('products').update({ markup_rub: val }).eq('amount_uc', state.uc);
                        await sendTg(chatId, error ? `❌ Ошибка` : `✅ Маржа ${state.uc} UC = ${val}₽`, getAdminMainKeyboard());
                    } else await sendTg(chatId, '❌ Введите число');
                    adminStates.delete(chatId);
                    return;
                }
                if (state.action === 'await_код') {
                    const lines = text.trim().split(/\s+/).filter((l: string) => l.length > 0);
                    if (lines.length >= 2 && lines.length % 2 === 0) {
                        let added = 0;
                        for (let i = 0; i < lines.length; i += 2) {
                            const uc = parseInt(lines[i]);
                            const code: string = lines[i + 1];
                            if (!isNaN(uc) && code) {
                                const { error } = await supabase.from('codes').insert([{ amount_uc: uc, code }]);
                                if (!error) added++;
                            }
                        }
                        const msg = added > 0 ? `✅ Добавлено ${added} кодов` : '❌ Ошибка';
                        await sendTg(chatId, msg, getAdminMainKeyboard());
                    } else {
                        await sendTg(chatId, '❌ Формат: UC пробел КОД — можно несколько через пробел или с новой строки\n\nПример: <code>325 ABC123 120 DEF456</code>\nИли:\n<code>325 ABC123\n120 DEF456</code>', getAdminMainKeyboard());
                    }
                    adminStates.delete(chatId);
                    return;
                }
                if (state.action === 'await_код_batch' && state.uc !== undefined) {
                    const codes = text.trim().split(/\s+/).filter((s: string) => s.length > 0);
                    if (codes.length > 0) {
                        const rows = codes.map((code: string) => ({ value: state.uc!, code, is_used: false }));
                        const { error } = await supabase.from('codes_stock').insert(rows);
                        const msg = error ? `❌ Ошибка БД` : `✅ Добавлено ${codes.length} кодов на ${state.uc} UC`;
                        await sendTg(chatId, msg, getAdminMainKeyboard());
                    } else {
                        await sendTg(chatId, '❌ Введите хотя бы один код', getAdminMainKeyboard());
                    }
                    adminStates.delete(chatId);
                    return;
                }
                if (state.action === 'await_price_usd' && state.uc !== undefined) {
                    const price = parseFloat(text.trim().replace(',', '.'));
                    if (!isNaN(price) && price >= 0) {
                        const { error } = await supabase.from('base_denominations').update({ price_usd: price }).eq('amount_uc', state.uc);
                        await sendTg(chatId, error ? `❌ Ошибка` : `✅ ${state.uc} UC = ${price}$`, getAdminMainKeyboard());
                    } else await sendTg(chatId, '❌ Введите число >= 0');
                    adminStates.delete(chatId);
                    return;
                }
                if (state.action === 'await_pp_markup') {
                    const markup = parseInt(text.trim());
                    if (!isNaN(markup)) {
                        await supabase.from('settings').update({ pp_markup_rub: markup }).eq('id', 1);
                        await sendTg(chatId, `👑 Маржа ПП: ${markup}₽`, getAdminMainKeyboard());
                    } else await sendTg(chatId, '❌ Введите число');
                    adminStates.delete(chatId);
                    return;
                }
                if (state.action === 'await_pp_usd') {
                    const price = parseFloat(text.trim().replace(',', '.'));
                    if (!isNaN(price)) {
                        await supabase.from('settings').update({ pp_price_usd: price }).eq('id', 1);
                        await sendTg(chatId, `👑 ПП (10000): ${price}$`, getAdminMainKeyboard());
                    } else await sendTg(chatId, '❌ Введите число');
                    adminStates.delete(chatId);
                    return;
                }
                if (state.action === 'await_ticket_usd') {
                    const price = parseFloat(text.trim().replace(',', '.'));
                    if (!isNaN(price)) {
                        await supabase.from('settings').update({ ticket_price_usd: price }).eq('id', 1);
                        await sendTg(chatId, `🎫 Билеты (100): ${price}$`, getAdminMainKeyboard());
                    } else await sendTg(chatId, '❌ Введите число');
                    adminStates.delete(chatId);
                    return;
                }
                if (state.action === 'await_ticket_markup') {
                    const markup = parseInt(text.trim());
                    if (!isNaN(markup)) {
                        await supabase.from('settings').update({ ticket_markup_rub: markup }).eq('id', 1);
                        await sendTg(chatId, `🎫 Маржа билетов: ${markup}₽`, getAdminMainKeyboard());
                    } else await sendTg(chatId, '❌ Введите число');
                    adminStates.delete(chatId);
                    return;
                }
                if (state.action.startsWith('await_prime_')) {
                    const key = state.action.replace('await_', '');
                    const val = key.includes('markup') ? parseInt(text.trim()) : parseFloat(text.trim().replace(',', '.'));
                    if (!isNaN(val)) {
                        const fieldMap: Record<string, string> = {
                            'prime_1m_usd': 'prime_1m_usd', 'prime_1m_markup': 'prime_markup_1m_rub',
                            'prime_3m_usd': 'prime_3m_usd', 'prime_3m_markup': 'prime_markup_3m_rub',
                            'prime_6m_usd': 'prime_6m_usd', 'prime_6m_markup': 'prime_markup_6m_rub',
                            'prime_9m_usd': 'prime_9m_usd', 'prime_9m_markup': 'prime_markup_9m_rub',
                            'prime_12m_usd': 'prime_12m_usd', 'prime_12m_markup': 'prime_markup_12m_rub',
                            'prime_plus_1m_usd': 'prime_plus_1m_usd', 'prime_plus_1m_markup': 'prime_plus_markup_1m_rub',
                            'prime_plus_3m_usd': 'prime_plus_3m_usd', 'prime_plus_3m_markup': 'prime_plus_markup_3m_rub',
                            'prime_plus_6m_usd': 'prime_plus_6m_usd', 'prime_plus_6m_markup': 'prime_plus_markup_6m_rub',
                            'prime_plus_9m_usd': 'prime_plus_9m_usd', 'prime_plus_9m_markup': 'prime_plus_markup_9m_rub',
                            'prime_plus_12m_usd': 'prime_plus_12m_usd', 'prime_plus_12m_markup': 'prime_plus_markup_12m_rub'
                        };
                        const field = fieldMap[key];
                        if (field) {
                            await supabase.from('settings').update({ [field]: val }).eq('id', 1);
                            await sendTg(chatId, `✅ Обновлено`, getAdminMainKeyboard());
                        }
                    } else await sendTg(chatId, '❌ Введите число');
                    adminStates.delete(chatId);
                    return;
                }
                if (state.action === 'await_temp_skin_title') {
                    const title = text.trim();
                    if (title.length > 0) {
                        adminStates.set(chatId, { action: 'await_temp_skin_price', title });
                        await sendTg(chatId, `⏰ <b>Добавление временного скина</b>\n\nШаг 2/2: Введите цену скина в рублях:`);
                    } else {
                        await sendTg(chatId, '❌ Название не может быть пустым. Введите название скина:');
                    }
                    return;
                }
                if (state.action === 'await_temp_skin_price') {
                    const price = parseInt(text.trim());
                    if (!isNaN(price) && price > 0) {
                        adminStates.set(chatId, { action: 'await_temp_skin_photo', title: state.title, price });
                        await sendTg(chatId, `⏰ <b>Временный скин</b>\n\nНазвание: ${state.title}\nЦена: ${price}₽\n\nТеперь отправьте фото скина:`);
                    } else {
                        await sendTg(chatId, '❌ Цена должна быть положительным числом. Введите цену скина в рублях:');
                    }
                    return;
                }

                if (state.action === 'await_broadcast_message') {
                    const message = text.trim();
                    if (message.length > 0) {
                        adminStates.set(chatId, { action: 'await_broadcast_photo', message });
                        await sendTg(chatId, `📷 <b>Добавить фото к рассылке?</b>\n\nОтправьте фото или нажмите "Продолжить без фото":`, {
                            inline_keyboard: [[{ text: "➡️ Продолжить без фото", callback_data: "broadcast_send_no_photo" }]]
                        });
                    } else {
                        await sendTg(chatId, '❌ Сообщение не может быть пустым. Введите текст сообщения:');
                    }
                    return;
                }
                if (state.action === 'await_child_convert_rate') {
                    const rate = parseFloat(text.trim().replace(',', '.'));
                    if (isNaN(rate) || rate <= 0) {
                        await sendTg(chatId, '❌ Введите курс (руб за 1 USDT), например: 95');
                        return;
                    }
                    const result = await convertChildRubToUsdt(rate);
                    adminStates.delete(chatId);
                    if (!result.ok) {
                        await sendTg(chatId, `❌ ${result.error}`, getAdminMainKeyboard());
                    } else {
                        await sendTg(
                            chatId,
                            `✅ <b>Курс для дочернего</b>\n\n` +
                            `${formatRub(result.totalRub!)} → ${result.usdtAdded!.toFixed(2)} USDT\n` +
                            `Курс: ${result.rate} руб/USDT\n` +
                            `USDT к выводу (дочерний): ${result.newBalanceUsdt!.toFixed(2)}`,
                            getAdminMainKeyboard()
                        );
                    }
                    return;
                }
                if (state.action === 'await_steam_markup') {
                    const val = parseFloat(text.trim());
                    if (!isNaN(val)) {
                        // Делим на 100, чтобы в базе хранить 0.15 вместо 15
                        const decimalMarkup = val / 100;
                        const { error } = await supabase.from('settings').update({ steam_fee_percent: decimalMarkup }).eq('id', 1);
                        await sendTg(chatId, error ? `❌ Ошибка` : `✅ Наценка Steam установлена: ${val}%`, getAdminMainKeyboard());
                    } else {
                        await sendTg(chatId, '❌ Введите число');
                    }
                    adminStates.delete(chatId);
                    return;
                }
                if (state.action === 'await_ps_markup' && state.serviceId) {
                    const val = parseInt(text.trim());
                    if (!isNaN(val)) {
                        const columnName = `ps_markup_${state.serviceId}`;
                        const { error } = await supabase
                            .from('settings')
                            .update({ [columnName]: val })
                            .eq('id', 1);
                        await sendTg(chatId, error ? `❌ Ошибка` : `✅ Наценка для товара ${state.serviceId} установлена: +${val}₽`, getAdminMainKeyboard());
                    } else {
                        await sendTg(chatId, '❌ Введите число');
                    }
                    adminStates.delete(chatId);
                    return;
                }

            }

            // Обработка команд для админа (текстовые команды сохранены для совместимости)
            if (text === '/start') {
                console.log(`[START] Processing /start for admin ${chatId}`);

                const welcomeMessage = `🎮 <b>Привет, Админ!</b>\n\n` +
                    `Добро пожаловать в <b>UC Магазин</b>! 🛒\n\n` +
                    `Здесь вы можете купить:\n` +
                    `💎 <b>UC</b> для PUBG Mobile\n` +
                    `🎭 <b>Скины</b> и аксессуары\n` +
                    `👑 <b>ПП</b> (Популярность)\n` +
                    `🎫 <b>Билеты</b> для дома\n` +
                    `🎮 <b>Prime Gaming</b> подписки\n\n` +
                    `Используйте /admin для панели управления:`;

                const keyboard = {
                    inline_keyboard: [[
                        { text: "Открыть магазин", icon_custom_emoji_id: "5242557396416500126", style: "danger", web_app: { url: `${process.env.CLIENT_URL || 'https://ucmagaz.web.app'}` } }
                    ], [
                        { text: "🔧 Админ панель", callback_data: "admin_panel" }
                    ]]
                };

                // Отправляем текст, не фото — чтобы кнопка «Админ панель» редактировала сообщение (editMessageText не работает с фото)
                await sendTg(chatId, welcomeMessage, keyboard);
                return; // Выходим, чтобы не обрабатывать как админские команды
            }

            if (text.toLowerCase().startsWith('маржа ')) {
                const [_, uc, val] = text.split(' ');
                const { error } = await supabase.from('products').update({ markup_rub: parseInt(val) }).eq('amount_uc', parseInt(uc));
                await sendTg(chatId, error ? `❌ Ошибка` : `✅ Для <b>${uc} UC</b> маржа теперь <b>${val} руб.</b>`);
            }

            if (text === '/list') {
                const { data: products } = await supabase.from('products').select('*').order('amount_uc');
                let m = "📊 <b>Наценки UC:</b>\n";
                products?.forEach((p: any) => m += `💎 ${p.amount_uc} UC | +${p.markup_rub}₽\n`);
                await sendTg(chatId, m);
            }

            if (text.toLowerCase().startsWith('код ')) {
                const body = text.slice(4).trim();
                const codes = parseMultipleCodes(body);
                if (codes.length > 0) {
                    const rows = codes.map(c => ({ value: c.uc, code: c.code, is_used: false }));
                    const { error } = await supabase.from('codes_stock').insert(rows);
                    await sendTg(chatId, error ? `❌ Ошибка БД` : `✅ Добавлено кодов: ${codes.length}`);
                } else {
                    await sendTg(chatId, '❌ Формат: код UC КОД [UC КОД ...]\nМожно через пробел или с новой строки.\nПример: код 325 ABC123 120 DEF456');
                }
            }

            if (text.toLowerCase().startsWith('освободить')) {
                const { error } = await supabase.from('codes_stock').update({ is_used: false, status: null }).eq('status', 'RESERVED');
                await sendTg(chatId, error ? `❌ Ошибка` : `✅ Все RESERVED коды освобождены.`);
            }

            if (text.toLowerCase().startsWith('курс_store ')) {
                const rate = parseFloat(text.split(' ')[1]);
                console.log('Setting usd_rate_store to', rate);
                const { error } = await supabase.from('settings').update({ usd_rate_store: rate }).eq('id', 1);
                console.log('Update error:', error);
                await sendTg(chatId, `📉 Курс Store обновлен: ${rate} руб/$`);
            }

            if (text.toLowerCase().startsWith('курс_promo ')) {
                const rate = parseFloat(text.split(' ')[1]);
                console.log('Setting usd_rate_promo to', rate);
                const { error } = await supabase.from('settings').update({ usd_rate_promo: rate }).eq('id', 1);
                console.log('Update error:', error);
                await sendTg(chatId, `📉 Курс Promo обновлен: ${rate} руб/$`);
            }

            if (text.toLowerCase().startsWith('price_usd ')) {
                const parts = text.split(' ');
                const uc = parseInt(parts[1]);
                const price = parseFloat(parts[2]);
                if (!isNaN(uc) && !isNaN(price) && price >= 0) {
                    const { error } = await supabase.from('base_denominations').update({ price_usd: price }).eq('amount_uc', uc);
                    await sendTg(chatId, error ? `❌ Ошибка` : `✅ ${uc} UC = ${price}$`);
                }
            }

            if (text.toLowerCase().startsWith('pp_markup ')) {
                const markup = parseInt(text.split(' ')[1]);
                await supabase.from('settings').update({ pp_markup_rub: markup }).eq('id', 1);
                await sendTg(chatId, `👑 Маржа ПП: ${markup}₽`);
            }

            if (text.toLowerCase().startsWith('pp_usd ')) {
                const price = parseFloat(text.split(' ')[1]);
                const { error } = await supabase.from('settings').update({ pp_price_usd: price }).eq('id', 1);
                await sendTg(chatId, `👑 Базовая цена ПП (10000): ${price}$`);
            }

            if (text.toLowerCase().startsWith('ticket_usd ')) {
                const price = parseFloat(text.split(' ')[1]);
                await supabase.from('settings').update({ ticket_price_usd: price }).eq('id', 1);
                await sendTg(chatId, `🎫 Базовая цена билетов (100): ${price}$`);
            }

            if (text.toLowerCase().startsWith('ticket_markup ')) {
                const markup = parseInt(text.split(' ')[1]);
                await supabase.from('settings').update({ ticket_markup_rub: markup }).eq('id', 1);
                await sendTg(chatId, `🎫 Маржа билетов: ${markup}₽`);
            }

            // Команды для цен периодов Prime
            if (text.toLowerCase().startsWith('prime_1m_usd ')) {
                const price = parseFloat(text.split(' ')[1]);
                await supabase.from('settings').update({ prime_1m_usd: price }).eq('id', 1);
                await sendTg(chatId, `🎮 Prime 1 мес USD: ${price}$`);
            }

            if (text.toLowerCase().startsWith('prime_1m_markup ')) {
                const markup = parseInt(text.split(' ')[1]);
                await supabase.from('settings').update({ prime_markup_1m_rub: markup }).eq('id', 1);
                await sendTg(chatId, `🎮 Prime 1 мес маржа: ${markup}₽`);
            }

            if (text.toLowerCase().startsWith('prime_3m_usd ')) {
                const price = parseFloat(text.split(' ')[1]);
                await supabase.from('settings').update({ prime_3m_usd: price }).eq('id', 1);
                await sendTg(chatId, `🎮 Prime 3 мес USD: ${price}$`);
            }

            if (text.toLowerCase().startsWith('prime_3m_markup ')) {
                const markup = parseInt(text.split(' ')[1]);
                await supabase.from('settings').update({ prime_markup_3m_rub: markup }).eq('id', 1);
                await sendTg(chatId, `🎮 Prime 3 мес маржа: ${markup}₽`);
            }

            if (text.toLowerCase().startsWith('prime_6m_usd ')) {
                const price = parseFloat(text.split(' ')[1]);
                await supabase.from('settings').update({ prime_6m_usd: price }).eq('id', 1);
                await sendTg(chatId, `🎮 Prime 6 мес USD: ${price}$`);
            }

            if (text.toLowerCase().startsWith('prime_6m_markup ')) {
                const markup = parseInt(text.split(' ')[1]);
                await supabase.from('settings').update({ prime_markup_6m_rub: markup }).eq('id', 1);
                await sendTg(chatId, `🎮 Prime 6 мес маржа: ${markup}₽`);
            }

            if (text.toLowerCase().startsWith('prime_9m_usd ')) {
                const price = parseFloat(text.split(' ')[1]);
                await supabase.from('settings').update({ prime_9m_usd: price }).eq('id', 1);
                await sendTg(chatId, `🎮 Prime 9 мес USD: ${price}$`);
            }

            if (text.toLowerCase().startsWith('prime_9m_markup ')) {
                const markup = parseInt(text.split(' ')[1]);
                await supabase.from('settings').update({ prime_markup_9m_rub: markup }).eq('id', 1);
                await sendTg(chatId, `🎮 Prime 9 мес маржа: ${markup}₽`);
            }

            if (text.toLowerCase().startsWith('prime_12m_usd ')) {
                const price = parseFloat(text.split(' ')[1]);
                await supabase.from('settings').update({ prime_12m_usd: price }).eq('id', 1);
                await sendTg(chatId, `🎮 Prime 12 мес USD: ${price}$`);
            }

            if (text.toLowerCase().startsWith('prime_12m_markup ')) {
                const markup = parseInt(text.split(' ')[1]);
                await supabase.from('settings').update({ prime_markup_12m_rub: markup }).eq('id', 1);
                await sendTg(chatId, `🎮 Prime 12 мес маржа: ${markup}₽`);
            }

            if (text.toLowerCase().startsWith('prime_plus_1m_usd ')) {
                const price = parseFloat(text.split(' ')[1]);
                await supabase.from('settings').update({ prime_plus_1m_usd: price }).eq('id', 1);
                await sendTg(chatId, `🎮 Prime Plus 1 мес USD: ${price}$`);
            }

            if (text.toLowerCase().startsWith('prime_plus_1m_markup ')) {
                const markup = parseInt(text.split(' ')[1]);
                await supabase.from('settings').update({ prime_plus_markup_1m_rub: markup }).eq('id', 1);
                await sendTg(chatId, `🎮 Prime Plus 1 мес маржа: ${markup}₽`);
            }

            if (text.toLowerCase().startsWith('prime_plus_3m_usd ')) {
                const price = parseFloat(text.split(' ')[1]);
                await supabase.from('settings').update({ prime_plus_3m_usd: price }).eq('id', 1);
                await sendTg(chatId, `🎮 Prime Plus 3 мес USD: ${price}$`);
            }

            if (text.toLowerCase().startsWith('prime_plus_3m_markup ')) {
                const markup = parseInt(text.split(' ')[1]);
                await supabase.from('settings').update({ prime_plus_markup_3m_rub: markup }).eq('id', 1);
                await sendTg(chatId, `🎮 Prime Plus 3 мес маржа: ${markup}₽`);
            }

            if (text.toLowerCase().startsWith('prime_plus_6m_usd ')) {
                const price = parseFloat(text.split(' ')[1]);
                await supabase.from('settings').update({ prime_plus_6m_usd: price }).eq('id', 1);
                await sendTg(chatId, `🎮 Prime Plus 6 мес USD: ${price}$`);
            }

            if (text.toLowerCase().startsWith('prime_plus_6m_markup ')) {
                const markup = parseInt(text.split(' ')[1]);
                await supabase.from('settings').update({ prime_plus_markup_6m_rub: markup }).eq('id', 1);
                await sendTg(chatId, `🎮 Prime Plus 6 мес маржа: ${markup}₽`);
            }

            if (text.toLowerCase().startsWith('prime_plus_9m_usd ')) {
                const price = parseFloat(text.split(' ')[1]);
                await supabase.from('settings').update({ prime_plus_9m_usd: price }).eq('id', 1);
                await sendTg(chatId, `🎮 Prime Plus 9 мес USD: ${price}$`);
            }

            if (text.toLowerCase().startsWith('prime_plus_9m_markup ')) {
                const markup = parseInt(text.split(' ')[1]);
                await supabase.from('settings').update({ prime_plus_markup_9m_rub: markup }).eq('id', 1);
                await sendTg(chatId, `🎮 Prime Plus 9 мес маржа: ${markup}₽`);
            }

            if (text.toLowerCase().startsWith('prime_plus_12m_usd ')) {
                const price = parseFloat(text.split(' ')[1]);
                await supabase.from('settings').update({ prime_plus_12m_usd: price }).eq('id', 1);
                await sendTg(chatId, `🎮 Prime Plus 12 мес USD: ${price}$`);
            }

            if (text.toLowerCase().startsWith('prime_plus_12m_markup ')) {
                const markup = parseInt(text.split(' ')[1]);
                await supabase.from('settings').update({ prime_plus_markup_12m_rub: markup }).eq('id', 1);
                await sendTg(chatId, `🎮 Prime Plus 12 мес маржа: ${markup}₽`);
            }

            if (text === '/admin_manage') {
                const keyboard = {
                    inline_keyboard: [
                        [{ text: "💎 UC", callback_data: "m_uc" }],
                        [{ text: "🎭 Skins", callback_data: "m_skins" }],
                        [{ text: "🔙 Назад", callback_data: "adm_back" }]
                    ]
                };
                await sendTg(chatId, "🛒 <b>Управление товарами</b>\n\nВыберите категорию:", keyboard);
            }

            if (text === '/admin') {
                const text2 = `🔧 <b>Админ-панель</b>\n\nВыберите действие:`;
                await sendTg(chatId, text2, getAdminMainKeyboard());
            }

        } else {
            // Обработка команд для обычных пользователей
            if (text === '/start') {
                console.log(`[START] Processing /start for regular user ${chatId}`);

                const welcomeMessage = `Добро пожаловать в наш магазин 👋\n\nВоспользуйся кнопкой ниже для осуществления покупки 🛍️`;

                const keyboard = {
                    inline_keyboard: [[
                        { text: "Открыть магазин", icon_custom_emoji_id: "5242557396416500126", style: "danger", web_app: { url: `${process.env.CLIENT_URL || 'https://ucmagaz.web.app'}` } }
                    ]]
                };

                await sendTg(chatId, welcomeMessage, keyboard);
                return;
            }

            // Ограничение админ-команд для юзеров
            if (['курс', 'маржа', 'код', 'освободить', 'price_usd', 'pp_markup', 'pp_usd', 'ticket_usd', 'ticket_markup', 'prime_markup', 'prime_plus_markup', '/admin', '/admin_manage'].some(cmd => text.toLowerCase().startsWith(cmd))) {
                await sendTg(chatId, "доступно только администратору");
            }
        }
    }

    // Обработка фото скинов
    if (message && message.photo) {
        const currentChatId = message.chat.id.toString();
        if (ADMIN_CHAT_ID.includes(currentChatId)) {
            const caption = message.caption ? message.caption.trim() : '';

            // Обработка фото для рассылки и временного скина
            const state = adminStates.get(currentChatId);
            if (state && state.action === 'await_broadcast_photo') {
                adminStates.delete(currentChatId);
                try {
                    const fileId = message.photo[message.photo.length - 1].file_id;
                    if (state.message) {
                        await sendBroadcast(currentChatId, state.message, fileId);
                    }
                } catch (error: any) {
                    await sendTg(currentChatId, `❌ Ошибка обработки фото: ${error.message}`, getAdminMainKeyboard());
                }
            }

            if (state && state.action === 'await_temp_skin_photo') {
                adminStates.delete(currentChatId);
                try {
                    console.log(`[TEMP SKIN UPLOAD] Starting upload for '${state.title}' price ${state.price}`);
                    const fileId = message.photo[message.photo.length - 1].file_id;
                    const fileResponse = await axios.get(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`);
                    const filePath = fileResponse.data.result.file_path;
                    const downloadUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
                    const imageResponse = await axios.get(downloadUrl, { responseType: 'arraybuffer' });
                    const buffer = Buffer.from(imageResponse.data);
                    const fileName = `temp_skin_${Date.now()}.jpg`;

                    const { error: uploadError } = await supabase.storage.from('skins').upload(fileName, buffer, { contentType: 'image/jpeg' });
                    if (uploadError) throw uploadError;

                    const { data: urlData } = supabase.storage.from('skins').getPublicUrl(fileName);

                    const { error: insertError } = await supabase.from('skins_products').insert([{
                        title: state.title,
                        price_rub: state.price,
                        image_url: urlData.publicUrl,
                        is_temporary: true
                    }]);

                    if (insertError) throw insertError;

                    await sendTg(currentChatId, `✅ Временный скин "${state.title}" добавлен!`, getAdminMainKeyboard());
                } catch (e: any) {
                    console.error('[TEMP SKIN UPLOAD] Error:', e);
                    await sendTg(currentChatId, '❌ Ошибка при добавлении временного скина', getAdminMainKeyboard());
                }
                return;
            }

            // Обработка обычного скина
            if (caption && caption.toLowerCase().startsWith('скин ')) {
                const parts = caption.split(' ');
                if (parts.length >= 3) {
                    const title = parts.slice(1, -1).join(' ');
                    const price = parseInt(parts[parts.length - 1]);
                    if (!isNaN(price)) {
                        try {
                            console.log(`[SKIN UPLOAD] Starting upload for '${title}' price ${price}`);
                            const fileId = message.photo[message.photo.length - 1].file_id;
                            console.log(`[SKIN UPLOAD] File ID: ${fileId}`);
                            const fileResponse = await axios.get(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`);
                            const filePath = fileResponse.data.result.file_path;
                            console.log(`[SKIN UPLOAD] File path: ${filePath}`);
                            const downloadUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
                            console.log(`[SKIN UPLOAD] Download URL: ${downloadUrl}`);
                            const imageResponse = await axios.get(downloadUrl, { responseType: 'arraybuffer' });
                            const buffer = Buffer.from(imageResponse.data);
                            console.log(`[SKIN UPLOAD] Buffer size: ${buffer.length} bytes`);
                            const fileName = `skin_${Date.now()}.jpg`;
                            console.log(`[SKIN UPLOAD] Uploading to Supabase: ${fileName}`);
                            const { error: uploadError } = await supabase.storage.from('skins').upload(fileName, buffer, { contentType: 'image/jpeg' });
                            if (uploadError) {
                                console.error('[SKIN UPLOAD] Upload error:', uploadError);
                                throw uploadError;
                                console.error('[SKIN UPLOAD] Upload error:', uploadError);
                                throw uploadError;
                            }
                            console.log(`[SKIN UPLOAD] Upload successful`);
                            const { data: urlData } = supabase.storage.from('skins').getPublicUrl(fileName);
                            console.log(`[SKIN UPLOAD] Public URL: ${urlData.publicUrl}`);
                            const { error: insertError } = await supabase.from('skins_products').insert([{ title, price_rub: price, image_url: urlData.publicUrl }]);
                            if (insertError) {
                                console.error('[SKIN UPLOAD] Insert error:', insertError);
                                throw insertError;
                            }
                            console.log(`[SKIN UPLOAD] Insert successful`);
                            await sendTg(currentChatId, `✅ Скин "${title}" добавлен за ${price}₽`);
                        } catch (e: any) {
                            console.error('[SKIN UPLOAD] Exception:', e);
                            await sendTg(currentChatId, `❌ Ошибка добавления скина: ${e.message}`);
                        }
                    } else {
                        await sendTg(currentChatId, '❌ Неверный формат цены');
                    }
                } else {
                    await sendTg(currentChatId, '❌ Формат: скин [название] [цена]');
                }
            }
        }
    }

    // Обработка Callback-кнопок
    if (callback_query) {
        const data = callback_query.data;
        const currentChatId = callback_query.message.chat.id.toString();
        const msgId = callback_query.message.message_id;

        // Добавляем пользователя в базу рассылки
        if (!ADMIN_CHAT_ID.includes(currentChatId)) {
            addBroadcastUser(
                currentChatId,
                callback_query.message.chat.username,
                callback_query.message.chat.first_name,
                callback_query.message.chat.last_name
            );
        }

        if (data === 'admin_panel') {
            const text = `🔧 <b>Админ-панель</b>\n\nВыберите действие:`;
            await editTg(currentChatId, msgId, text, getAdminMainKeyboard());
        }

        if (data === 'adm_back') {
            adminStates.delete(currentChatId);
            const text = `🔧 <b>Админ-панель</b>\n\nВыберите действие:`;
            await editTg(currentChatId, msgId, text, getAdminMainKeyboard());
        }

        if (data === 'adm_rates') {
            const { data: s } = await supabase.from('settings').select('usd_rate_store, usd_rate_promo, usd_rate').single();
            const storeRate = s?.usd_rate_store ?? s?.usd_rate ?? '-';
            const promoRate = s?.usd_rate_promo ?? s?.usd_rate ?? '-';
            const text = `💰 <b>Курсы валют</b>\n\nStore: ${storeRate} руб/$\nPromo: ${promoRate} руб/$`;
            const keyboard = {
                inline_keyboard: [
                    [{ text: "📉 Курс Store", callback_data: "adm_курс_store" }, { text: "📉 Курс Promo", callback_data: "adm_курс_promo" }],
                    [{ text: "90", callback_data: "adm_rate_store_90" }, { text: "95", callback_data: "adm_rate_store_95" }, { text: "100", callback_data: "adm_rate_store_100" }],
                    [{ text: "90 promo", callback_data: "adm_rate_promo_90" }, { text: "95 promo", callback_data: "adm_rate_promo_95" }, { text: "100 promo", callback_data: "adm_rate_promo_100" }],
                    [{ text: "🔙 Назад", callback_data: "adm_back" }]
                ]
            };
            await editTg(currentChatId, msgId, text, keyboard);
        }

        if (data === 'adm_курс_store') {
            adminStates.set(currentChatId, { action: 'await_курс_store' });
            await editTg(currentChatId, msgId, `📉 Введите курс Store (руб/$):`, { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "adm_back" }]] });
        }

        if (data === 'adm_курс_promo') {
            adminStates.set(currentChatId, { action: 'await_курс_promo' });
            await editTg(currentChatId, msgId, `📉 Введите курс Promo (руб/$):`, { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "adm_back" }]] });
        }

        if (data.startsWith('adm_rate_store_')) {
            const rate = parseFloat(data.replace('adm_rate_store_', ''));
            await supabase.from('settings').update({ usd_rate_store: rate }).eq('id', 1);
            await answerCallback(callback_query.id, `Store: ${rate} руб/$`);
            const text = `💰 <b>Курсы валют</b>\n\nStore: ${rate} руб/$\n`;
            const { data: s } = await supabase.from('settings').select('usd_rate_promo').single();
            const promoRate = s?.usd_rate_promo ?? '-';
            const keyboard = {
                inline_keyboard: [
                    [{ text: "📉 Курс Store", callback_data: "adm_курс_store" }, { text: "📉 Курс Promo", callback_data: "adm_курс_promo" }],
                    [{ text: "90", callback_data: "adm_rate_store_90" }, { text: "95", callback_data: "adm_rate_store_95" }, { text: "100", callback_data: "adm_rate_store_100" }],
                    [{ text: "90 promo", callback_data: "adm_rate_promo_90" }, { text: "95 promo", callback_data: "adm_rate_promo_95" }, { text: "100 promo", callback_data: "adm_rate_promo_100" }],
                    [{ text: "🔙 Назад", callback_data: "adm_back" }]
                ]
            };
            await editTg(currentChatId, msgId, text + `Promo: ${promoRate} руб/$`, keyboard);
        }
        if (data.startsWith('ps_markup_')) {
            const serviceId = parseInt(data.replace('ps_markup_', ''));
            if (!isNaN(serviceId)) {
                adminStates.set(currentChatId, { action: 'await_ps_markup', serviceId });
                await editTg(currentChatId, msgId, `🎮 Введите наценку (₽) для товара ${serviceId}:`, {
                    inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'adm_psgift_markup' }]]
                });
            }
        }


        if (data.startsWith('adm_rate_promo_')) {
            const rate = parseFloat(data.replace('adm_rate_promo_', ''));
            await supabase.from('settings').update({ usd_rate_promo: rate }).eq('id', 1);
            await answerCallback(callback_query.id, `Promo: ${rate} руб/$`);
            const { data: s } = await supabase.from('settings').select('usd_rate_store').single();
            const storeRate = s?.usd_rate_store ?? '-';
            const text = `💰 <b>Курсы валют</b>\n\nStore: ${storeRate} руб/$\nPromo: ${rate} руб/$`;
            const keyboard = {
                inline_keyboard: [
                    [{ text: "📉 Курс Store", callback_data: "adm_курс_store" }, { text: "📉 Курс Promo", callback_data: "adm_курс_promo" }],
                    [{ text: "90", callback_data: "adm_rate_store_90" }, { text: "95", callback_data: "adm_rate_store_95" }, { text: "100", callback_data: "adm_rate_store_100" }],
                    [{ text: "90 promo", callback_data: "adm_rate_promo_90" }, { text: "95 promo", callback_data: "adm_rate_promo_95" }, { text: "100 promo", callback_data: "adm_rate_promo_100" }],
                    [{ text: "🔙 Назад", callback_data: "adm_back" }]
                ]
            };
            await editTg(currentChatId, msgId, text, keyboard);
        }

        if (data === 'adm_markup') {
            adminStates.delete(currentChatId);
            const { data: products } = await supabase.from('products').select('*').order('amount_uc');
            let text = `💎 <b>Маржа UC</b>\n\nВыберите пакет:`;
            const rows: any[] = [];
            if (products && products.length > 0) {
                products.forEach((p: any) => {
                    rows.push([{ text: `${p.amount_uc} UC (+${p.markup_rub}₽)`, callback_data: `adm_маржа_${p.amount_uc}` }]);
                });
            }
            rows.push([{ text: "🔙 Назад", callback_data: "adm_back" }]);
            await editTg(currentChatId, msgId, text, { inline_keyboard: rows });
        }

        if (data.startsWith('adm_маржа_') && !data.startsWith('adm_маржа_set_')) {
            const uc = parseInt(data.replace('adm_маржа_', ''));
            const presetKeyboard = {
                inline_keyboard: [
                    [{ text: "0", callback_data: `adm_маржа_set_${uc}_0` }, { text: "50", callback_data: `adm_маржа_set_${uc}_50` }, { text: "100", callback_data: `adm_маржа_set_${uc}_100` }],
                    [{ text: "150", callback_data: `adm_маржа_set_${uc}_150` }, { text: "200", callback_data: `adm_маржа_set_${uc}_200` }],
                    [{ text: "✏️ Ввести вручную", callback_data: `adm_маржа_input_${uc}` }],
                    [{ text: "🔙 Назад", callback_data: "adm_markup" }]
                ]
            };
            await editTg(currentChatId, msgId, `💎 Маржа для <b>${uc} UC</b> — выберите или введите:`, presetKeyboard);
        }

        if (data.startsWith('adm_маржа_input_')) {
            const uc = parseInt(data.replace('adm_маржа_input_', ''));
            adminStates.set(currentChatId, { action: 'await_маржа', uc });
            await editTg(currentChatId, msgId, `💎 Введите маржу для <b>${uc} UC</b> в руб:`, { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "adm_markup" }]] });
        }

        if (data.startsWith('adm_маржа_set_')) {
            const parts = data.replace('adm_маржа_set_', '').split('_');
            const uc = parseInt(parts[0]);
            const val = parseInt(parts[1]);
            const { error } = await supabase.from('products').update({ markup_rub: val }).eq('amount_uc', uc);
            await answerCallback(callback_query.id, error ? "Ошибка" : `Маржа ${uc} UC = ${val}₽`);
            const { data: products } = await supabase.from('products').select('*').order('amount_uc');
            let text = `💎 <b>Маржа UC</b>\n\n✅ ${uc} UC: ${val}₽`;
            const rows: any[] = [];
            if (products && products.length > 0) {
                products.forEach((p: any) => {
                    rows.push([{ text: `${p.amount_uc} UC (+${p.markup_rub}₽)`, callback_data: `adm_маржа_${p.amount_uc}` }]);
                });
            }
            rows.push([{ text: "🔙 Назад", callback_data: "adm_back" }]);
            await editTg(currentChatId, msgId, text, { inline_keyboard: rows });
        }

        if (data === 'adm_codes') {
            adminStates.delete(currentChatId);
            // Прямой тест для 3850 и 8100
const { data: test3850, error: err3850 } = await supabase
    .from('codes_stock')
    .select('value, is_used')
    .eq('value', 3850);
console.log('🔍 Тест для 3850:', test3850?.length || 0, 'записей', err3850 || '');

const { data: test8100, error: err8100 } = await supabase
    .from('codes_stock')
    .select('value, is_used')
    .eq('value', 8100);
console.log('🔍 Тест для 8100:', test8100?.length || 0, 'записей', err8100 || '');
            const { data: stock } = await supabase.from('codes_stock').select('value, is_used').order('value');
            const grouped: Record<number, { normal: number; used: number }> = {};
            stock?.forEach((item: any) => {
                if (!grouped[item.value]) {
                    grouped[item.value] = { normal: 0, used: 0 };
                }
                if (item.is_used) {
                    grouped[item.value].used++;
                } else {
                    grouped[item.value].normal++;
                }
            });
            console.log('📦 Количество записей в stock:', stock?.length);
console.log('📦 Уникальные value в stock:', [...new Set(stock?.map(s => s.value))]);
            const lines = Object.entries(grouped)
                .sort(([a], [b]) => Number(a) - Number(b))
                .map(([uc, { normal, used }]) => `💎 ${uc} UC: ${normal} шт. (использовано: ${used})`)
                .join('\n');
            const text = `📦 <b>Остатки кодов по номиналам</b>\n\n${lines}`;
            const { data: baseDenoms } = await supabase.from('base_denominations').select('amount_uc').order('amount_uc');
            console.log('=== ADM_CODES DIAGNOSTIC ===');
            console.log('baseDenoms (raw):', baseDenoms);
            console.log('baseDenoms length:', baseDenoms?.length);
            const ucList = baseDenoms?.map((d: any) => d.amount_uc) ?? [60, 325, 660, 1800, 3850, 8100];
            console.log('ucList:', ucList);
            
            const ucButtons = ucList.map((uc: number) => ({ text: `${uc} UC`, callback_data: `adm_код_batch_${uc}` }));
            const keyboard = {
                inline_keyboard: [
                    ucButtons.slice(0, 4),
                    ucButtons.slice(4, 8),
                    [{ text: "🔓 Освободить RESERVED", callback_data: "adm_освободить" }],
                    [{ text: "🔙 Назад", callback_data: "adm_back" }]
                ]
            };
            console.log('text length:', text.length);
            console.log('keyboard:', JSON.stringify(keyboard, null, 2));
            await editTg(currentChatId, msgId, text, keyboard);
        }

        if (data.startsWith('adm_код_batch_')) {
            const uc = parseInt(data.replace('adm_код_batch_', ''));
            if (!isNaN(uc)) {
                adminStates.set(currentChatId, { action: 'await_код_batch', uc });
                await editTg(currentChatId, msgId, `📦 <b>${uc} UC</b> — вставьте коды одним сообщением:\n\nПо одному в строке или через пробел. Например:\n<code>CODE1\nCODE2\nCODE3</code>\n\nили <code>CODE1 CODE2 CODE3</code>`, { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "adm_codes" }]] });
            }
        }

        if (data === 'adm_освободить') {
            const { error } = await supabase.from('codes_stock').update({ is_used: false, status: null }).eq('status', 'RESERVED');
            await answerCallback(callback_query.id, error ? "Ошибка" : "Освобождено");
            const text = `📦 <b>Коды</b>\n\n${error ? '❌ Ошибка' : '✅ RESERVED коды освобождены'}`;
            const keyboard = {
                inline_keyboard: [
                    [{ text: "🔓 Освободить RESERVED", callback_data: "adm_освободить" }],
                    [{ text: "🔙 Назад", callback_data: "adm_back" }]
                ]
            };
            await editTg(currentChatId, msgId, text, keyboard);
        }

        if (data === 'adm_pp') {
            const { data: s } = await supabase.from('settings').select('pp_price_usd, pp_markup_rub, ticket_price_usd, ticket_markup_rub').single();
            const text = `👑 <b>ПП и билеты</b>\n\nПП: ${s?.pp_price_usd ?? '-'}$ + ${s?.pp_markup_rub ?? '-'}₽\nБилеты: ${s?.ticket_price_usd ?? '-'}$ + ${s?.ticket_markup_rub ?? '-'}₽`;
            const keyboard = {
                inline_keyboard: [
                    [{ text: "👑 ПП цена $", callback_data: "adm_pp_usd" }, { text: "👑 ПП маржа ₽", callback_data: "adm_pp_markup" }],
                    [{ text: "🎫 Билеты $", callback_data: "adm_ticket_usd" }, { text: "🎫 Билеты маржа ₽", callback_data: "adm_ticket_markup" }],
                    [{ text: "🔙 Назад", callback_data: "adm_back" }]
                ]
            };
            await editTg(currentChatId, msgId, text, keyboard);
        }

        if (data === 'adm_pp_usd') {
            adminStates.set(currentChatId, { action: 'await_pp_usd' });
            await editTg(currentChatId, msgId, `👑 Введите цену ПП (10000) в $:`, { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "adm_back" }]] });
        }
        if (data === 'adm_pp_markup') {
            adminStates.set(currentChatId, { action: 'await_pp_markup' });
            await editTg(currentChatId, msgId, `👑 Введите маржу ПП в ₽:`, { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "adm_back" }]] });
        }
        if (data === 'adm_ticket_usd') {
            adminStates.set(currentChatId, { action: 'await_ticket_usd' });
            await editTg(currentChatId, msgId, `🎫 Введите цену билетов (100 шт) в $:`, { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "adm_back" }]] });
        }
        if (data === 'adm_ticket_markup') {
            adminStates.set(currentChatId, { action: 'await_ticket_markup' });
            await editTg(currentChatId, msgId, `🎫 Введите маржу билетов в ₽:`, { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "adm_back" }]] });
        }
        if (data === 'adm_steam_markup') {
            adminStates.set(currentChatId, { action: 'await_steam_markup' });
            await editTg(currentChatId, msgId, `🎮 Введите наценку для Steam в процентах (например, 15):`, {
                inline_keyboard: [[{ text: "❌ Отмена", callback_data: "adm_back" }]]
            });
        }
        if (data === 'adm_psgift_markup') {
            const { data: settings } = await supabase.from('settings').select('*').single();
            const products = [
                { id: 72, label: '250 TRY' },
                { id: 73, label: '500 TRY' },
                { id: 75, label: '1000 TRY' },
                { id: 78, label: '2500 TRY' },
                { id: 117, label: '$10 USA' },
                { id: 118, label: '$25 USA' },
                { id: 119, label: '$50 USA' },
                { id: 121, label: '$100 USA' },
                { id: 106, label: '50 PLN' },
                { id: 107, label: '100 PLN' },
            ];
            let text = '🎮 <b>Наценки PSN</b>\n\n';
            const buttons = [];
            for (const p of products) {
                const key = `ps_markup_${p.id}`;
                const markup = settings?.[key] ?? 0;
                text += `${p.label} — +${markup}₽\n`;
                buttons.push([{ text: `Изменить ${p.label}`, callback_data: `ps_markup_${p.id}` }]);
            }
            buttons.push([{ text: '🔙 Назад', callback_data: 'adm_back' }]);
            await editTg(currentChatId, msgId, text, { inline_keyboard: buttons });
        }

        if (data === 'adm_prime') {
            const { data: s } = await supabase.from('settings').select('*').single();
            let text = `🎮 <b>Prime</b> (базовая цена USD + маржа ₽)\n\n`;
            if (s) {
                text += `1м: ${s.prime_1m_usd ?? '-'} USD + ${s.prime_markup_1m_rub ?? 0}₽\n`;
                text += `3м: ${s.prime_3m_usd ?? '-'} USD + ${s.prime_markup_3m_rub ?? 0}₽\n`;
                text += `6м: ${s.prime_6m_usd ?? '-'} USD + ${s.prime_markup_6m_rub ?? 0}₽\n`;
                text += `9м: ${s.prime_9m_usd ?? '-'} USD + ${s.prime_markup_9m_rub ?? 0}₽\n`;
                text += `12м: ${s.prime_12m_usd ?? '-'} USD + ${s.prime_markup_12m_rub ?? 0}₽\n\n`;
                text += `1м: ${s.prime_plus_1m_usd ?? '-'} USD + ${s.prime_plus_markup_1m_rub ?? 0}₽\n`;
                text += `3м: ${s.prime_plus_3m_usd ?? '-'} USD + ${s.prime_plus_markup_3m_rub ?? 0}₽\n`;
                text += `6м: ${s.prime_plus_6m_usd ?? '-'} USD + ${s.prime_plus_markup_6m_rub ?? 0}₽\n`;
                text += `9м: ${s.prime_plus_9m_usd ?? '-'} USD + ${s.prime_plus_markup_9m_rub ?? 0}₽\n`;
                text += `12м: ${s.prime_plus_12m_usd ?? '-'} USD + ${s.prime_plus_markup_12m_rub ?? 0}₽`;
            }
            const keyboard = {
                inline_keyboard: [
                    [{ text: "1м USD", callback_data: "adm_prime_1m_usd" }, { text: "1м маржа ₽", callback_data: "adm_prime_1m_markup" }],
                    [{ text: "3м USD", callback_data: "adm_prime_3m_usd" }, { text: "3м маржа ₽", callback_data: "adm_prime_3m_markup" }],
                    [{ text: "6м USD", callback_data: "adm_prime_6m_usd" }, { text: "6м маржа ₽", callback_data: "adm_prime_6m_markup" }],
                    [{ text: "9м USD", callback_data: "adm_prime_9m_usd" }, { text: "9м маржа ₽", callback_data: "adm_prime_9m_markup" }],
                    [{ text: "12м USD", callback_data: "adm_prime_12m_usd" }, { text: "12м маржа ₽", callback_data: "adm_prime_12m_markup" }],
                    [{ text: "Plus 1м USD", callback_data: "adm_prime_plus_1m_usd" }, { text: "Plus 1м маржа ₽", callback_data: "adm_prime_plus_1m_markup" }],
                    [{ text: "Plus 3м USD", callback_data: "adm_prime_plus_3m_usd" }, { text: "Plus 3м маржа ₽", callback_data: "adm_prime_plus_3m_markup" }],
                    [{ text: "Plus 6м USD", callback_data: "adm_prime_plus_6m_usd" }, { text: "Plus 6м маржа ₽", callback_data: "adm_prime_plus_6m_markup" }],
                    [{ text: "Plus 9м USD", callback_data: "adm_prime_plus_9m_usd" }, { text: "Plus 9м маржа ₽", callback_data: "adm_prime_plus_9m_markup" }],
                    [{ text: "Plus 12м USD", callback_data: "adm_prime_plus_12m_usd" }, { text: "Plus 12м маржа ₽", callback_data: "adm_prime_plus_12m_markup" }],
                    [{ text: "🔙 Назад", callback_data: "adm_back" }]
                ]
            };
            await editTg(currentChatId, msgId, text, keyboard);
        }

        if (data.startsWith('adm_prime_') && !data.startsWith('adm_prime_plus_')) {
            const key = data.replace('adm_prime_', '');
            if (['1m_usd', '1m_markup', '3m_usd', '3m_markup', '6m_usd', '6m_markup', '9m_usd', '9m_markup', '12m_usd', '12m_markup'].includes(key)) {
                const actionKey = `prime_${key}`;
                adminStates.set(currentChatId, { action: `await_${actionKey}` });
                const labelMap: Record<string, string> = { '1m_usd': 'Prime 1 мес USD', '1m_markup': 'Prime 1 мес маржа ₽', '3m_usd': 'Prime 3 мес USD', '3m_markup': 'Prime 3 мес маржа ₽', '6m_usd': 'Prime 6 мес USD', '6m_markup': 'Prime 6 мес маржа ₽', '9m_usd': 'Prime 9 мес USD', '9m_markup': 'Prime 9 мес маржа ₽', '12m_usd': 'Prime 12 мес USD', '12m_markup': 'Prime 12 мес маржа ₽' };
                const label = labelMap[key];
                await editTg(currentChatId, msgId, `🎮 Введите ${label}:`, { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "adm_back" }]] });
            }
        }

        if (data.startsWith('adm_prime_plus_')) {
            const key = data.replace('adm_prime_plus_', '');
            if (['1m_usd', '1m_markup', '3m_usd', '3m_markup', '6m_usd', '6m_markup', '9m_usd', '9m_markup', '12m_usd', '12m_markup'].includes(key)) {
                const actionKey = `prime_plus_${key}`;
                adminStates.set(currentChatId, { action: `await_${actionKey}` });
                const labelMap: Record<string, string> = { '1m_usd': 'Plus 1 мес USD', '1m_markup': 'Plus 1 мес маржа ₽', '3m_usd': 'Plus 3 мес USD', '3m_markup': 'Plus 3 мес маржа ₽', '6m_usd': 'Plus 6 мес USD', '6m_markup': 'Plus 6 мес маржа ₽', '9m_usd': 'Plus 9 мес USD', '9m_markup': 'Plus 9 мес маржа ₽', '12m_usd': 'Plus 12 мес USD', '12m_markup': 'Plus 12 мес маржа ₽' };
                const label = labelMap[key];
                await editTg(currentChatId, msgId, `🎮 Введите ${label}:`, { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "adm_back" }]] });
            }
        }

        if (data === 'adm_price_usd') {
            const { data: denoms } = await supabase.from('base_denominations').select('*').order('amount_uc');
            let text = `💵 <b>Базовые номиналы UC</b>\n\nСуммы для промокодов складываются из этих номиналов (60, 325, 660, 1800, 3850, 8100):`;
            const rows: any[] = [];
            if (denoms?.length) {
                denoms.forEach((d: any) => {
                    rows.push([{ text: `${d.amount_uc} UC = ${d.price_usd}$`, callback_data: `adm_price_${d.amount_uc}` }]);
                });
            }
            rows.push([{ text: "🔙 Назад", callback_data: "adm_back" }]);
            await editTg(currentChatId, msgId, text, { inline_keyboard: rows });
        }

        if (data.startsWith('adm_price_') && data !== 'adm_price_usd') {
            const uc = parseInt(data.replace('adm_price_', ''));
            if (!isNaN(uc)) {
                adminStates.set(currentChatId, { action: 'await_price_usd', uc });
                await editTg(currentChatId, msgId, `💵 Введите цену для <b>${uc} UC</b> в $:`, { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "adm_back" }]] });
            }
        }

        if (data === 'adm_list') {
            const { data: products } = await supabase.from('products').select('*').order('amount_uc');
            let m = "📊 <b>Наценки UC:</b>\n";
            products?.forEach((p: any) => m += `💎 ${p.amount_uc} UC | +${p.markup_rub}₽\n`);
            await editTg(currentChatId, msgId, m, { inline_keyboard: [[{ text: "🔙 Назад", callback_data: "adm_back" }]] });
        }

        if (data === 'admin_manage') {
            const keyboard = {
                inline_keyboard: [
                    [{ text: "💎 Удалить UC", callback_data: "m_uc" }],
                    [{ text: "🎭 Удалить Skins", callback_data: "m_skins" }],
                    [{ text: "➕Добавить временный скин", callback_data: "m_temp_skin" }],
                    [{ text: "🔙 Назад", callback_data: "adm_back" }]
                ]
            };
            await editTg(currentChatId, msgId, "🛒 <b>Управление товарами</b>\n\nВыберите категорию:", keyboard);
        }

        if (data === 'm_uc') {
            const { data: products } = await supabase.from('products').select('*').order('amount_uc');
            if (products && products.length > 0) {
                let text = "💎 Товары UC:\n";
                const keyboard: any = { inline_keyboard: [] };
                products.forEach((p: any) => {
                    text += `${p.amount_uc} UC | +${p.markup_rub}₽\n`;
                    keyboard.inline_keyboard.push([{ text: `❌ Удалить ${p.amount_uc} UC`, callback_data: `del_products_${p.id}` }]);
                });
                keyboard.inline_keyboard.push([{ text: "🔙 Назад", callback_data: "admin_manage" }]);
                await editTg(currentChatId, msgId, text, keyboard);
            } else {
                await answerCallback(callback_query.id, "Нет товаров");
            }
        }

        if (data === 'm_skins') {
            const { data: skins } = await supabase.from('skins_products').select('*').limit(15);
            if (skins && skins.length > 0) {
                let text = "🎭 Skins:\n";
                const keyboard: any = { inline_keyboard: [] };
                skins.forEach((s: any) => {
                    text += `${s.title} - ${s.price_rub}₽\n`;
                    keyboard.inline_keyboard.push([{ text: `❌ Удалить ${s.title}`, callback_data: `del_skins_products_${s.id}` }]);
                });
                keyboard.inline_keyboard.push([{ text: "🔙 Назад", callback_data: "admin_manage" }]);
                await editTg(currentChatId, msgId, text, keyboard);
            } else {
                await answerCallback(callback_query.id, "Нет товаров");
            }
        }

        if (data.startsWith('del_')) {
            const parts = data.split('_');
            let table = 'products';
            let idIndex = 2;
            if (parts[1] === 'skins' && parts[2] === 'products') {
                table = 'skins_products';
                idIndex = 3;
            } else if (parts[1] === 'products') {
                table = 'products';
                idIndex = 2;
            }
            const id = parseInt(parts[idIndex]);
            const { error } = await supabase.from(table).delete().eq('id', id);
            if (!error) {
                await editTg(currentChatId, msgId, "🗑 Товар удален.", { inline_keyboard: [] });
                await answerCallback(callback_query.id, "Удалено");
            } else {
                await answerCallback(callback_query.id, "Ошибка удаления");
            }
        }

        if (data === 'm_temp_skin') {
            adminStates.set(currentChatId, { action: 'await_temp_skin_title' });
            await editTg(currentChatId, msgId, `⏰ <b>Добавление временного скина</b>\n\nШаг 1/2: Введите название скина:`, { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "admin_manage" }]] });
        }

        if (data.startsWith('hold_')) {
            const orderId = parseInt(data.split('_')[1]);
            if (automationTimers.has(orderId)) {
                clearTimeout(automationTimers.get(orderId)!);
                automationTimers.delete(orderId);
                const t = callback_query.message.text + `\n\n🛑 <b>ПЕРЕХВАЧЕНО</b>\nДелайте вручную.`;
                const k = { inline_keyboard: [[{ text: "✅ Я выдал", callback_data: `done_${orderId}` }]] };
                await editTg(currentChatId, msgId, t, k);
                await answerCallback(callback_query.id, "Бот отменен.");
            }
        }

        if (data === 'adm_child_convert') {
            const res = await getChildTreasurySummary();
            if (!res.ok) {
                await answerCallback(callback_query.id, res.error);
                return;
            }
            const text = formatChildTreasuryMessage(res.summary);
            if (res.summary.unconvertedRub <= 0) {
                await editTg(
                    currentChatId,
                    msgId,
                    text + '\n\n<i>Нет ₽ за прошлые дни на дочернем.</i>',
                    { inline_keyboard: [[{ text: '🔙 Назад', callback_data: 'adm_back' }]] }
                );
            } else {
                adminStates.set(currentChatId, { action: 'await_child_convert_rate' });
                await editTg(
                    currentChatId,
                    msgId,
                    text +
                    '\n\n📉 Введите курс для дочернего (руб за 1 USDT).\n' +
                    '<i>Закроются все прошлые дни без курса, сегодня (МСК) не входит.</i>',
                    { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'adm_back' }]] }
                );
            }
        }

        if (data.startsWith('wdone_')) {
            if (!ADMIN_CHAT_ID.includes(currentChatId)) {
                await answerCallback(callback_query.id, 'Нет доступа');
                return;
            }
            const requestId = parseInt(data.replace('wdone_', ''), 10);
            if (!requestId) {
                await answerCallback(callback_query.id, 'Неверный ID');
                return;
            }
            const result = await completeChildWithdrawal(requestId);
            if (result.ok) {
                const prev = callback_query.message?.text || '';
                await editTg(currentChatId, msgId, prev + '\n\n✅ <b>ВЫПОЛНЕНО</b>', { inline_keyboard: [] });
                await answerCallback(callback_query.id, 'Вывод подтверждён');
            } else {
                await answerCallback(callback_query.id, result.error || 'Ошибка');
            }
        }

        if (data.startsWith('done_')) {
            const orderId = parseInt(data.split('_')[1]);
            const { data: orderData } = await supabase.from('orders').update({ status: 'completed' }).eq('id', orderId).select().single();
            if (orderData) {
                let message = '';
                if (orderData.order_type === 'pp') {
                    message = `✅ Ваш заказ на ${orderData.amount_uc} ПП выполнен! Приятной игры.`;
                } else if (orderData.order_type === 'tickets') {
                    message = `✅ Ваш заказ на ${orderData.amount_uc} билетов выполнен! Приятной игры.`;
                } else if (orderData.order_type === 'skin') {
                    message = `✅ Ваш заказ на скин "${orderData.uid_player}" выполнен! Приятной игры.`;
                } else if (orderData.order_type === 'prime') {
                    message = `✅ Ваша подписка Prime Gaming активирована! Приятной игры.`;
                } else if (orderData.order_type === 'prime_plus') {
                    message = `✅ Ваша подписка Prime Gaming Plus активирована! Приятной игры.`;
                } else {
                    message = `✅ Ваш заказ на ${orderData.amount_uc} UC выполнен! Приятной игры.`;
                }
                if (orderData.user_chat_id) await sendTg(orderData.user_chat_id, message);
                await editTg(currentChatId, msgId, callback_query.message.text + `\n\n✅ <b>ГОТОВО (ВРУЧНУЮ)</b>`, { inline_keyboard: [] });
            }
        }

        if (data.startsWith('manual_done_')) {
            const [_, __, chatId, amount] = data.split('_');
            const ucAmount = parseInt(amount);
            await sendTg(chatId, `✅ Ваш ручной заказ на ${ucAmount} UC выполнен! Приятной игры.`);
            await editTg(currentChatId, msgId, callback_query.message.text + `\n\n✅ <b>ГОТОВО (ВРУЧНУЮ)</b>`, { inline_keyboard: [] });
            await answerCallback(callback_query.id, "Уведомлено");
        }

        if (data === 'adm_profit') {
            const keyboard = {
                inline_keyboard: [
                    [{ text: "📅 За сегодня", callback_data: "profit_today" }],
                    [{ text: "📆 За неделю", callback_data: "profit_week" }],
                    [{ text: "📊 За месяц", callback_data: "profit_month" }],
                    [{ text: "📈 За прошлый месяц", callback_data: "profit_last_month" }],
                    [{ text: "🔙 Назад", callback_data: "adm_back" }]
                ]
            };
            await editTg(currentChatId, msgId, "Выберите период для просмотра прибыли:", keyboard);
        }

        if (data === 'profit_today') {
            const result = await calculateProfit(1);
            const text = `💰 <b>Прибыль за сегодня</b>\n\n💸 Всего: ${result.totalProfit}₽\n📈 Заказов: ${result.ordersCount} шт.`;
            await editTg(currentChatId, msgId, text, { inline_keyboard: [[{ text: "🔙 Назад", callback_data: "adm_profit" }]] });
        }

        if (data === 'profit_week') {
            const result = await calculateProfit(7);
            const text = `💰 <b>Прибыль за неделю</b>\n\n💸 Всего: ${result.totalProfit}₽\n📈 Заказов: ${result.ordersCount} шт.`;
            await editTg(currentChatId, msgId, text, { inline_keyboard: [[{ text: "🔙 Назад", callback_data: "adm_profit" }]] });
        }

        if (data === 'profit_month') {
            const result = await calculateProfit(30);
            const text = `💰 <b>Прибыль за месяц</b>\n\n💸 Всего: ${result.totalProfit}₽\n📈 Заказов: ${result.ordersCount} шт.`;
            await editTg(currentChatId, msgId, text, { inline_keyboard: [[{ text: "🔙 Назад", callback_data: "adm_profit" }]] });
        }

        if (data === 'profit_last_month') {
            const result = await calculateProfit(-1);
            const text = `💰 <b>Прибыль за прошлый месяц</b>\n\n💸 Всего: ${result.totalProfit}₽\n📈 Заказов: ${result.ordersCount} шт.`;
            await editTg(currentChatId, msgId, text, { inline_keyboard: [[{ text: "🔙 Назад", callback_data: "adm_profit" }]] });
        }

        if (data === 'adm_broadcasts') {
            // Получаем количество активных пользователей для рассылки
            const { data: allUsers } = await supabase
                .from('broadcast_users')
                .select('chat_id')
                .eq('is_active', true);

            const users = allUsers?.map(user => user.chat_id) || [];

            const text = `📢 <b>Рассылки</b>\n\n👥 Всего пользователей: ${users.length}`;

            const keyboard = {
                inline_keyboard: [
                    [{ text: "📝 Создать рассылку", callback_data: "broadcast_create" }],
                    [{ text: "🔙 Назад", callback_data: "adm_back" }]
                ]
            };

            await editTg(currentChatId, msgId, text, keyboard);
        }

        if (data === 'broadcast_create') {
            adminStates.set(currentChatId, { action: 'await_broadcast_message' });
            await editTg(currentChatId, msgId, `📝 <b>Создание рассылки</b>\n\nВведите текст сообщения для всем пользователям:`, {
                inline_keyboard: [[{ text: "❌ Отмена", callback_data: "adm_broadcasts" }]]
            });
        }

        if (data === 'broadcast_send_no_photo') {
            const state = adminStates.get(currentChatId);
            if (state && state.message) {
                adminStates.delete(currentChatId);
                await sendBroadcast(currentChatId, state.message, null);
            }
        }

        if (data === 'adm_activate_accounts') {
            const { error } = await supabase
                .from('midas_accounts')
                .update({ is_active: true });

            const text = error ? `❌ Ошибка активации: ${error.message}` : `✅ Все аккаунты Midasbuy активированы!`;
            await answerCallback(callback_query.id, text);
        }
    }


});

app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
});