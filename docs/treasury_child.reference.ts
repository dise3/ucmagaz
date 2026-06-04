/**
 * ЭТАЛОН для ДОЧЕРНЕГО магазина — скопировать в server/treasury_child.ts
 * Supabase: docs/supabase_treasury_child.sql
 */
import type { SupabaseClient } from '@supabase/supabase-js';

const MSK_OFFSET_HOURS = 3;

export function getMskDayKey(date: Date = new Date()): string {
    const msk = new Date(date.getTime() + MSK_OFFSET_HOURS * 60 * 60 * 1000);
    return msk.toISOString().slice(0, 10);
}

export function getTodayMskKey(): string {
    return getMskDayKey(new Date());
}

export function formatRub(amount: number): string {
    return `${amount.toLocaleString('ru-RU', { maximumFractionDigits: 2 })}₽`;
}

export function formatUsdt(amount: number): string {
    return `${amount.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} USDT`;
}

async function ensureChildTreasury(supabase: SupabaseClient) {
    await supabase.from('child_treasury').upsert({ id: 1 }, { onConflict: 'id' });
}

/** После оплаты заказа дочернего магазина */
export async function recordChildOrderRevenue(
    supabase: SupabaseClient,
    orderId: number,
    priceRub: number,
    createdAt?: string
) {
    if (!priceRub || priceRub <= 0) return;

    const { data: existing } = await supabase
        .from('child_treasury_order_log')
        .select('order_id')
        .eq('order_id', orderId)
        .maybeSingle();
    if (existing) return;

    const dayKey = getMskDayKey(createdAt ? new Date(createdAt) : new Date());

    const { data: row } = await supabase
        .from('child_daily_rub_ledger')
        .select('rub_total')
        .eq('day_date', dayKey)
        .maybeSingle();

    const newTotal = Number(row?.rub_total ?? 0) + priceRub;
    if (row) {
        await supabase.from('child_daily_rub_ledger').update({ rub_total: newTotal }).eq('day_date', dayKey);
    } else {
        await supabase.from('child_daily_rub_ledger').insert({ day_date: dayKey, rub_total: newTotal });
    }

    await supabase.from('child_treasury_order_log').insert({
        order_id: orderId,
        rub_amount: priceRub,
        day_date: dayKey,
    });
}

export async function getUnconvertedRubDays(supabase: SupabaseClient) {
    const today = getTodayMskKey();
    const { data } = await supabase
        .from('child_daily_rub_ledger')
        .select('day_date, rub_total')
        .is('converted_at', null)
        .lt('day_date', today)
        .order('day_date', { ascending: true });

    const days = data ?? [];
    const totalRub = days.reduce((s, d) => s + Number(d.rub_total), 0);
    return { days, totalRub, today };
}

export async function getChildTreasurySummary(supabase: SupabaseClient) {
    await ensureChildTreasury(supabase);
    const { data: t } = await supabase.from('child_treasury').select('*').eq('id', 1).single();
    const { days, totalRub, today } = await getUnconvertedRubDays(supabase);
    const { data: todayRow } = await supabase
        .from('child_daily_rub_ledger')
        .select('rub_total')
        .eq('day_date', today)
        .maybeSingle();

    return {
        balanceUsdt: Number(t?.balance_usdt ?? 0),
        lastRate: t?.usdt_rate_rub ? Number(t.usdt_rate_rub) : null,
        todayRub: Number(todayRow?.rub_total ?? 0),
        todayMsk: today,
        unconvertedRub: totalRub,
        unconvertedDays: days.map((d) => ({
            day_date: d.day_date,
            rub_total: Number(d.rub_total),
        })),
    };
}

/** POST /api/treasury/convert — вызывается с главного магазина */
export async function convertChildRubToUsdt(supabase: SupabaseClient, rateRubPerUsdt: number) {
    if (!rateRubPerUsdt || rateRubPerUsdt <= 0) {
        return { ok: false as const, error: 'Некорректный курс' };
    }

    const { days, totalRub, today } = await getUnconvertedRubDays(supabase);
    if (totalRub <= 0) {
        return { ok: false as const, error: `Нет ₽ для конвертации (сегодня ${today} не учитывается)` };
    }

    const usdtAdded = totalRub / rateRubPerUsdt;
    const now = new Date().toISOString();

    await ensureChildTreasury(supabase);
    const { data: t } = await supabase.from('child_treasury').select('balance_usdt').eq('id', 1).single();
    const newUsdt = Number(t?.balance_usdt ?? 0) + usdtAdded;

    const { error } = await supabase
        .from('child_treasury')
        .update({ balance_usdt: newUsdt, usdt_rate_rub: rateRubPerUsdt, updated_at: now })
        .eq('id', 1);
    if (error) return { ok: false as const, error: error.message };

    for (const d of days) {
        await supabase.from('child_daily_rub_ledger').update({ converted_at: now }).eq('day_date', d.day_date);
    }

    return {
        ok: true as const,
        totalRub,
        usdtAdded,
        rate: rateRubPerUsdt,
        newBalanceUsdt: newUsdt,
    };
}

export async function createWithdrawalRequest(
    supabase: SupabaseClient,
    amountUsdt: number,
    payoutDetails: string
) {
    if (amountUsdt <= 0) return { ok: false as const, error: 'Сумма должна быть > 0' };

    await ensureChildTreasury(supabase);
    const { data: t } = await supabase.from('child_treasury').select('balance_usdt').eq('id', 1).single();
    const balance = Number(t?.balance_usdt ?? 0);
    if (amountUsdt > balance) {
        return { ok: false as const, error: `Недостаточно USDT (доступно ${balance.toFixed(2)})` };
    }

    const { data: req, error } = await supabase
        .from('withdrawal_requests')
        .insert({
            amount_usdt: amountUsdt,
            payout_details: payoutDetails,
            status: 'pending',
        })
        .select('id')
        .single();

    if (error || !req) return { ok: false as const, error: error?.message || 'Ошибка БД' };

    await supabase
        .from('child_treasury')
        .update({ balance_usdt: balance - amountUsdt })
        .eq('id', 1);

    return { ok: true as const, requestId: req.id as number };
}

export async function completeWithdrawalRequest(supabase: SupabaseClient, requestId: number) {
    const { data: req } = await supabase
        .from('withdrawal_requests')
        .select('*')
        .eq('id', requestId)
        .single();

    if (!req) return { ok: false as const, error: 'Заявка не найдена' };
    if (req.status === 'completed') return { ok: true as const };

    const { error } = await supabase
        .from('withdrawal_requests')
        .update({ status: 'completed', completed_at: new Date().toISOString() })
        .eq('id', requestId);

    if (error) return { ok: false as const, error: error.message };
    return { ok: true as const };
}
