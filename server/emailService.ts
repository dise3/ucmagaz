import nodemailer from 'nodemailer';

interface EmailConfig {
    host: string;
    port: number;
    secure: boolean;
    auth: {
        user: string;
        pass: string;
    };
    tls?: {
        rejectUnauthorized?: boolean;
    };
    connectionTimeout?: number;
    greetingTimeout?: number;
    socketTimeout?: number;
}

// Загружаем настройки с приоритетом: если переменная не задана – пробуем разные варианты
const getConfig = (): EmailConfig => {
    const host = process.env.SMTP_HOST || 'smtp.yandex.ru';
    const port = parseInt(process.env.SMTP_PORT || '587');
    const secure = process.env.SMTP_SECURE === 'true';
    const user = process.env.EMAIL_USER || '';
    const pass = process.env.EMAIL_PASSWORD || '';

    return {
        host,
        port,
        secure,
        auth: { user, pass },
        tls: { rejectUnauthorized: false },
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 15000,
    };
};

let transporter: nodemailer.Transporter | null = null;

function getTransporter() {
    if (!transporter) {
        transporter = nodemailer.createTransport(getConfig());
    }
    return transporter;
}

export async function sendGiftCodeEmail(to: string, code: string, orderId: number): Promise<void> {
    const config = getConfig();
    if (!config.auth.user || !config.auth.pass) {
        throw new Error('SMTP credentials are missing. Check EMAIL_USER and EMAIL_PASSWORD in .env');
    }

    const transporter = getTransporter();
    try {
        const info = await transporter.sendMail({
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
        console.log(`   Message ID: ${info.messageId}`);
    } catch (error: any) {
        console.error('❌ Ошибка отправки письма:', error.message || error);
        throw new Error(`Ошибка отправки письма: ${error.message}`);
    }
}

export async function verifyEmailConnection(): Promise<boolean> {
    try {
        const transporter = getTransporter();
        await transporter.verify();
        console.log('✅ SMTP соединение успешно установлено');
        return true;
    } catch (error: any) {
        console.error('❌ SMTP соединение не удалось:', error.message);
        return false;
    }
}