import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { activateSingleCode } from './activator.ts';

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_KEY!);


interface CodeItem {
    id: string | number;
    code: string;
    value: number;
}

/**
 * ГЛАВНАЯ ФУНКЦИЯ ВЫПОЛНЕНИЯ ЗАКАЗА
 */
export async function processOrder(orderId: string, uid: string, targetUc: number, account: { email: string, pass: string }) {
    console.log(`[🚀] Заказ #${orderId}: требуется ${targetUc} UC для ID: ${uid}`);

    let codesQueue = await findCodesForAmount(targetUc, orderId);
    
    if (!codesQueue) {
        console.error(`[❌] Нет кодов для суммы ${targetUc}`);
        await supabase.from('orders').update({ 
            status: 'CANCELLED', 
            error_log: 'No matching codes in stock' 
        }).eq('id', orderId);
        return { status: 'CANCELLED', total: 0 };
    }

    console.log(`[🧩] Собрана комбинация: ${codesQueue.map(c => c.value).join(' + ')} UC`);

    let activatedSum = 0;
    const finalReport = [];

    for (let i = 0; i < codesQueue.length; i++) {
        const item = codesQueue[i];
        console.log(`[📦] (${i + 1}/${codesQueue.length}) Активация ${item.value} UC...`);
        
        const result = await activateSingleCode(account, uid, item.code);

        if (result === 'SUCCESS') {
            activatedSum += item.value;
            await markCodeAsSuccess(item.id, uid, orderId);
            finalReport.push({ code: item.code, status: 'SUCCESS', value: item.value });
        } 
        else if (result === 'ALREADY_REDEEMED' || result === 'ERROR') {
            console.warn(`[⚠️] Код ${item.code} битый (${result}). Ищу замену...`);
            await markCodeAsFailed(item.id, result);

            const replacement = await findReplacementCode(orderId, item.value);
            if (replacement) {
                console.log(`[🔄] Найдена замена: код на ${replacement.value} UC. Добавляю в очередь.`);
                codesQueue.push(replacement); 
            } else {
                console.error(`[❌] Запасных кодов на ${item.value} UC нет.`);
                finalReport.push({ code: item.code, status: 'FAILED_NO_REPLACEMENT', value: item.value });
            }
        } 
        else if (result === 'CAPTCHA') {
            console.error(`[🛑] Остановка: Капча не пройдена.`);
            await supabase.from('codes_stock').update({ 
                is_used: false, 
                status: null 
            }).eq('id', item.id);
            break;
        }
    }

    const isFullSuccess = activatedSum === targetUc;
    const finalStatus = isFullSuccess ? 'COMPLETED' : 'PARTIAL';
    
    if (finalStatus !== 'COMPLETED') {
        await supabase.from('codes_stock').update({ is_used: false, status: null, order_id: null }).eq('order_id', orderId).eq('status', 'RESERVED');
    }
    
    await supabase.from('orders').update({ 
        status: finalStatus, 
        current_uc: activatedSum,
        completed_at: isFullSuccess ? new Date().toISOString() : null,
        details: JSON.stringify(finalReport)
    }).eq('id', orderId);

    console.log(`[🏁] Заказ завершен со статусом: ${finalStatus}. Итого: ${activatedSum}/${targetUc} UC`);
    return { status: finalStatus, total: activatedSum };
}

/**
 * УМНЫЙ ПОДБОР КОМБИНАЦИИ (Алгоритм Backtracking)
 * @param orderId — ID заказа для привязки зарезервированных кодов (для корректного rollback)
 */
export async function findCodesForAmount(targetAmount: number, orderId?: string | number): Promise<CodeItem[] | null> {
    const { data: pool, error } = await supabase
        .from('codes_stock')
        .select('id, code, value')
        .eq('is_used', false)
        .is('status', null) 
        .order('value', { ascending: false });

    if (error || !pool) return null;

    console.log(`[📦] Доступные коды для ${targetAmount} UC:`, pool.map(c => `${c.value} UC (id:${c.id})`).join(', '));

    const validPool: CodeItem[] = pool as unknown as CodeItem[];

    function search(target: number, startIndex: number): CodeItem[] | null {
        if (target === 0) return [];
        if (target < 0 || startIndex >= validPool.length) return null;

        for (let i = startIndex; i < validPool.length; i++) {
            const res = search(target - validPool[i].value, i + 1);
            if (res !== null) return [validPool[i], ...res];
        }
        return null;
    }

    const combination = search(targetAmount, 0);
    if (combination && combination.length > 0) {
        console.log(`[✅] Найдена комбинация для ${targetAmount} UC:`, combination.map(c => `${c.value} UC`).join(' + '));
        const ids = combination.map(c => c.id);
        const updateData: Record<string, unknown> = { is_used: true, status: 'RESERVED' };
        if (orderId != null) updateData.order_id = orderId;
        const { error: updError } = await supabase
            .from('codes_stock')
            .update(updateData)
            .in('id', ids);
            
        if (updError) {
            console.error('[❌] Ошибка при бронировании кодов:', updError.message);
            return null;
        }
        return combination;
    }
    console.log(`[❌] Комбинация для ${targetAmount} UC не найдена.`);
    return null;
}

/**
 * ПОИСК ЗАМЕНЫ ОДНОГО КОДА
 */
async function findReplacementCode(orderId: string | number, value: number): Promise<CodeItem | null> {
    const { data, error } = await supabase
        .from('codes_stock')
        .select('id, code, value')
        .eq('is_used', false)
        .eq('value', value)
        .is('status', null)
        .limit(1)
        .maybeSingle(); 

    if (error || !data) return null;

    const codeData = data as unknown as CodeItem;

    await supabase.from('codes_stock').update({ 
        is_used: true, 
        status: 'RESERVED',
        order_id: orderId 
    }).eq('id', codeData.id);

    return codeData;
}

/**
 * СТАТУСЫ В БД
 */
async function markCodeAsSuccess(id: string | number, uid: string, orderId: string) {
    await supabase.from('codes_stock').update({
        is_used: true,
        status: 'ACTIVATED',
        used_at: new Date().toISOString(),
        buyer_uid: uid,
        order_id: orderId
    }).eq('id', id);
}

async function markCodeAsFailed(id: string | number, reason: string) {
    await supabase.from('codes_stock').update({
        is_used: true, 
        status: reason === 'ALREADY_REDEEMED' ? 'USED_BY_OTHER' : 'BROKEN',
        error_log: reason,
        broken_at: new Date().toISOString()
    }).eq('id', id);
}