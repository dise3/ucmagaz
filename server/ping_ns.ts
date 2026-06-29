import { nsClient } from './ns_service';

async function run() {
    try {
        console.log("--- 🔑 Авторизация и проверка баланса ---");
        const data = await nsClient.call("GET", "/api/v2/check_balance");
        console.log("💰 Баланс:", data.balance, "USD");
    } catch (e: any) {
        console.error("❌ Ошибка:");
        if (e.response) {
            console.error(e.response.status, e.response.data);
        } else {
            console.error(e.message);
        }
    }
}

run();