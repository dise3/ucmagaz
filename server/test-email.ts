import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { sendGiftCodeEmail, verifyEmailConnection } from './emailService.ts'; // или .ts, смотря как настроен ts-node

// Получаем __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Загружаем .env из текущей папки
dotenv.config({ path: path.join(__dirname, '.env') });

console.log('🔍 EMAIL_USER:', process.env.EMAIL_USER || 'не задан');
console.log('🔍 EMAIL_PASSWORD:', process.env.EMAIL_PASSWORD ? 'установлен' : 'не установлен');

const TEST_EMAIL = 'koshax99@gmail.com';
const TEST_CODE = 'ABCD-1234-EFGH-5678';
const TEST_ORDER_ID = 99999;

async function testEmail() {
    console.log('\n📧 Тест отправки письма...');
    console.log(`➡️ Получатель: ${TEST_EMAIL}`);
    console.log(`🔑 Код: ${TEST_CODE}`);
    console.log(`📦 Заказ: #${TEST_ORDER_ID}`);

    const isConnected = await verifyEmailConnection();
    if (!isConnected) {
        console.error('❌ Не удалось установить SMTP-соединение. Проверьте настройки .env и сеть.');
        return;
    }

    try {
        await sendGiftCodeEmail(TEST_EMAIL, TEST_CODE, TEST_ORDER_ID);
        console.log('✅ Письмо успешно отправлено! Проверьте почту (и папку Спам).');
    } catch (error) {
        console.error('❌ Ошибка при отправке:', error);
    }
}

testEmail();