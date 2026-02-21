import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import { activateSingleCode } from './activator.ts'; 
import { findCodesForAmount } from './inventory.ts'; 


const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_KEY!);
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID ? process.env.ADMIN_CHAT_ID.split(',').map(id => id.trim()) : [];

interface CodeItem {
    id: string | number;
    code: string;
    value: number;
}

const sendTg = async (chatId: string | number | string[], text: string) => {
    if (Array.isArray(chatId)) {
        for (const id of chatId) {
            await sendTg(id, text);
        }
        return;
    }
    try {
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: chatId, 
            text, 
            parse_mode: 'HTML'
        });
    } catch (e: any) {
        console.error('❌ Ошибка TG в bot_manager:', e.message);
    }
};

/**
 * ПОИСК ЗАМЕНЫ ОДНОГО КОДА (вспомогательная функция)
 */
async function findReplacementCode(orderId: number, value: number): Promise<CodeItem | null> {
    const { data, error } = await supabase
        .from('codes_stock')
        .select('id, code, value')
        .eq('is_used', false)
        .eq('value', value)
        .is('status', null)
        .limit(1)
        .maybeSingle();

    if (error || !data) return null;

    const replacement = data as CodeItem;

    await supabase.from('codes_stock').update({ is_used: true, status: 'RESERVED', order_id: orderId }).eq('id', replacement.id);
    return replacement;
}

/**
 * ОСНОВНАЯ ФУНКЦИЯ ВЫПОЛНЕНИЯ ЗАКАЗА
 */
export async function fulfillOrder(orderId: number, uid: string, amount: number, chatId: string) {
    try {
        console.log(`🚀 [BotManager] Начинаем выполнение заказа #${orderId} на ${amount} UC для UID: ${uid}`);

        const rawCodes = await findCodesForAmount(amount, orderId);
        
        if (!rawCodes || rawCodes.length === 0) {
            console.error(`❌ Не удалось подобрать коды для ${amount} UC`);
            await sendTg(ADMIN_CHAT_ID, `⚠️ <b>ОШИБКА СКЛАДА</b>\nЗаказ #${orderId}\nНе хватает кодов для суммы ${amount} UC!`);
            await supabase.from('orders').update({ status: 'error_no_codes' }).eq('id', orderId);
            return;
        }

        let codesQueue: CodeItem[] = rawCodes;
        const codeIds = codesQueue.map(c => c.id);

        const { data: accounts, error: accError } = await supabase
            .from('midas_accounts')
            .select('*')
            .eq('is_active', true)
            .order('id', { ascending: true });
        
        if (accError || !accounts || accounts.length === 0) {
            console.error(`❌ Нет доступных аккаунтов Midasbuy`);
            await sendTg(ADMIN_CHAT_ID, `⚠️ <b>КРИТИЧЕСКАЯ ОШИБКА</b>\nНет активных аккаунтов Midasbuy в базе!`);

            await supabase.from('codes_stock').update({ is_used: false, status: null, order_id: null }).in('id', codeIds);

            return;
        }

        let accIndex = 0;
        let activatedUcTotal = 0;
        const finalReport = [];

        for (let i = 0; i < codesQueue.length; i++) {
            const item = codesQueue[i];
            let isCodeDone = false;
            
            while (!isCodeDone) {
                if (accIndex >= accounts.length) {
                    console.error(`💀 Все аккаунты исчерпаны на коде ${item.code}`);
                    await sendTg(ADMIN_CHAT_ID, `💀 <b>СТОП БОТ</b>\nВсе аккаунты в капче. Заказ #${orderId} приостановлен.`);
                    
                    await supabase.from('codes_stock').update({ is_used: false, status: null, order_id: null }).eq('id', item.id);
                    
                    isCodeDone = true; 
                    break;
                }

                const currentAcc = accounts[accIndex];
                console.log(`[🔄] (${i + 1}/${codesQueue.length}) Пробую аккаунт ${currentAcc.email} для кода ${item.code}`);
                
                const result = await activateSingleCode(
                    { email: currentAcc.email, pass: currentAcc.password },
                    uid,
                    item.code
                );

                if (result === 'SUCCESS') {
                    console.log(`✅ Код ${item.code} на ${item.value} UC активирован.`);
                    
                    await supabase.from('codes_stock').update({ 
                        is_used: true, 
                        used_at: new Date().toISOString(),
                        buyer_uid: uid,
                        order_id: orderId,
                        status: 'ACTIVATED'
                    }).eq('id', item.id);

                    activatedUcTotal += item.value;
                    finalReport.push({ code: item.code, status: 'SUCCESS', value: item.value });
                    isCodeDone = true;

                } else if (result === 'CAPTCHA') {
                    console.log(`🚧 Капча на ${currentAcc.email}. Меняю аккаунт...`);
                    await supabase.from('midas_accounts').update({ is_active: false }).eq('id', currentAcc.id);
                    accIndex++; 

                } else if (result === 'ALREADY_REDEEMED' || result === 'ERROR') {
                    console.log(`❌ Код ${item.code} битый. Ищу замену...`);
                    
                    await supabase.from('codes_stock').update({ 
                        is_used: true, 
                        status: 'BROKEN',
                        error_log: result 
                    }).eq('id', item.id);

                    await sendTg(ADMIN_CHAT_ID, `⚠️ <b>БИТЫЙ КОД</b>\n${item.code} (${item.value} UC)\nЗаказ: #${orderId}. Ищу замену...`);

                    const replacement = await findReplacementCode(orderId, item.value);
                    if (replacement) {
                        console.log(`[🔄] Замена найдена: ${replacement.code}. Добавляю в очередь.`);
                        codesQueue.push(replacement); 
                    } else {
                        console.error(`❌ Замены для ${item.value} UC не найдено.`);
                        finalReport.push({ code: item.code, status: 'FAILED_NO_REPLACEMENT', value: item.value });
                    }

                    isCodeDone = true; 
                }
            }
        }

        const finalStatus = activatedUcTotal >= amount ? 'completed' : 'partial';

        if (finalStatus !== 'completed') {
            await supabase.from('codes_stock').update({ is_used: false, status: null, order_id: null }).eq('order_id', orderId).eq('status', 'RESERVED');
        }

        await supabase.from('orders').update({ 
            status: finalStatus, 
            current_uc: activatedUcTotal,
            completed_at: finalStatus === 'completed' ? new Date().toISOString() : null,
            details: JSON.stringify(finalReport)
        }).eq('id', orderId);

        if (finalStatus === 'completed') {
            if (chatId) await sendTg(chatId, `✅ <b>Заказ выполнен!</b>\n${activatedUcTotal} UC успешно зачислены на UID: ${uid}.`);
            await sendTg(ADMIN_CHAT_ID, `🤖 Заказ #${orderId} выполнен полностью (${activatedUcTotal} UC).`);
        } else {
            const msg = `⚠️ Заказ #${orderId} выполнен частично: ${activatedUcTotal}/${amount} UC.`;
            await sendTg(ADMIN_CHAT_ID, msg);
            if (chatId) await sendTg(chatId, `⚠️ <b>Ваш заказ выполнен частично.</b>\nЗачислено ${activatedUcTotal} из ${amount} UC. Свяжитесь с поддержкой.`);
        }
    } catch (error) {
        console.error(`💥 Критическая ошибка в fulfillOrder для заказа #${orderId}:`, error);
        await sendTg(ADMIN_CHAT_ID, `💥 <b>КРИТИЧЕСКАЯ ОШИБКА БОТА</b>\nЗаказ #${orderId}. Проверьте логи.`);

        await supabase.from('codes_stock').update({ is_used: false, status: null, order_id: null }).eq('order_id', orderId).eq('status', 'RESERVED');
    } finally {
        // После каждой активации возвращаем все аккаунты в активное состояние
        await supabase.from('midas_accounts').update({ is_active: true });
        console.log(`[🔄] Midasbuy аккаунты сброшены (is_active=true) для следующего заказа.`);
    }
}