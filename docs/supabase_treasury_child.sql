-- ДОЧЕРНИЙ МАГАЗИН — выполнить в Supabase проекта дочернего (НЕ главного)

-- Баланс USDT, доступный к выводу после конвертации прошлых дней
CREATE TABLE IF NOT EXISTS child_treasury (
    id INT PRIMARY KEY DEFAULT 1,
    balance_usdt NUMERIC NOT NULL DEFAULT 0,
    usdt_rate_rub NUMERIC,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO child_treasury (id, balance_usdt) VALUES (1, 0)
ON CONFLICT (id) DO NOTHING;

-- Выручка в ₽ по дням (МСК), день = YYYY-MM-DD
CREATE TABLE IF NOT EXISTS child_daily_rub_ledger (
    day_date TEXT PRIMARY KEY,
    rub_total NUMERIC NOT NULL DEFAULT 0,
    converted_at TIMESTAMPTZ
);

-- Идемпотентность: один заказ — одна запись в журнале
CREATE TABLE IF NOT EXISTS child_treasury_order_log (
    order_id BIGINT PRIMARY KEY,
    rub_amount NUMERIC NOT NULL,
    day_date TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Заявки на вывод USDT (крипта через главный магазин)
CREATE TABLE IF NOT EXISTS withdrawal_requests (
    id BIGSERIAL PRIMARY KEY,
    amount_usdt NUMERIC NOT NULL,
    payout_details TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_status ON withdrawal_requests(status);

ALTER TABLE child_treasury ENABLE ROW LEVEL SECURITY;
ALTER TABLE child_daily_rub_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE child_treasury_order_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE withdrawal_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "treasury_all_child_treasury" ON child_treasury FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "treasury_all_child_daily_rub" ON child_daily_rub_ledger FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "treasury_all_child_order_log" ON child_treasury_order_log FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "treasury_all_withdrawal" ON withdrawal_requests FOR ALL USING (true) WITH CHECK (true);
