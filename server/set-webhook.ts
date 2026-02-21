/**
 * Установка webhook для Telegram бота
 * Запуск: npx ts-node set-webhook.ts [URL]
 * Без URL — использует BACKEND_URL из .env
 * 
 * Пример: npx ts-node set-webhook.ts https://xxxxx-109-184-135-202.ru.tuna.am
 */
import 'dotenv/config';
import axios from 'axios';

const BOT_TOKEN = process.env.BOT_TOKEN;
const BACKEND_URL = process.env.BACKEND_URL || process.argv[2];

if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN не задан в .env');
  process.exit(1);
}

const webhookUrl = BACKEND_URL ? `${BACKEND_URL.replace(/\/$/, '')}/api/bot-webhook` : null;

if (!webhookUrl) {
  console.error('❌ Укажите URL в .env (BACKEND_URL) или как аргумент: npx ts-node set-webhook.ts <URL>');
  console.log('\nПример: npx ts-node set-webhook.ts https://xxxxx-109-184-135-202.ru.tuna.am');
  process.exit(1);
}

async function main() {
  console.log('🔗 Устанавливаю webhook:', webhookUrl);
  
  const { data } = await axios.get(
    `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`,
    { params: { url: webhookUrl } }
  );

  if (data.ok) {
    console.log('✅ Webhook установлен');
  } else {
    console.error('❌ Ошибка:', data.description);
  }

  const info = await axios.get(`https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`);
  console.log('📋 Текущий webhook:', info.data.result?.url || '(не установлен)');
}

main().catch((e: any) => {
  console.error('❌ Ошибка:', e.message);
  if (e.response?.data) {
    console.error('Ответ Telegram:', JSON.stringify(e.response.data, null, 2));
  }
  process.exit(1);
});
