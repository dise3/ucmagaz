import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { activateSingleCode } from './activator.ts';

const uid = process.argv[2];
const code = process.argv[3];
const email = process.argv[4];

if (!uid || !code) {
  console.log('❌ Ошибка: Укажите UID и Код');
  process.exit(1);
}

// Проверка наличия переменных окружения
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  console.error('❌ Ошибка: В .env не найдены SUPABASE_URL или SUPABASE_KEY');
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_KEY!
);

async function run() {
  console.log('--- 🛡️ ДИАГНОСТИКА ПОДКЛЮЧЕНИЯ ---');
  console.log('🔗 URL:', process.env.SUPABASE_URL);
  
  // 1. Пробуем получить ВООБЩЕ все записи из таблицы без фильтров
  const { data: allAccounts, error: fetchError } = await supabase
    .from('midas_accounts')
    .select('*');

  if (fetchError) {
    console.error('❌ Ошибка при чтении таблицы:', fetchError.message);
    console.error('💡 Совет: Проверьте правильность SUPABASE_KEY (лучше использовать service_role).');
    process.exit(1);
  }

  console.log(`📊 Всего записей в таблице: ${allAccounts?.length || 0}`);

  if (!allAccounts || allAccounts.length === 0) {
    console.error('❌ База вернула 0 записей. Это признак включенного RLS (Row Level Security).');
    console.error('💡 Решение: Выключите RLS для таблицы midas_accounts или используйте service_role ключ.');
    process.exit(1);
  }

  // 2. Ищем нужный аккаунт
  let account;
  if (email) {
    account = allAccounts.find(a => a.email === email);
    if (!account) {
      console.error(`❌ Аккаунт с email ${email} не найден среди полученных записей.`);
      process.exit(1);
    }
  } else {
    // Фильтруем активные
    const activeOnes = allAccounts.filter(a => a.is_active === true);
    console.log(`✅ Активных (is_active: true) аккаунтов: ${activeOnes.length}`);
    
    if (activeOnes.length === 0) {
      console.error('❌ Все найденные аккаунты имеют статус is_active = false');
      process.exit(1);
    }
    account = activeOnes[0];
  }

  console.log('\n--- 🚀 ЗАПУСК АКТИВАЦИИ ---');
  console.log(`📧 Используем: ${account.email}`);
  console.log(`🎮 UID: ${uid}`);
  console.log(`🎁 Код: ${code}`);

  const startTime = Date.now();
  
  try {
    const result = await activateSingleCode(
      { email: account.email, pass: account.password },
      uid,
      code
    );

    const duration = (Date.now() - startTime) / 1000;
    console.log('\n--- 🏁 РЕЗУЛЬТАТ ---');
    console.log(`📋 Итог: ${result}`);
    console.log(`⏱️ Время: ${duration} сек.`);
  } catch (e: any) {
    console.error('\n💥 КРИТИЧЕСКАЯ ОШИБКА ВЫПОЛНЕНИЯ:', e.message);
  }

  process.exit(0);
}

run().catch((e) => {
  console.error('❌ Необработанная ошибка:', e);
  process.exit(1);
});