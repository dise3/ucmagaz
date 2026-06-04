/**
 * ГЛАВНЫЙ МАГАЗИН — скопируйте в server/treasury_main.ts
 * Supabase: выполните supabase_treasury_main.sql
 */
import axios from 'axios';
import type { SupabaseClient } from '@supabase/supabase-js';

const MSK_OFFSET_HOURS = 3;

export const CHILD_STORE_API_URL = process.env.CHILD_STORE_API_URL || '';
export const TREASURY_API_SECRET = process.env.TREASURY_API_SECRET || '';

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

async function ensureMainTreasury(supabase: SupabaseClient) {
    await supabase.from('main_treasury').upsert({ id: 1 }, { onConflict: 'id' });
}

/** После оплаты заказа — начислить price_rub в журнал за день (МСК) */
export async function recordOrderRevenue(
    supabase: SupabaseClient,
    orderId: number,
    priceRub: number,
    createdAt?: string
) {
    if (!priceRub || priceRub <= 0) return;

    const { data: existing } = await supabase
        .from('treasury_order_log')
        .select('order_id')
        .eq('order_id', orderId)
        .maybeSingle();
    if (existing) return;

    const dayKey = getMskDayKey(createdAt ? new Date(createdAt) : new Date());

    const { data: row } = await supabase
        .from('daily_rub_ledger')
        .select('rub_total')
        .eq('day_date', dayKey)
        .maybeSingle();

    const newTotal = Number(row?.rub_total ?? 0) + priceRub;
    if (row) {
        await supabase.from('daily_rub_ledger').update({ rub_total: newTotal }).eq('day_date', dayKey);
    } else {
        await supabase.from('daily_rub_ledger').insert({ day_date: dayKey, rub_total: newTotal });
    }

    await supabase.from('treasury_order_log').insert({
        order_id: orderId,
        rub_amount: priceRub,
        day_date: dayKey,
    });
}

export async function getUnconvertedRubDays(supabase: SupabaseClient) {
    const today = getTodayMskKey();
    const { data } = await supabase
        .from('daily_rub_ledger')
        .select('day_date, rub_total')
        .is('converted_at', null)
        .lt('day_date', today)
        .order('day_date', { ascending: true });

    const days = data ?? [];
    const totalRub = days.reduce((s, d) => s + Number(d.rub_total), 0);
    return { days, totalRub, today };
}

export async function getMainTreasurySummary(supabase: SupabaseClient) {
    await ensureMainTreasury(supabase);
    const { data: t } = await supabase.from('main_treasury').select('*').eq('id', 1).single();
    const { days, totalRub, today } = await getUnconvertedRubDays(supabase);
    const { data: todayRow } = await supabase
        .from('daily_rub_ledger')
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

export function formatMainTreasuryMessage(s: Awaited<ReturnType<typeof getMainTreasurySummary>>): string {
    const lines =
        s.unconvertedDays.length > 0
            ? s.unconvertedDays
                  .map((d) => `• ${d.day_date}: ${formatRub(d.rub_total)}`)
                  .join('\n')
            : '— нет дней для конвертации';
    const rateLine = s.lastRate ? `\nПоследний курс: <b>${s.lastRate}</b> руб/USDT` : '';
    return (
        `💰 <b>(главный)</b>\n\n` +
        `💵 USDT: <b>${formatUsdt(s.balanceUsdt)}</b>${rateLine}\n` +
        `📅 Сегодня (${s.todayMsk}): <b>${formatRub(s.todayRub)}</b> — не конвертируется\n\n` +
        `⏳ К конвертации:\n${lines}\n` +
        `<b>Итого: ${formatRub(s.unconvertedRub)}</b>`
    );
}

/** Конвертация всех прошлых дней (кроме сегодня МСК) по курсу руб/USDT */
export async function convertRubToUsdt(supabase: SupabaseClient, rateRubPerUsdt: number) {
    if (!rateRubPerUsdt || rateRubPerUsdt <= 0) {
        return { ok: false as const, error: 'Некорректный курс' };
    }

    const { days, totalRub, today } = await getUnconvertedRubDays(supabase);
    if (totalRub <= 0) {
        return { ok: false as const, error: `Нет ₽ для конвертации (сегодня ${today} не учитывается)` };
    }

    const usdtAdded = totalRub / rateRubPerUsdt;
    const now = new Date().toISOString();

    await ensureMainTreasury(supabase);
    const { data: t } = await supabase.from('main_treasury').select('balance_usdt').eq('id', 1).single();
    const newUsdt = Number(t?.balance_usdt ?? 0) + usdtAdded;

    const { error } = await supabase
        .from('main_treasury')
        .update({ balance_usdt: newUsdt, usdt_rate_rub: rateRubPerUsdt })
        .eq('id', 1);
    if (error) return { ok: false as const, error: error.message };

    for (const d of days) {
        await supabase.from('daily_rub_ledger').update({ converted_at: now }).eq('day_date', d.day_date);
    }

    return {
        ok: true as const,
        totalRub,
        usdtAdded,
        rate: rateRubPerUsdt,
        newBalanceUsdt: newUsdt,
    };
}

export type ChildTreasurySummary = {
    balanceUsdt: number;
    lastRate: number | null;
    todayRub: number;
    todayMsk: string;
    unconvertedRub: number;
    unconvertedDays: { day_date: string; rub_total: number }[];
};

function childApiBase(): string | null {
    if (!CHILD_STORE_API_URL) return null;
    return CHILD_STORE_API_URL.replace(/\/$/, '');
}

function childApiHeaders() {
    return {
        'x-treasury-secret': TREASURY_API_SECRET,
        'Content-Type': 'application/json',
    };
}

function mapChildSummary(data: Record<string, unknown>): ChildTreasurySummary {
    const days = (data.unconvertedDays as { day_date: string; rub_total: number }[]) ?? [];
    return {
        balanceUsdt: Number(data.balanceUsdt ?? 0),
        lastRate: data.lastRate != null ? Number(data.lastRate) : null,
        todayRub: Number(data.todayRub ?? 0),
        todayMsk: String(data.todayMsk ?? ''),
        unconvertedRub: Number(data.unconvertedRub ?? 0),
        unconvertedDays: days.map((d) => ({
            day_date: d.day_date,
            rub_total: Number(d.rub_total),
        })),
    };
}

/** Сводка казны дочернего магазина (GET API дочернего) */
export async function getChildTreasurySummary() {
    const base = childApiBase();
    if (!base) return { ok: false as const, error: 'CHILD_STORE_API_URL не задан' };
    if (!TREASURY_API_SECRET) return { ok: false as const, error: 'TREASURY_API_SECRET не задан' };

    try {
        const res = await axios.get(`${base}/api/treasury/summary`, { headers: childApiHeaders() });
        return { ok: true as const, summary: mapChildSummary(res.data) };
    } catch (e: any) {
        const msg = e.response?.data?.error || e.message || 'Ошибка API дочернего';
        return { ok: false as const, error: msg };
    }
}

export function formatChildTreasuryMessage(s: ChildTreasurySummary): string {
    const lines =
        s.unconvertedDays.length > 0
            ? s.unconvertedDays
                  .map((d) => `• ${d.day_date}: ${formatRub(d.rub_total)}`)
                  .join('\n')
            : '— нет дней для конвертации';
    const rateLine = s.lastRate ? `\nПоследний курс: <b>${s.lastRate}</b> руб/USDT` : '';
    return (
        `🏪 <b>Дочерний магазин</b>\n\n` +
        `💵 USDT к выводу: <b>${formatUsdt(s.balanceUsdt)}</b>${rateLine}\n` +
        `📅 Сегодня (${s.todayMsk}): <b>${formatRub(s.todayRub)}</b> — не конвертируется\n\n` +
        `⏳ К конвертации (прошлые дни):\n${lines}\n` +
        `<b>Итого: ${formatRub(s.unconvertedRub)}</b>`
    );
}

/**
 * Конвертация продаж дочернего за все прошлые дни (кроме сегодня МСК) по курсу руб/USDT.
 * Вызывает POST /api/treasury/convert на сервере дочернего магазина.
 */
export async function convertChildRubToUsdt(rateRubPerUsdt: number) {
    const base = childApiBase();
    if (!base) return { ok: false as const, error: 'CHILD_STORE_API_URL не задан' };
    if (!TREASURY_API_SECRET) return { ok: false as const, error: 'TREASURY_API_SECRET не задан' };
    if (!rateRubPerUsdt || rateRubPerUsdt <= 0) {
        return { ok: false as const, error: 'Некорректный курс' };
    }

    try {
        const res = await axios.post(
            `${base}/api/treasury/convert`,
            { rate: rateRubPerUsdt },
            { headers: childApiHeaders() }
        );
        return res.data as {
            ok: boolean;
            error?: string;
            totalRub?: number;
            usdtAdded?: number;
            rate?: number;
            newBalanceUsdt?: number;
        };
    } catch (e: any) {
        const msg = e.response?.data?.error || e.message || 'Ошибка API дочернего';
        return { ok: false as const, error: msg };
    }
}

/** USDT-эквивалент для заявки дочернего (по последнему курсу) */
export async function rubToUsdtHint(supabase: SupabaseClient, rub: number): Promise<string> {
    const { data: t } = await supabase.from('main_treasury').select('usdt_rate_rub').eq('id', 1).single();
    const rate = Number(t?.usdt_rate_rub ?? 0);
    if (!rate) return '';
    return `\n≈ <b>${formatUsdt(rub / rate)}</b> (курс ${rate} руб/USDT)`;
}

/** Заявка дочернего: кнопка «Выполнено» в главном боте */
export async function completeChildWithdrawal(requestId: number) {
    if (!CHILD_STORE_API_URL) {
        return { ok: false as const, error: 'CHILD_STORE_API_URL не задан' };
    }
    if (!TREASURY_API_SECRET) {
        return { ok: false as const, error: 'TREASURY_API_SECRET не задан' };
    }

    try {
        const res = await axios.post(
            `${CHILD_STORE_API_URL.replace(/\/$/, '')}/api/treasury/withdrawal/complete`,
            { requestId },
            {
                headers: {
                    'x-treasury-secret': TREASURY_API_SECRET,
                    'Content-Type': 'application/json',
                },
            }
        );
        return res.data as { ok: boolean; error?: string };
    } catch (e: any) {
        const msg = e.response?.data?.error || e.message || 'Ошибка API дочернего';
        return { ok: false as const, error: msg };
    }
}

/**
 * @deprecated Ручное зачисление не используется: ₽ копятся на дочернем после оплат.
 * Оставлено для аварийного вызова из консоли при необходимости.
 */
export async function creditChildStore(amountRub: number) {
    if (!CHILD_STORE_API_URL) {
        return { ok: false as const, error: 'CHILD_STORE_API_URL не задан' };
    }
    if (!TREASURY_API_SECRET) {
        return { ok: false as const, error: 'TREASURY_API_SECRET не задан' };
    }
    if (amountRub <= 0) {
        return { ok: false as const, error: 'Сумма должна быть > 0' };
    }

    try {
        const res = await axios.post(
            `${CHILD_STORE_API_URL.replace(/\/$/, '')}/api/treasury/credit`,
            { amount: amountRub },
            {
                headers: {
                    'x-treasury-secret': TREASURY_API_SECRET,
                    'Content-Type': 'application/json',
                },
            }
        );
        return res.data as { ok: boolean; balanceRub?: number; error?: string };
    } catch (e: any) {
        const msg = e.response?.data?.error || e.message || 'Ошибка API дочернего';
        return { ok: false as const, error: msg };
    }
}
