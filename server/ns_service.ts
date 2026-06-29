import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import axios from 'axios';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '.env') });

class NSV2Service {
    private USER_ID = process.env.NS_USER_ID || '';
    private LOGIN = process.env.NS_LOGIN || '';
    private PASSWORD = process.env.NS_PASSWORD || '';
    private API_SECRET = process.env.NS_API_SECRET || '';
    private BASE_URL = process.env.NS_BASE_URL || 'https://api.ns.gifts';

    private _token: string | null = null;

    // Аналог Python _sign
    private _sign(method: string, path: string, query: string, body: Buffer, ts: string, token: string | null): string {
        // 1. Хэшируем тело (sha256 hex)
        const bodyHash = crypto.createHash('sha256').update(body).digest('hex');

        // 2. Собираем части строки для подписи
        const parts = [method.toUpperCase(), path, query, ts];
        if (token !== null) {
            parts.push(token);
        }
        parts.push(bodyHash);

        const stringToSign = parts.join('\n');

        // 3. HMAC-SHA256 подпись
        const secretBuffer = Buffer.from(this.API_SECRET, 'base64');
        const signature = crypto
            .createHmac('sha256', secretBuffer)
            .update(stringToSign)
            .digest('base64');

        return signature;
    }

    public async login() {
        const path = '/api/v2/get_token';
        // Аналог json.dumps(..., separators=(',', ':')) - в JS это просто JSON.stringify
        const bodyData = JSON.stringify({ login: this.LOGIN, password: this.PASSWORD });
        const bodyBuffer = Buffer.from(bodyData);
        
        const ts = Math.floor(Date.now() / 1000).toString();
        
        const headers = {
            "X-User-Id": this.USER_ID,
            "X-Timestamp": ts,
            "X-Signature": this._sign("POST", path, "", bodyBuffer, ts, null),
            "Content-Type": "application/json",
        };

        const r = await axios.post(this.BASE_URL + path, bodyData, { headers, timeout: 30000 });
        this._token = r.data.token;
        return this._token;
    }

    public async call(method: string, path: string, params: any = null, jsonBody: any = null): Promise<any> {
        if (!this._token) {
            await this.login();
        }

        const query = params ? new URLSearchParams(params).toString() : "";
        const bodyData = jsonBody ? JSON.stringify(jsonBody) : "";
        const bodyBuffer = Buffer.from(bodyData);
        const ts = Math.floor(Date.now() / 1000).toString();

        const headers: any = {
            "X-User-Id": this.USER_ID,
            "X-Timestamp": ts,
            "X-Token": this._token!,
            "X-Signature": this._sign(method, path, query, bodyBuffer, ts, this._token),
            "Content-Type": "application/json",
        };

        const url = this.BASE_URL + path + (query ? `?${query}` : "");

        try {
            const r = await axios({
                method,
                url,
                headers,
                data: bodyData || undefined,
                timeout: 30000
            });
            return r.data;
        } catch (error: any) {
            // Если токен истек (401), пробуем один раз перелогиниться
            if (error.response?.status === 401) {
                await this.login();
                // Повторяем вызов с новым токеном
                return this.call(method, path, params, jsonBody);
            }
            throw error;
        }
    }
}

export const nsClient = new NSV2Service();