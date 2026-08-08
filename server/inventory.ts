import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { activateSingleCode } from './activator.ts';

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_KEY!);


interface CodeItem {
    id: string | number;
    code: string;
    value: number;
}

const COMBINATION_MAP: Record<number, number[]> = {
    60:    [60],
    120:   [60, 60],
    180:   [60, 60, 60],
    240:   [60, 60, 60, 60],
    325:   [325],
    385:   [325, 60],
    445:   [325, 60, 60],
    660:   [660],
    720:   [660, 60],
    985:   [660, 325],
    1320:  [660, 660],
    1800:  [1800],
    1920:  [1800, 60, 60],
    2125:  [1800, 325],
    2460:  [1800, 660],
    3850:  [3850],
    4510:  [3850, 660],
    5650:  [3850, 1800],
    8100:  [8100],
    9900:  [8100, 1800],
    11950: [8100, 3850],
    16200: [8100, 8100],
    24300: [8100, 8100, 8100],
    32400: [8100, 8100, 8100, 8100],
    40500: [8100, 8100, 8100, 8100, 8100],
    81000: [8100, 8100, 8100, 8100, 8100, 8100, 8100, 8100, 8100, 8100],
};


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
    // 1. Проверяем, есть ли сумма в таблице комбинаций
    const requiredValues = COMBINATION_MAP[targetAmount];
    if (!requiredValues) {
        console.log(`[❌] Сумма ${targetAmount} отсутствует в таблице комбинаций.`);
        return null;
    }

    // 2. Подсчитываем, сколько каких номиналов нужно
    const neededCounts = new Map<number, number>();
    for (const val of requiredValues) {
        neededCounts.set(val, (neededCounts.get(val) || 0) + 1);
    }

    // 3. Запрашиваем все доступные коды с нужными номиналами
    const uniqueValues = Array.from(neededCounts.keys());
    const { data: available, error } = await supabase
        .from('codes_stock')
        .select('id, code, value')
        .eq('is_used', false)
        .is('status', null)
        .in('value', uniqueValues)
        .order('value', { ascending: true }); // порядок не важен, но для стабильности

    if (error || !available) {
        console.error('[❌] Ошибка при запросе кодов:', error?.message);
        return null;
    }

    // 4. Группируем по value
    const availableByValue = new Map<number, CodeItem[]>();
    for (const item of available) {
        const val = item.value;
        if (!availableByValue.has(val)) availableByValue.set(val, []);
        availableByValue.get(val)!.push(item as CodeItem);
    }

    // 5. Проверяем, хватает ли каждого номинала
    const selectedIds: (string | number)[] = [];
    const selectedItems: CodeItem[] = [];

    for (const [value, needed] of neededCounts.entries()) {
        const pool = availableByValue.get(value) || [];
        if (pool.length < needed) {
            console.log(`[❌] Не хватает кодов номинала ${value}: нужно ${needed}, есть ${pool.length}`);
            return null; // не хватает – отказ
        }
        // берём первые `needed` кодов
        const chosen = pool.slice(0, needed);
        for (const item of chosen) {
            selectedIds.push(item.id);
            selectedItems.push(item);
        }
    }

    // 6. Резервируем выбранные коды
    const updateData: Record<string, unknown> = {
        is_used: true,
        status: 'RESERVED'
    };
    if (orderId != null) updateData.order_id = orderId;

    const { error: updateError } = await supabase
        .from('codes_stock')
        .update(updateData)
        .in('id', selectedIds);

    if (updateError) {
        console.error('[❌] Ошибка при резервировании кодов:', updateError.message);
        return null;
    }

    console.log(`[✅] Зарезервирована комбинация для ${targetAmount} UC:`, selectedItems.map(c => `${c.value} UC`).join(' + '));
    return selectedItems;
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