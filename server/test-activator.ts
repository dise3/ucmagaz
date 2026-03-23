/**
 * Тест активатора — запуск без HTTP сервера
 * Использование: npx ts-node test-activator.ts <uid> <code> [email]
 * Пример: npx ts-node test-activator.ts 123456789 KP4JUdne2r22kc40k0
 * Пример с email: npx ts-node test-activator.ts 123456789 KP4JUdne2r22kc40k0 MidasBuyMy1@hotmail.com
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { activateSingleCode } from './activator.ts';

const uid = process.argv[2];
const code = process.argv[3];
const email = process.argv[4];

if (!uid || !code) {
  console.log('Использование: npx ts-node test-activator.ts <uid> <code> [email]');
  console.log('Пример: npx ts-node test-activator.ts 123456789 KP4JUdne2r22kc40k0');
  console.log('Пример с email: npx ts-node test-activator.ts 123456789 KP4JUdne2r22kc40k0 MidasBuyMy1@hotmail.com');
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_KEY!
);

async function run() {
  let account;
  
  if (email) {
    // Ищем аккаунт по email
    const { data: accounts } = await supabase
      .from('midas_accounts')
      .select('*')
      .eq('email', email)
      .limit(1);
    
    if (!accounts?.length) {
      console.error(`❌ Аккаунт с email ${email} не найден в базе`);
      process.exit(1);
    }
    account = accounts[0];
  } else {
    // Берем первый активный
    const { data: accounts } = await supabase
      .from('midas_accounts')
      .select('*')
      .eq('is_active', true)
      .order('id', { ascending: true })
      .limit(1);

    if (!accounts?.length) {
      console.error('❌ Нет активных аккаунтов Midasbuy в базе');
      process.exit(1);
    }
    account = accounts[0];
  }
  console.log(`📧 Аккаунт: ${account.email}`);
  console.log(`🎮 UID: ${uid}`);
  console.log(`🎁 Код: ${code}`);
  console.log('🚀 Запуск активатора (браузер откроется)...\n');

  const result = await activateSingleCode(
    { email: account.email, pass: account.password },
    uid,
    code,
    false // headless = false — показывать браузер
  );

  console.log(`\n📋 Результат: ${result}`);
  process.exit(0);
}

run().catch((e) => {
  console.error('❌ Ошибка:', e);
  process.exit(1);
});
