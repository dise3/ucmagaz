import dotenv from 'dotenv';
dotenv.config({ path: '../.env' });
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

const answerCallback = async (queryId: string, text: string) => {
    try {
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
            callback_query_id: queryId, 
            text: text
        });
    } catch (e) {}
};

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

// 1.5. Получение товаров Prime (Prime и Prime Plus)
app.get('/api/prime-prices', async (req, res) => {
    try {
        const { store } = req.query; // 'store' или 'promo'
        const { data: settings } = await supabase.from('settings').select('*').single();
        
        if (!settings) return res.status(500).json({ error: 'DB Data not found' });

        const usdRate = store === 'promo' ? settings.usd_rate_promo : settings.usd_rate_store;

        // Расчет цен для Prime (без комиссии, как скины)
        const primeBasePrice = (settings.prime_price_usd || 0.05) * usdRate + (settings.prime_markup_rub || 0);
        const primeFinalPrice = Math.ceil(primeBasePrice);
        
        // Расчет цен для Prime Plus (без комиссии, как скины)
        const primePlusBasePrice = (settings.prime_plus_price_usd || 0.08) * usdRate + (settings.prime_plus_markup_rub || 0);
        const primePlusFinalPrice = Math.ceil(primePlusBasePrice);

        const primeProducts = [
            {
                id: 'prime',
                title: 'Prime',
                price: primeFinalPrice,
                image_url: '/prime.jpg',
                description: 'Prime Gaming подписка на месяц'
            },
            {
                id: 'prime_plus',
                title: 'Prime Plus',
                price: primePlusFinalPrice,
                image_url: '/prime-plus.jpg',
                description: 'Prime Gaming Plus подписка на месяц'
            }
        ];
        
        res.json(primeProducts);
    } catch (e) { res.status(500).json({ error: 'Internal Error' }); }
});

// 2. Получение товаров (UC по ID)
app.get('/api/products', async (req, res) => {
    try {
        const { store } = req.query; // 'store' или 'promo'
        const { data: settings } = await supabase.from('settings').select('*').single();
        const { data: products } = await supabase.from('products').select('*').order('sort_order');
        
        if (!settings || !products) return res.status(500).json({ error: 'DB Data not found' });

        const usdRate = store === 'promo' ? settings.usd_rate_promo : settings.usd_rate_store;

        const list = products.map(p => {
            const productMarkup = p.markup_rub || 0;
            const finalPrice = Math.ceil(((p.price_usd * usdRate) + productMarkup) * (1 + settings.fee_percent));
            
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

        const list = Object.keys(counts).map(val => {
            const amount = parseInt(val);
            const finalPrice = Math.ceil(((amount / 60 * settings.usd_rate) + 100) * (1 + settings.fee_percent));
            
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

// 6. Получение цен на PP, билеты и Prime товары
app.get('/api/prime-prices', async (req, res) => {
    try {
        const { data: settings } = await supabase.from('settings').select('*').single();
        if (!settings) return res.status(500).json({ error: 'Settings not found' });

        const COMMISSION_SBP = 0.052;
        const COMMISSION_CARD = 0.0745;

        const getBasePrice = (amount: number, type: string) => {
            if (type === 'pp') return (settings.pp_price_usd || 0) * (amount / 10000);
            if (type === 'tickets') return (settings.ticket_price_usd || 0) * (amount / 100);
            if (type === 'prime') return settings.prime_price_usd || 0.05;
            if (type === 'prime_plus') return settings.prime_plus_price_usd || 0.08;
            return 0;
        };

        const calculatePriceWithCommission = (basePrice: number, commissionRate: number) => Math.ceil(basePrice * (1 + commissionRate));

        const primeBase = getBasePrice(10000, 'pp') * settings.usd_rate + (settings.pp_markup_rub || 0);
        const ticketBase = getBasePrice(100, 'tickets') * settings.usd_rate + (settings.ticket_markup_rub || 0);
        const primeBasePrice = getBasePrice(1, 'prime') * settings.usd_rate + (settings.prime_markup_rub || 0);
        const primePlusBasePrice = getBasePrice(1, 'prime_plus') * settings.usd_rate + (settings.prime_plus_markup_rub || 0);

        res.json({
            prime_prices: [{ amount: 10000, price_rub_sbp: calculatePriceWithCommission(primeBase, COMMISSION_SBP), price_rub_card: calculatePriceWithCommission(primeBase, COMMISSION_CARD) }],
            ticket_prices: [{ amount: 100, price_rub_sbp: calculatePriceWithCommission(ticketBase, COMMISSION_SBP), price_rub_card: calculatePriceWithCommission(ticketBase, COMMISSION_CARD) }],
            prime_item_prices: [{ amount: 1, price_rub_sbp: calculatePriceWithCommission(primeBasePrice, COMMISSION_SBP), price_rub_card: calculatePriceWithCommission(primeBasePrice, COMMISSION_CARD) }],
            prime_plus_item_prices: [{ amount: 1, price_rub_sbp: calculatePriceWithCommission(primePlusBasePrice, COMMISSION_SBP), price_rub_card: calculatePriceWithCommission(primePlusBasePrice, COMMISSION_CARD) }]
        });
    } catch (e) { res.status(500).json({ error: 'Internal Error' }); }
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
            // Обработка команд для админа
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
                let m = "📊 <b>Наценки:</b>\n";
                products?.forEach(p => m += `💎 ${p.amount_uc} UC | +${p.markup_rub}₽ | $${p.price_usd}\n`);
                await sendTg(chatId, m);
            }

            if (text.toLowerCase().startsWith('код ')) {
                const [_, uc, code] = text.split(' ');
                const { error } = await supabase.from('codes_stock').insert([{ value: parseInt(uc), code: code, is_used: false }]);
                await sendTg(chatId, error ? `❌ Ошибка БД` : `✅ Код на ${uc} UC добавлен!`);
            }

            if (text.toLowerCase().startsWith('освободить')) {
                const { error } = await supabase.from('codes_stock').update({ is_used: false, status: null }).eq('status', 'RESERVED');
                await sendTg(chatId, error ? `❌ Ошибка` : `✅ Все RESERVED коды освобождены.`);
            }

            if (text.toLowerCase().startsWith('курс_store ')) {
                const rate = parseFloat(text.split(' ')[1]);
                await supabase.from('settings').update({ usd_rate_store: rate }).eq('id', 1);
                await sendTg(chatId, `📉 Курс Store обновлен: ${rate} руб/$`);
            }

            if (text.toLowerCase().startsWith('курс_promo ')) {
                const rate = parseFloat(text.split(' ')[1]);
                await supabase.from('settings').update({ usd_rate_promo: rate }).eq('id', 1);
                await sendTg(chatId, `📉 Курс Promo обновлен: ${rate} руб/$`);
            }

            if (text.toLowerCase().startsWith('price_usd ')) {
                const parts = text.split(' ');
                const uc = parseInt(parts[1]);
                const price = parseFloat(parts[2]);
                const { error } = await supabase.from('products').update({ price_usd: price }).eq('amount_uc', uc);
                await sendTg(chatId, error ? `❌ Ошибка` : `✅ Базовая цена ${uc} UC = ${price}$`);
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

            if (text.toLowerCase().startsWith('prime_usd ')) {
                const price = parseFloat(text.split(' ')[1]);
                const { error } = await supabase.from('settings').update({ prime_price_usd: price }).eq('id', 1);
                await sendTg(chatId, `🎮 Базовая цена Prime: ${price}$`);
            }

            if (text.toLowerCase().startsWith('prime_markup ')) {
                const markup = parseInt(text.split(' ')[1]);
                await supabase.from('settings').update({ prime_markup_rub: markup }).eq('id', 1);
                await sendTg(chatId, `🎮 Маржа Prime: ${markup}₽`);
            }

            if (text.toLowerCase().startsWith('prime_plus_usd ')) {
                const price = parseFloat(text.split(' ')[1]);
                const { error } = await supabase.from('settings').update({ prime_plus_price_usd: price }).eq('id', 1);
                await sendTg(chatId, `🎮 Базовая цена Prime Plus: ${price}$`);
            }

            if (text.toLowerCase().startsWith('prime_plus_markup ')) {
                const markup = parseInt(text.split(' ')[1]);
                await supabase.from('settings').update({ prime_plus_markup_rub: markup }).eq('id', 1);
                await sendTg(chatId, `🎮 Маржа Prime Plus: ${markup}₽`);
            }

            if (text === '/admin_manage') {
                const keyboard = {
                    inline_keyboard: [
                        [{ text: "💎 UC", callback_data: "m_uc" }],
                        [{ text: "🎭 Skins", callback_data: "m_skins" }]
                    ]
                };
                await sendTg(chatId, "Выберите категорию для управления товарами:", keyboard);
            }

            if (text === '/admin') {
                const { data: settings } = await supabase.from('settings').select('*').single();
                const { data: stock } = await supabase.from('codes_stock').select('value, is_used');
                
                const stats: any = {};
                stock?.filter((c: any) => !c.is_used).forEach((c: any) => stats[c.value] = (stats[c.value] || 0) + 1);
                
                let stockMsg = "📦 <b>Склад кодов:</b>\n";
                for (const [k, v] of Object.entries(stats)) stockMsg += `${k} UC: ${v} шт.\n`;
                if (Object.keys(stats).length === 0) stockMsg += "Пусто\n";
                
                const menuText = `🔧 <b>АДМИН ПАНЕЛЬ</b>\n\n${stockMsg}\n📈 Курс: ${settings?.usd_rate || 'не установлен'} руб/$\n👑 ПП (10000): ${settings?.pp_price_usd && settings?.usd_rate ? Math.ceil((settings.pp_price_usd * settings.usd_rate + (settings.pp_markup_rub || 0)) * (1 + 0.052)) + '₽' : 'не установлена'} | USD: ${settings?.pp_price_usd || 'не установлен'}$ | Маржа: ${settings?.pp_markup_rub || 'не установлена'}₽\n🎫 Билеты (100): ${settings?.ticket_price_usd && settings?.usd_rate ? Math.ceil((settings.ticket_price_usd * settings.usd_rate + (settings.ticket_markup_rub || 0)) * (1 + 0.052)) + '₽' : 'не установлена'} | USD: ${settings?.ticket_price_usd || 'не установлен'}$ | Маржа: ${settings?.ticket_markup_rub || 'не установлена'}₽\n🎮 Prime: ${settings?.prime_price_usd && settings?.usd_rate ? Math.ceil((settings.prime_price_usd * settings.usd_rate + (settings.prime_markup_rub || 0))) + '₽' : 'не установлена'} | USD: ${settings?.prime_price_usd || 'не установлен'}$ | Маржа: ${settings?.prime_markup_rub || 'не установлена'}₽\n🎮 Prime Plus: ${settings?.prime_plus_price_usd && settings?.usd_rate ? Math.ceil((settings.prime_plus_price_usd * settings.usd_rate + (settings.prime_plus_markup_rub || 0))) + '₽' : 'не установлена'} | USD: ${settings?.prime_plus_price_usd || 'не установлен'}$ | Маржа: ${settings?.prime_plus_markup_rub || 'не установлена'}₽\n\n<b>Команды:</b>\n• курс [число] - установить курс\n• маржа [uc] [руб] - маржа для UC\n• код [uc] [код] - добавить промокод на склад\n• освободить - освободить зарезервированные коды\n• price_usd [uc] [цена] - базовая цена UC в USD\n• pp_usd [цена] - базовая цена ПП в USD\n• pp_markup [руб] - наценка ПП\n• ticket_usd [цена] - базовая цена билетов в USD\n• ticket_markup [руб] - наценка билетов\n• prime_usd [цена] - базовая цена Prime в USD\n• prime_markup [руб] - маржа Prime\n• prime_plus_usd [цена] - базовая цена Prime Plus в USD\n• prime_plus_markup [руб] - маржа Prime Plus\n• скин [название] [цена] - добавить скин (отправить фото с подписью)\n• /admin_manage - управление товарами\n• /admin - показать эту панель`;
                
                await sendTg(chatId, menuText);
            }
        } else {
            // Обработка команд для обычных пользователей
            console.log(`[WEBHOOK] Processing as regular user`);
            if (text === '/start') {
                console.log(`[START] Processing /start for user ${chatId}`);
                
                const welcomeMessage = `Добро пожаловать в наш магазин 👋\n\n` +
                    `Воспользуйся кнопкой ниже для <b>осуществления покупки </b>! 🛍️\n\n`;

                
                const keyboard = {
                    inline_keyboard: [[
                        { text: "Открыть магазин", icon_custom_emoji_id: "5242557396416500126", style: "danger", web_app: { url: `${process.env.CLIENT_URL}` } }
                    ]]
                };
                
                console.log(`[START] Sending welcome message to ${chatId}`);
                try {
                    await sendLocalPhoto(chatId, START_IMAGE_PATH, welcomeMessage, keyboard);
                    console.log(`[START] Photo sent`);
                } catch (error: any) {
                    console.error(`[START] Failed to send local photo to user ${chatId}:`, error.message);
                    // Fallback to text message
                    await sendTg(chatId, welcomeMessage, keyboard);
                    console.log(`[START] Text message sent as fallback`);
                }
                console.log(`[START] Message sent`);
            }

            // Ограничение админ-команд для юзеров
            if (['курс', 'маржа', 'код', 'освободить', 'price_usd', 'pp_markup', 'pp_usd', 'ticket_usd', 'ticket_markup', 'prime_usd', 'prime_markup', 'prime_plus_usd', 'prime_plus_markup', '/admin'].some(cmd => text.toLowerCase().startsWith(cmd))) {
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
            // Перенаправляем на команду /admin
            const { data: settings } = await supabase.from('settings').select('*').single();
            const { data: stock } = await supabase.from('codes_stock').select('value, is_used');
            
            const stats: any = {};
            stock?.filter((c: any) => !c.is_used).forEach((c: any) => stats[c.value] = (stats[c.value] || 0) + 1);
            
            let stockMsg = "📦 <b>Склад кодов:</b>\n";
            for (const [k, v] of Object.entries(stats)) stockMsg += `${k} UC: ${v} шт.\n`;
            if (Object.keys(stats).length === 0) stockMsg += "Пусто\n";
            
            const menuText = `🔧 <b>АДМИН ПАНЕЛЬ</b>\n\n${stockMsg}\n📈 Курс: ${settings?.usd_rate || 'не установлен'} руб/$\n👑 ПП (10000): ${settings?.pp_price_usd && settings?.usd_rate ? Math.ceil((settings.pp_price_usd * settings.usd_rate + (settings.pp_markup_rub || 0)) * (1 + 0.052)) + '₽' : 'не установлена'} | USD: ${settings?.pp_price_usd || 'не установлен'}$ | Маржа: ${settings?.pp_markup_rub || 'не установлена'}₽\n🎫 Билеты (100): ${settings?.ticket_price_usd && settings?.usd_rate ? Math.ceil((settings.ticket_price_usd * settings.usd_rate + (settings.ticket_markup_rub || 0)) * (1 + 0.052)) + '₽' : 'не установлена'} | USD: ${settings?.ticket_price_usd || 'не установлен'}$ | Маржа: ${settings?.ticket_markup_rub || 'не установлена'}₽\n🎮 Prime: ${settings?.prime_price_usd && settings?.usd_rate ? Math.ceil((settings.prime_price_usd * settings.usd_rate + (settings.prime_markup_rub || 0))) + '₽' : 'не установлена'} | USD: ${settings?.prime_price_usd || 'не установлен'}$ | Маржа: ${settings?.prime_markup_rub || 'не установлена'}₽\n🎮 Prime Plus: ${settings?.prime_plus_price_usd && settings?.usd_rate ? Math.ceil((settings.prime_plus_price_usd * settings.usd_rate + (settings.prime_plus_markup_rub || 0))) + '₽' : 'не установлена'} | USD: ${settings?.prime_plus_price_usd || 'не установлен'}$ | Маржа: ${settings?.prime_plus_markup_rub || 'не установлена'}₽\n\n<b>Команды:</b>\n• курс [число] - установить курс\n• маржа [uc] [руб] - маржа для UC\n• код [uc] [код] - добавить промокод на склад\n• освободить - освободить зарезервированные коды\n• price_usd [uc] [цена] - базовая цена UC в USD\n• pp_usd [цена] - базовая цена ПП в USD\n• pp_markup [руб] - наценка ПП\n• ticket_usd [цена] - базовая цена билетов ...\n• prime_usd [цена] - базовая цена Prime в USD\n• prime_markup [руб] - маржа Prime\n• prime_plus_usd [цена] - базовая цена Prime Plus в USD\n• prime_plus_markup [руб] - маржа Prime Plus\n• скин [название] [цена] - добавить скин (отправить фото с подписью)\n• /admin_manage - управление товарами\n• /admin - показать эту панель`;
            
            await editTg(currentChatId, msgId, menuText);
            return;
        }

        if (data === 'm_uc') {
            const { data: products } = await supabase.from('products').select('*').order('amount_uc');
            if (products && products.length > 0) {
                let text = "💎 Товары UC:\n";
                const keyboard: any = { inline_keyboard: [] };
                products.forEach((p: any) => {
                    text += `${p.amount_uc} UC - ${p.price_usd}$\n`;
                    keyboard.inline_keyboard.push([{ text: `❌ Удалить ${p.amount_uc} UC`, callback_data: `del_products_${p.id}` }]);
                });
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