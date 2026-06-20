import { KokosApiEnvironment, KokosApiClient, KokosApiError } from "kokos-activator-api";
import dotenv from 'dotenv';

dotenv.config();

export type ActivationResult = 'SUCCESS' | 'CAPTCHA' | 'ERROR' | 'ALREADY_REDEEMED';

const client = new KokosApiClient({
  environment: KokosApiEnvironment.Production,
  token: process.env.KOKOS_API_KEY || ""
});

export async function activateSingleCode(
    _account: { email: string, pass: string }, // Мы оставляем это здесь для совместимости с bot_manager
    uid: string,
    code: string,
    _headless: boolean = true
): Promise<ActivationResult> {
    
    console.log(`[API-Request] UID: ${uid}, Code: ${code}`);

    try {
        // УДАЛЯЕМ свойство 'account' отсюда. API само выберет аккаунт.
        const result = await client.redeem.redeemCode({
            requireReceipt: true, 
            playerId: uid,
            codeOverride: code,
        });

        console.log(`✅ SUCCESS: Игрок ${result.name}`);
        // В ответе (result) придут email и password аккаунта, который использовало API.
        return 'SUCCESS';

    } catch (error: any) {
        if (error instanceof KokosApiError) {
            const body = error.body as any;
            const errorCode = body?.errorCode;

            console.log(`❌ API Error [${error.statusCode}]: ${errorCode || error.message}`);

            switch (errorCode) {
                case 'CODE_USED':
                case 'INVALID_CODE':
                    return 'ALREADY_REDEEMED';

                case 'NO_ACCOUNTS_AVAILABLE':
                case 'LOGIN_FAILED':
                case 'RISK_CONTROL':
                    return 'CAPTCHA';

                case 'CHARACTER_NOT_FOUND':
                case 'INVALID_ACTIVATION_RESPONSE':
                case 'UNKNOWN':
                case 'NETWORK_ERROR':
                    return 'ERROR';

                default:
                    return 'ERROR';
            }
        }

        console.error("⚠️ System Error:", error.message);
        return 'ERROR';
    }
}