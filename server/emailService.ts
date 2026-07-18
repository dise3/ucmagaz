import nodemailer from 'nodemailer';

// Типы для конфига
interface EmailConfig {
    host: string;
    port: number;
    secure: boolean;
    auth: {
        user: string;
        pass: string;
    };
}

// Загружаем настройки из переменных окружения
const config: EmailConfig = {
    host: process.env.SMTP_HOST || 'smtp.yandex.ru',
    port: parseInt(process.env.SMTP_PORT || '465'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
        user: process.env.EMAIL_USER || '',
        pass: process.env.EMAIL_PASSWORD || '',
    },
};

const transporter = nodemailer.createTransport(config);

/**
 * Отправка письма с кодом PlayStation Gift
 * @param to - email получателя
 * @param code - активационный код
 * @param orderId - ID заказа (для подстановки в письмо)
 */
export async function sendGiftCodeEmail(
    to: string,
    code: string,
    orderId: number
): Promise<void> {
    try {
        await transporter.sendMail({
            from: `"UC Магазин" <${config.auth.user}>`,
            to,
            subject: '🎁 Ваш код для PlayStation Gift',
            html: `
        <h2>Спасибо за покупку!</h2>
        <p>Ваш заказ #${orderId} успешно оплачен.</p>
        <p>Вот ваш код для активации в PlayStation Store:</p>
        <div style="font-size: 28px; font-weight: bold; background: #f0f0f0; padding: 20px; border-radius: 10px; text-align: center; letter-spacing: 2px;">
          ${code}
        </div>
        <p>Если у вас возникли вопросы, обратитесь в поддержку.</p>
        <hr>
        <p style="color: #888; font-size: 12px;">Это письмо создано автоматически. Не отвечайте на него.</p>
      `,
        });
        console.log(`✅ Письмо с кодом отправлено на ${to} (заказ #${orderId})`);
    } catch (error) {
        console.error('❌ Ошибка отправки письма:', error);
        throw error; // пробрасываем, чтобы обработать на уровне вызова
    }
}