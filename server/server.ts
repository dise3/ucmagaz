import dotenv from 'dotenv';
dotenv.config();
console.log('dotenv loaded');

import express from 'express';
import { activateSingleCode } from './activator.ts';
import axios from 'axios';
import FormData from 'form-data';
import cors from 'cors';
import { fulfillOrder } from './bot_manager.ts';
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
type AdminState = { action: string; uc?: number };
const adminStates = new Map<string, AdminState>();

// Группы продуктов для пропорционального обновления цен
const productGroups: Record<number, number[]> = {
  60: [60, 120, 180, 240],
  325: [325, 385, 445],
  660: [660, 720],
  1800: [1800, 1920, 2125, 2460],
  3850: [3850, 4510, 5650],
  8100: [8100, 9900, 11950, 16200, 24300, 32400, 40500, 81000]
};

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
    } catch (e) {}
};

// Клавиатура главного меню админ-панели
const getAdminMainKeyboard = () => ({
    inline_keyboard: [
        [{ text: "💰 Курсы", callback_data: "adm_rates" }, { text: "💎 UC/Маржа", callback_data: "adm_markup" }],
        [{ text: "📦 Коды", callback_data: "adm_codes" }, { text: "👑 ПП и билеты", callback_data: "adm_pp" }],
        [{ text: "🎮 Prime", callback_data: "adm_prime" }, { text: "💵 Базовые номиналы UC", callback_data: "adm_price_usd" }],
        [{ text: "📊 Наценки /list", callback_data: "adm_list" }, { text: "🛒 Управление товарами", callback_data: "admin_manage" }]
    ]
});

// --- API РОУТЫ ---

app.get('/', (req, res) => res.send('✅ Server is running'));

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

// 1.5. Получение товаров Prime (Prime и Prime Plus) с расчетом по месячным ценам в USD
app.get('/api/prime-prices', async (req, res) => {
    try {
        const { data: settings } = await supabase.from('settings').select('*').single();
        
        if (!settings) return res.status(500).json({ error: 'DB Data not found' });

        const usdRate = settings.usd_rate_store;
        
        const primeProducts = [
            {
                id: 'prime',
                title: 'Prime',
                periods: [
                    { months: 1, price: Math.ceil((Number(settings.prime_1m_usd) || 2.99) * usdRate) + (Number(settings.prime_markup_1m_rub) || 0) },
                    { months: 3, price: Math.ceil((Number(settings.prime_3m_usd) || 8.99) * usdRate) + (Number(settings.prime_markup_3m_rub) || 0) },
                    { months: 6, price: Math.ceil((Number(settings.prime_6m_usd) || 16.99) * usdRate) + (Number(settings.prime_markup_6m_rub) || 0) },
                    { months: 12, price: Math.ceil((Number(settings.prime_12m_usd) || 24.99) * usdRate) + (Number(settings.prime_markup_12m_rub) || 0) }
                ],
                image_url: '/prime.jpg',
                description: 'Prime Gaming подписка'
            },
            {
                id: 'prime_plus',
                title: 'Prime Plus',
                periods: [
                    { months: 1, price: Math.ceil((Number(settings.prime_plus_1m_usd) || 4.99) * usdRate) + (Number(settings.prime_plus_markup_1m_rub) || 0) },
                    { months: 3, price: Math.ceil((Number(settings.prime_plus_3m_usd) || 14.99) * usdRate) + (Number(settings.prime_plus_markup_3m_rub) || 0) },
                    { months: 6, price: Math.ceil((Number(settings.prime_plus_6m_usd) || 25.99) * usdRate) + (Number(settings.prime_plus_markup_6m_rub) || 0) },
                    { months: 12, price: Math.ceil((Number(settings.prime_plus_12m_usd) || 39.99) * usdRate) + (Number(settings.prime_plus_markup_12m_rub) || 0) }
                ],
                image_url: '/prime-plus.jpg',
                description: 'Prime Gaming Plus подписка'
            }
        ];
        res.json(primeProducts);
    } catch (e) { res.status(500).json({ error: 'Internal Error' }); }
});

// 2. Получение товаров UC с расчетом цены
app.get('/api/products', async (req, res) => {
    try {
        const { store } = req.query; // 'store' или 'promo'
        const { data: settings } = await supabase.from('settings').select('*').single();
        const { data: products } = await supabase.from('products').select('*').order('sort_order');
        
        if (!settings || !products) return res.status(500).json({ error: 'DB Data not found' });

        const usdRate = store === 'promo' ? settings.usd_rate_promo : settings.usd_rate_store;

        const list = products.map(p => {
            // Прямой расчет: (цена_в_USD * курс) + наценка + комиссия
            const basePrice = (p.price_usd * usdRate) + (p.markup_rub || 0);
            const finalPrice = store === 'promo' 
                ? Math.ceil(basePrice)  // промо без комиссии
                : Math.ceil(basePrice * (1 + settings.fee_percent));  // store с комиссией
            
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

// 3. ПОЛУЧЕНИЕ ПРОМОКОДОВ (считаются из реальных кодов в наличии)
app.get('/api/promo-products', async (req, res) => {
    try {
        const { data: settings } = await supabase.from('settings').select('*').single();
        const { data: products } = await supabase.from('products').select('*').order('sort_order');
        const { data: stock } = await supabase.from('codes_stock').select('value').eq('is_used', false);
        
        if (!settings || !products || !stock) return res.status(500).json({ error: 'Data not found' });

        // Группируем коды по номиналам
        const counts: Record<number, number> = {};
        stock.forEach((s: any) => counts[s.value] = (counts[s.value] || 0) + 1);

        const usdRate = settings.usd_rate_promo;
        
        // Создаем товары только для тех номиналов, которые есть в наличии
        const list = Object.entries(counts)
            .map(([val, count]) => {
                const amount = parseInt(val);
                
                // Ищем товар в таблице products по amount_uc
                const product = products.find((p: any) => p.amount_uc === amount);
                
                if (!product) return null;
                
                // Используем цену из products таблицы, считаем по курсу promo
                const basePrice = (product.price_usd * usdRate) + (product.markup_rub || 0);
                const finalPrice = Math.ceil(basePrice * (1 + settings.fee_percent));
                
                return {
                    id: amount,
                    amount_uc: amount,
                    price: finalPrice,
                    image_url: product.image_url || '/1.png',
                    stock_count: count
                };
            })
            .filter(item => item !== null);
            
        res.json(list);
    } catch (e) { res.status(500).json({ error: 'Internal Error' }); }
});

// 4. Создание платежа
app.post('/api/create-payment', async (req, res) => {
    try {
        const { uid, amount, price, method_slug, user_chat_id, is_code, type } = req.body;

        const { data: order, error } = await supabase
            .from('orders')
            .insert([{ 
                uid_player: uid || 'PROMOCODE', 
                amount_uc: amount, 
                price_rub: price, 
                status: 'pending', 
                user_chat_id,
                is_code_order: !!is_code, 
                order_type: type || 'uc' 
            }])
            .select().single();
        
        if (error) throw error;

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
        } else {
            description = is_code ? `Покупка кода на ${amount} UC` : `Пополнение ${amount} UC для ID: ${uid}`;
        }

        const paymentData = {
            method_slug: method_slug || 'sbp',
            amount: Number(price),
            description: description,
            metadata: { order_id: order.id },
            notification_url: `${BACKEND_URL}/api/payment-callback`
        };

        const response = await axios.post('https://codeepay.ru/initiate_payment', paymentData, {
            headers: { 'X-Api-Key': process.env.CODEEPAY_API_KEY }
        });

        await supabase.from('orders').update({ payment_id: response.data.order_id }).eq('id', order.id);
        res.json({ url: response.data.url, order_id: order.id });

    } catch (e: any) { 
        console.error('Payment Error:', e.message); 
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
    try {
        const { status, metadata, final_amount, commission_amount } = req.body;
        const orderId = metadata?.order_id;

        if (orderId && (status === 'paid' || status === 'completed')) {
            const { data: order } = await supabase
                .from('orders')
                .update({ status: 'paid', final_amount, commission_amount })
                .eq('id', orderId)
                .select()
                .single();

            if (!order) return res.status(404).send('Not Found');
            res.status(200).send('OK');

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
                    const userInfo = await getUserInfo(order.user_chat_id);
                    const username = userInfo.username ? `@${userInfo.username}` : `${userInfo.first_name} ${userInfo.last_name}`.trim();
                    await sendTg(ADMIN_CHAT_ID, `✅ Код на ${order.amount_uc} UC выдан автоматически (Заказ #${order.id}) для ${username}`);
                    await supabase.from('orders').update({ status: 'completed' }).eq('id', order.id);
                } else {
                    const userInfo = await getUserInfo(order.user_chat_id);
                    const username = userInfo.username ? `@${userInfo.username}` : `${userInfo.first_name} ${userInfo.last_name}`.trim();
                    await sendTg(ADMIN_CHAT_ID, `⚠️ <b>НЕТ КОДОВ!</b> Заказ #${order.id} на ${order.amount_uc} UC для ${username}. Выдайте вручную!`);
                }
                return;
            }

            if (order.amount_uc < 1800 && order.order_type === 'uc') {
                const userInfo = await getUserInfo(order.user_chat_id);
                const username = userInfo.username ? `@${userInfo.username}` : `${userInfo.first_name} ${userInfo.last_name}`.trim();
                const adminMsg = `⏳ <b>ОПЛАЧЕНО #${order.id}</b>\n\n👤 <b>${username}</b>\n🆔 UID: <code>${order.uid_player}</code>\n💎 Сумма: <b>${order.amount_uc} UC</b>\n💵 Руб: ${order.price_rub}\n\n🤖 <i>Авто-выдача через 2 минуты.</i>`;
                const keyboard = {
                    inline_keyboard: [[{ text: "✋ Взять на себя (Отменить бота)", callback_data: `hold_${order.id}` }]]
                };

                await sendTg(ADMIN_CHAT_ID, adminMsg, keyboard);
                await sendTg(order.user_chat_id, `💳 <b>Оплата прошла успешно!</b>\n\n💎 <b>${order.amount_uc} UC</b> будут выданы автоматически в течение 5-15 минут на UID: <code>${order.uid_player}</code>\n\nЕсли возникнут вопросы, пишите в поддержку.`);

                const timer = setTimeout(async () => {
                    automationTimers.delete(order.id);
                    await sendTg(ADMIN_CHAT_ID, `🤖 Запускаю авто-выдачу заказа #${order.id}...`);
                    try { 
                        await fulfillOrder(order.id, order.uid_player, order.amount_uc, order.user_chat_id); 
                    } catch (e) { 
                        await sendTg(ADMIN_CHAT_ID, `❌ Ошибка бота в заказе #${order.id}`); 
                    }
                }, 2 * 60 * 1000); 
                
                automationTimers.set(order.id, timer);
            } else if (order.order_type === 'pp' || order.order_type === 'tickets' || order.order_type === 'skin' || order.order_type === 'prime' || order.order_type === 'prime_plus') {
                const userInfo = await getUserInfo(order.user_chat_id);
                const username = userInfo.username ? `@${userInfo.username}` : `${userInfo.first_name} ${userInfo.last_name}`.trim();
                const item = order.order_type === 'pp' ? 'ПП' : order.order_type === 'tickets' ? 'билетов' : order.order_type === 'skin' ? 'скина' : order.order_type === 'prime' ? 'Prime' : 'Prime Plus';
                const adminMsg = `💰 <b>ЗАКАЗ ${item.toUpperCase()} #${order.id}</b>\n\n👤 <b>${username}</b>\n${order.order_type === 'skin' ? `🎭 Скин: <code>${order.uid_player}</code>\n` : `🆔 UID: <code>${order.uid_player}</code>\n👑 Сумма: <b>${order.amount_uc} ${item}</b>\n`}💵 Руб: ${order.price_rub}`;
                const keyboard = { inline_keyboard: [[{ text: "✅ Выдал (Уведомить)", callback_data: `done_${order.id}` }]] };
                await sendTg(ADMIN_CHAT_ID, adminMsg, keyboard);

                const userMsg = order.order_type === 'skin' ? `🎭 <b>Ваш скин будет выдан вручную в ближайшее время.</b>\n\nЕсли возникнут вопросы, пишите в поддержку.` : order.order_type === 'prime' || order.order_type === 'prime_plus' ? `🎮 <b>Ваша подписка ${item} будет активирована вручную в ближайшее время.</b>\n\nЕсли возникнут вопросы, пишите в поддержку.` : `👑 <b>${order.amount_uc} ${item}</b> будут выданы вручную в ближайшее время.\n\nЕсли возникнут вопросы, пишите в поддержку.`;
                await sendTg(order.user_chat_id, userMsg);
            } else {
                const userInfo = await getUserInfo(order.user_chat_id);
                const username = userInfo.username ? `@${userInfo.username}` : `${userInfo.first_name} ${userInfo.last_name}`.trim();
                const adminMsg = `💰 <b>КРУПНЫЙ ЗАКАЗ #${order.id}</b>\n\n👤 <b>${username}</b>\n🆔 UID: <code>${order.uid_player}</code>\n💎 Сумма: ${order.amount_uc} UC`;
                const keyboard = { inline_keyboard: [[{ text: "✅ Выдал (Уведомить)", callback_data: `done_${order.id}` }]] };
                await sendTg(ADMIN_CHAT_ID, adminMsg, keyboard);
                await sendTg(order.user_chat_id, `💳 <b>Оплата прошла успешно!</b>\n\n💎 <b>${order.amount_uc} UC</b> будут выданы вручную в ближайшее время на UID: <code>${order.uid_player}</code>\n\nЕсли возникнут вопросы, пишите в поддержку.`);
            }
        } else {
            res.status(200).send('OK');
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

        if (ADMIN_CHAT_ID.includes(chatId)) {
            // Обработка ввода в режиме ожидания (кнопочная панель)
            const state = adminStates.get(chatId);
            if (state) {
                adminStates.delete(chatId);
                if (state.action === 'await_курс_store') {
                    const rate = parseFloat(text.trim());
                    if (!isNaN(rate)) {
                        const { error } = await supabase.from('settings').update({ usd_rate_store: rate }).eq('id', 1);
                        await sendTg(chatId, error ? `❌ Ошибка` : `📉 Курс Store: ${rate} руб/$`, getAdminMainKeyboard());
                    } else await sendTg(chatId, '❌ Введите число');
                    return;
                }
                if (state.action === 'await_курс_promo') {
                    const rate = parseFloat(text.trim());
                    if (!isNaN(rate)) {
                        const { error } = await supabase.from('settings').update({ usd_rate_promo: rate }).eq('id', 1);
                        await sendTg(chatId, error ? `❌ Ошибка` : `📉 Курс Promo: ${rate} руб/$`, getAdminMainKeyboard());
                    } else await sendTg(chatId, '❌ Введите число');
                    return;
                }
                if (state.action === 'await_маржа' && state.uc !== undefined) {
                    const val = parseInt(text.trim());
                    if (!isNaN(val)) {
                        const { error } = await supabase.from('products').update({ markup_rub: val }).eq('amount_uc', state.uc);
                        await sendTg(chatId, error ? `❌ Ошибка` : `✅ Маржа ${state.uc} UC = ${val}₽`, getAdminMainKeyboard());
                    } else await sendTg(chatId, '❌ Введите число');
                    return;
                }
                if (state.action === 'await_код') {
                    const codes = parseMultipleCodes(text.trim());
                    if (codes.length > 0) {
                        const rows = codes.map(c => ({ value: c.uc, code: c.code, is_used: false }));
                        const { error } = await supabase.from('codes_stock').insert(rows);
                        const msg = error ? `❌ Ошибка БД` : `✅ Добавлено кодов: ${codes.length}`;
                        await sendTg(chatId, msg, getAdminMainKeyboard());
                    } else {
                        await sendTg(chatId, '❌ Формат: UC пробел КОД — можно несколько через пробел или с новой строки\n\nПример: <code>325 ABC123 120 DEF456</code>\nИли:\n<code>325 ABC123\n120 DEF456</code>', getAdminMainKeyboard());
                    }
                    return;
                }
                if (state.action === 'await_код_batch' && state.uc !== undefined) {
                    const codes = text.trim().split(/\s+/).filter(s => s.length > 0);
                    if (codes.length > 0) {
                        const rows = codes.map(code => ({ value: state.uc!, code, is_used: false }));
                        const { error } = await supabase.from('codes_stock').insert(rows);
                        const msg = error ? `❌ Ошибка БД` : `✅ Добавлено ${codes.length} кодов на ${state.uc} UC`;
                        await sendTg(chatId, msg, getAdminMainKeyboard());
                    } else {
                        await sendTg(chatId, '❌ Введите хотя бы один код', getAdminMainKeyboard());
                    }
                    return;
                }
                if (state.action === 'await_price_usd' && state.uc !== undefined) {
                    const price = parseFloat(text.trim());
                    if (!isNaN(price) && price >= 0) {
                        const group = productGroups[state.uc];
                        if (group) {
                            // Получить текущую цену базового
                            const { data: currentBase } = await supabase
                                .from('products')
                                .select('price_usd')
                                .eq('amount_uc', state.uc)
                                .single();
                            const currentBasePrice = currentBase?.price_usd;
                            if (currentBasePrice && currentBasePrice > 0) {
                                // Обновить базовый
                                await supabase
                                    .from('products')
                                    .update({ price_usd: price })
                                    .eq('amount_uc', state.uc);
                            // Получить текущие цены 60 и 120 для комбинаций
                            const { data: current60 } = await supabase
                                .from('products')
                                .select('price_usd')
                                .eq('amount_uc', 60)
                                .single();
                            const currentPrice60 = current60?.price_usd || 0;
                            const { data: current120 } = await supabase
                                .from('products')
                                .select('price_usd')
                                .eq('amount_uc', 120)
                                .single();
                            const currentPrice120 = current120?.price_usd || 0;
                            // Обновить группу пропорционально
                            for (const uc of group) {
                                if (uc === state.uc) continue;
                                const { data: currentProd } = await supabase
                                    .from('products')
                                    .select('price_usd')
                                    .eq('amount_uc', uc)
                                    .single();
                                if (currentProd) {
                                    let multiplier: number;
                                    if (state.uc === 325 && uc === 385) {
                                        // 385 = 325 + 60
                                        multiplier = 1 + (currentPrice60 / price);
                                    } else if (state.uc === 325 && uc === 445) {
                                        // 445 = 325 + 120
                                        multiplier = 1 + (currentPrice120 / price);
                                    } else if (state.uc === 660 && uc === 720) {
                                        // 720 = 660 + 60
                                        multiplier = 1 + (currentPrice60 / price);
                                    } else {
                                        multiplier = uc / state.uc;
                                    }
                                    const newPrice = multiplier * price;
                                    await supabase
                                        .from('products')
                                        .update({ price_usd: newPrice })
                                        .eq('amount_uc', uc);
                                }
                            }
                                await sendTg(chatId, `✅ Цена обновлена для группы ${state.uc} UC`, getAdminMainKeyboard());
                            } else {
                                await sendTg(chatId, '❌ Ошибка: базовая цена не найдена');
                            }
                        } else {
                            // Если не базовый, обновить только этот
                            const { error } = await supabase
                                .from('products')
                                .update({ price_usd: price })
                                .eq('amount_uc', state.uc);
                            await sendTg(chatId, error ? `❌ Ошибка` : `✅ ${state.uc} UC = ${price}$`, getAdminMainKeyboard());
                        }
                    } else {
                        await sendTg(chatId, '❌ Введите число');
                    }
                    return;
                }
                if (state.action === 'await_pp_markup') {
                    const markup = parseInt(text.trim());
                    if (!isNaN(markup)) {
                        await supabase.from('settings').update({ pp_markup_rub: markup }).eq('id', 1);
                        await sendTg(chatId, `👑 Маржа ПП: ${markup}₽`, getAdminMainKeyboard());
                    } else await sendTg(chatId, '❌ Введите число');
                    return;
                }
                if (state.action === 'await_pp_usd') {
                    const price = parseFloat(text.trim());
                    if (!isNaN(price)) {
                        await supabase.from('settings').update({ pp_price_usd: price }).eq('id', 1);
                        await sendTg(chatId, `👑 ПП (10000): ${price}$`, getAdminMainKeyboard());
                    } else await sendTg(chatId, '❌ Введите число');
                    return;
                }
                if (state.action === 'await_ticket_usd') {
                    const price = parseFloat(text.trim());
                    if (!isNaN(price)) {
                        await supabase.from('settings').update({ ticket_price_usd: price }).eq('id', 1);
                        await sendTg(chatId, `🎫 Билеты (100): ${price}$`, getAdminMainKeyboard());
                    } else await sendTg(chatId, '❌ Введите число');
                    return;
                }
                if (state.action === 'await_ticket_markup') {
                    const markup = parseInt(text.trim());
                    if (!isNaN(markup)) {
                        await supabase.from('settings').update({ ticket_markup_rub: markup }).eq('id', 1);
                        await sendTg(chatId, `🎫 Маржа билетов: ${markup}₽`, getAdminMainKeyboard());
                    } else await sendTg(chatId, '❌ Введите число');
                    return;
                }
                if (state.action.startsWith('await_prime_')) {
                    const key = state.action.replace('await_', '');
                    const val = parseFloat(text.trim());
                    if (!isNaN(val)) {
                        const fieldMap: Record<string, string> = {
                            'prime_markup': 'prime_markup_rub', 'prime_plus_markup': 'prime_plus_markup_rub',
                            'prime_1m': 'prime_1m_usd', 'prime_3m': 'prime_3m_usd', 'prime_6m': 'prime_6m_usd', 'prime_12m': 'prime_12m_usd',
                            'prime_plus_1m': 'prime_plus_1m_usd', 'prime_plus_3m': 'prime_plus_3m_usd', 'prime_plus_6m': 'prime_plus_6m_usd', 'prime_plus_12m': 'prime_plus_12m_usd',
                            'prime_markup_1m': 'prime_markup_1m_rub', 'prime_markup_3m': 'prime_markup_3m_rub', 'prime_markup_6m': 'prime_markup_6m_rub', 'prime_markup_12m': 'prime_markup_12m_rub',
                            'prime_plus_markup_1m': 'prime_plus_markup_1m_rub', 'prime_plus_markup_3m': 'prime_plus_markup_3m_rub', 'prime_plus_markup_6m': 'prime_plus_markup_6m_rub', 'prime_plus_markup_12m': 'prime_plus_markup_12m_rub'
                        };
                        const field = fieldMap[key];
                        if (field) {
                            await supabase.from('settings').update({ [field]: val }).eq('id', 1);
                            await sendTg(chatId, `✅ Обновлено`, getAdminMainKeyboard());
                        }
                    } else await sendTg(chatId, '❌ Введите число');
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
                    const { error } = await supabase.from('products').update({ price_usd: price }).eq('amount_uc', uc);
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

            if (text.toLowerCase().startsWith('prime_markup ')) {
                const markup = parseInt(text.split(' ')[1]);
                await supabase.from('settings').update({ prime_markup_rub: markup }).eq('id', 1);
                await sendTg(chatId, `🎮 Маржа Prime: ${markup}₽`);
            }

            if (text.toLowerCase().startsWith('prime_plus_markup ')) {
                const markup = parseInt(text.split(' ')[1]);
                await supabase.from('settings').update({ prime_plus_markup_rub: markup }).eq('id', 1);
                await sendTg(chatId, `🎮 Маржа Prime Plus: ${markup}₽`);
            }

            // Команды для цен периодов Prime (в USD)
            if (text.toLowerCase().startsWith('prime_1m ')) {
                const price = parseFloat(text.split(' ')[1]);
                await supabase.from('settings').update({ prime_1m_usd: price }).eq('id', 1);
                await sendTg(chatId, `🎮 Prime 1 мес: ${price}$`);
            }

            if (text.toLowerCase().startsWith('prime_3m ')) {
                const price = parseFloat(text.split(' ')[1]);
                await supabase.from('settings').update({ prime_3m_usd: price }).eq('id', 1);
                await sendTg(chatId, `🎮 Prime 3 мес: ${price}$`);
            }

            if (text.toLowerCase().startsWith('prime_6m ')) {
                const price = parseFloat(text.split(' ')[1]);
                await supabase.from('settings').update({ prime_6m_usd: price }).eq('id', 1);
                await sendTg(chatId, `🎮 Prime 6 мес: ${price}$`);
            }

            if (text.toLowerCase().startsWith('prime_12m ')) {
                const price = parseFloat(text.split(' ')[1]);
                await supabase.from('settings').update({ prime_12m_usd: price }).eq('id', 1);
                await sendTg(chatId, `🎮 Prime 12 мес: ${price}$`);
            }

            if (text.toLowerCase().startsWith('prime_plus_1m ')) {
                const price = parseFloat(text.split(' ')[1]);
                await supabase.from('settings').update({ prime_plus_1m_usd: price }).eq('id', 1);
                await sendTg(chatId, `🎮 Prime Plus 1 мес: ${price}$`);
            }

            if (text.toLowerCase().startsWith('prime_plus_3m ')) {
                const price = parseFloat(text.split(' ')[1]);
                await supabase.from('settings').update({ prime_plus_3m_usd: price }).eq('id', 1);
                await sendTg(chatId, `🎮 Prime Plus 3 мес: ${price}$`);
            }

            if (text.toLowerCase().startsWith('prime_plus_6m ')) {
                const price = parseFloat(text.split(' ')[1]);
                await supabase.from('settings').update({ prime_plus_6m_usd: price }).eq('id', 1);
                await sendTg(chatId, `🎮 Prime Plus 6 мес: ${price}$`);
            }

            if (text.toLowerCase().startsWith('prime_plus_12m ')) {
                const price = parseFloat(text.split(' ')[1]);
                await supabase.from('settings').update({ prime_plus_12m_usd: price }).eq('id', 1);
                await sendTg(chatId, `🎮 Prime Plus 12 мес: ${price}$`);
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
if (message && message.photo && message.caption) {
    const currentChatId = message.chat.id.toString();
    if (ADMIN_CHAT_ID.includes(currentChatId)) {
        const caption = message.caption.trim();
        if (caption.toLowerCase().startsWith('скин ')) {
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
            const { data: baseDenoms } = await supabase.from('base_denominations').select('amount_uc').order('amount_uc');
            const ucList = baseDenoms?.map((d: any) => d.amount_uc) ?? [60, 325, 660, 1800, 3850, 8100];
            const ucButtons = ucList.map((uc: number) => ({ text: `${uc} UC`, callback_data: `adm_код_batch_${uc}` }));
            const text = `📦 <b>Коды</b>\n\n<b>Выберите номинал</b> — затем вставьте коды (по одному в строке или через пробел):`;
            const keyboard = {
                inline_keyboard: [
                    ucButtons.slice(0, 4),
                    ucButtons.slice(4, 8),
                    [{ text: "➕ Разные номиналы (UC КОД UC КОД...)", callback_data: "adm_код" }],
                    [{ text: "🔓 Освободить RESERVED", callback_data: "adm_освободить" }],
                    [{ text: "🔙 Назад", callback_data: "adm_back" }]
                ]
            };
            await editTg(currentChatId, msgId, text, keyboard);
        }

        if (data.startsWith('adm_код_batch_')) {
            const uc = parseInt(data.replace('adm_код_batch_', ''));
            if (!isNaN(uc)) {
                adminStates.set(currentChatId, { action: 'await_код_batch', uc });
                await editTg(currentChatId, msgId, `📦 <b>${uc} UC</b> — вставьте коды одним сообщением:\n\nПо одному в строке или через пробел. Например:\n<code>CODE1\nCODE2\nCODE3</code>\n\nили <code>CODE1 CODE2 CODE3</code>`, { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "adm_codes" }]] });
            }
        }

        if (data === 'adm_код') {
            adminStates.set(currentChatId, { action: 'await_код' });
            await editTg(currentChatId, msgId, `📦 Введите коды (можно несколько номиналов):\n\n<b>Формат:</b> UC пробел КОД\n<code>325 ABC123 120 DEF456</code>`, { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "adm_back" }]] });
        }

        if (data === 'adm_освободить') {
            const { error } = await supabase.from('codes_stock').update({ is_used: false, status: null }).eq('status', 'RESERVED');
            await answerCallback(callback_query.id, error ? "Ошибка" : "Освобождено");
            const text = `📦 <b>Коды</b>\n\n${error ? '❌ Ошибка' : '✅ RESERVED коды освобождены'}`;
            const keyboard = {
                inline_keyboard: [
                    [{ text: "➕ Добавить код", callback_data: "adm_код" }],
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

        if (data === 'adm_prime') {
            const { data: s } = await supabase.from('settings').select('*').single();
            let text = `🎮 <b>Prime</b> (цена в USD + наценка по месяцам)\n\n`;
            if (s) {
                text += `Prime: маржа +${s.prime_markup_rub ?? 0}₽\n`;
                text += `1м: ${s.prime_1m_usd ?? '-'}$ (+${s.prime_markup_1m_rub ?? 0}₽) | 3м: ${s.prime_3m_usd ?? '-'}$ (+${s.prime_markup_3m_rub ?? 0}₽)\n`;
                text += `6м: ${s.prime_6m_usd ?? '-'}$ (+${s.prime_markup_6m_rub ?? 0}₽) | 12м: ${s.prime_12m_usd ?? '-'}$ (+${s.prime_markup_12m_rub ?? 0}₽)\n\n`;
                text += `Prime Plus: маржа +${s.prime_plus_markup_rub ?? 0}₽\n`;
                text += `1м: ${s.prime_plus_1m_usd ?? '-'}$ (+${s.prime_plus_markup_1m_rub ?? 0}₽) | 3м: ${s.prime_plus_3m_usd ?? '-'}$ (+${s.prime_plus_markup_3m_rub ?? 0}₽)\n`;
                text += `6м: ${s.prime_plus_6m_usd ?? '-'}$ (+${s.prime_plus_markup_6m_rub ?? 0}₽) | 12м: ${s.prime_plus_12m_usd ?? '-'}$ (+${s.prime_plus_markup_12m_rub ?? 0}₽)`;
            }
            const keyboard = {
                inline_keyboard: [
                    [{ text: "1м цена $", callback_data: "adm_prime_1m" }, { text: "1м наценка ₽", callback_data: "adm_prime_markup_1m" }],
                    [{ text: "3м цена $", callback_data: "adm_prime_3m" }, { text: "3м наценка ₽", callback_data: "adm_prime_markup_3m" }],
                    [{ text: "6м цена $", callback_data: "adm_prime_6m" }, { text: "6м наценка ₽", callback_data: "adm_prime_markup_6m" }],
                    [{ text: "12м цена $", callback_data: "adm_prime_12m" }, { text: "12м наценка ₽", callback_data: "adm_prime_markup_12m" }],
                    [{ text: "Plus 1м цена $", callback_data: "adm_prime_plus_1m" }, { text: "Plus 1м наценка ₽", callback_data: "adm_prime_plus_markup_1m" }],
                    [{ text: "Plus 3м цена $", callback_data: "adm_prime_plus_3m" }, { text: "Plus 3м наценка ₽", callback_data: "adm_prime_plus_markup_3m" }],
                    [{ text: "Plus 6м цена $", callback_data: "adm_prime_plus_6m" }, { text: "Plus 6м наценка ₽", callback_data: "adm_prime_plus_markup_6m" }],
                    [{ text: "Plus 12м цена $", callback_data: "adm_prime_plus_12m" }, { text: "Plus 12м наценка ₽", callback_data: "adm_prime_plus_markup_12m" }],
                    [{ text: "🔙 Назад", callback_data: "adm_back" }]
                ]
            };
            await editTg(currentChatId, msgId, text, keyboard);
        }

        if (data.startsWith('adm_prime_') && !data.startsWith('adm_prime_plus_')) {
            const key = data.replace('adm_prime_', '');
            if (['markup', '1m', '3m', '6m', '12m'].includes(key)) {
                const actionKey = key === 'markup' ? 'prime_markup' : `prime_${key}`;
                adminStates.set(currentChatId, { action: `await_${actionKey}` });
                const label = key === 'markup' 
                    ? 'Prime маржа ₽' 
                    : `Prime ${key} $`;
                await editTg(currentChatId, msgId, `🎮 Введите ${label}:`, { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "adm_back" }]] });
            }
        }

        // Обработка наценок по месяцам для Prime
        if (data.startsWith('adm_prime_markup_')) {
            const month = data.replace('adm_prime_markup_', '');
            if (['1m', '3m', '6m', '12m'].includes(month)) {
                adminStates.set(currentChatId, { action: `await_prime_markup_${month}` });
                await editTg(currentChatId, msgId, `🎮 Введите наценку Prime ${month} в ₽:`, { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "adm_prime" }]] });
            }
        }

        if (data.startsWith('adm_prime_plus_')) {
            const key = data.replace('adm_prime_plus_', '');
            if (['markup', '1m', '3m', '6m', '12m'].includes(key)) {
                const actionKey = key === 'markup' ? 'prime_plus_markup' : `prime_plus_${key}`;
                adminStates.set(currentChatId, { action: `await_${actionKey}` });
                const label = key === 'markup' 
                    ? 'Prime Plus маржа ₽' 
                    : `Plus ${key} $`;
                await editTg(currentChatId, msgId, `🎮 Введите ${label}:`, { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "adm_back" }]] });
            }
        }

        // Обработка наценок по месяцам для Prime Plus
        if (data.startsWith('adm_prime_plus_markup_')) {
            const month = data.replace('adm_prime_plus_markup_', '');
            if (['1m', '3m', '6m', '12m'].includes(month)) {
                adminStates.set(currentChatId, { action: `await_prime_plus_markup_${month}` });
                await editTg(currentChatId, msgId, `🎮 Введите наценку Prime Plus ${month} в ₽:`, { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "adm_prime" }]] });
            }
        }

        if (data === 'adm_price_usd') {
            const { data: products } = await supabase.from('products').select('*').order('amount_uc');
            let text = `💵 <b>Цены товаров (в USD)</b>\n\nВыберите номинал:`;
            const rows: any[] = [];
            if (products?.length) {
                products.forEach((p: any) => {
                    rows.push([{ text: `${p.amount_uc} UC = ${p.price_usd}$`, callback_data: `adm_price_${p.amount_uc}` }]);
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
                    [{ text: "💎 UC", callback_data: "m_uc" }],
                    [{ text: "🎭 Skins", callback_data: "m_skins" }],
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
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
});