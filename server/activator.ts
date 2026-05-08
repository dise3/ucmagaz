import { chromium } from 'playwright';
import type { Frame, Page } from 'playwright';
import path from 'path';
import fs from 'fs';

export type ActivationResult = 'SUCCESS' | 'CAPTCHA' | 'ERROR' | 'ALREADY_REDEEMED';

const STEALTH_ARGS = [
    '--disable-blink-features=AutomationControlled',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--window-position=0,0'
];

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * ОЧИСТКА И РАЗБЛОКИРОВКА СТРАНИЦЫ
 */
async function killEverythingOverContent(page: Page) {
    await page.evaluate(() => {
        const badSelectors = [
            '.wrappper_WrOIO', '.visible_1ws1M', '.cumulativeRecharge',
            '[class*="PopUp"]', '.PopUp', '.v-modal', '.modal-mask', '.home-pop',
            '.pagedoo-loading',
            '.VipTips_vip_level_icon__f6Y92', 
            '[class*="VipTips"]', 
            '.tips_wrap'
        ];
        
        badSelectors.forEach(s => {
            document.querySelectorAll(s).forEach(el => el.remove());
        });

        document.querySelectorAll('body *').forEach(el => {
            const style = window.getComputedStyle(el);
            if (parseInt(style.zIndex) > 100) {
                (el as HTMLElement).style.setProperty('display', 'none', 'important');
            }
        });

        const unlockStyles = `
            html, body {
                overflow: auto !important;
                overflow-y: auto !important;
                height: auto !important;
                position: relative !important;
                pointer-events: auto !important;
            }
        `;
        const styleSheet = document.createElement("style");
        styleSheet.innerText = unlockStyles;
        document.head.appendChild(styleSheet);
    }).catch(() => {});
}

async function ensureRussianLanguage(page: Page) {
    // Добавляем параметр lang=ru в URL, если его нет
    const url = page.url();
    if (!url.includes('lang=ru')) {
        const newUrl = url + (url.includes('?') ? '&lang=ru' : '?lang=ru');
        await page.goto(newUrl, { waitUntil: 'domcontentloaded' });
        console.log('[🌐] Добавлен параметр lang=ru, перезагружено');
    }

    // Ждём появления русских слов (указываем несколько вариантов)
    await page.waitForFunction(
        () => {
            const body = document.body.innerText;
            return /Войти|Авторизация|Регистрация|Личный кабинет|Войти в аккаунт|другими способами/i.test(body);
        },
        { timeout: 15000 }
    ).catch(() => console.log('[⚠️] Русский текст не обнаружен после lang=ru, пробую через переключатель...'));

    // Если русский текст не появился, пробуем через переключатель языка в интерфейсе
    const langSwitcher = page.locator('[class*="language"], [class*="locale"], .lang-switch, [data-testid="language-selector"]').first();
    if (await langSwitcher.isVisible({ timeout: 5000 }).catch(() => false)) {
        const currentLang = await langSwitcher.textContent();
        if (!currentLang?.includes('RU') && !currentLang?.includes('Рус')) {
            await langSwitcher.click();
            const russianOption = page.locator('text=/Русский|Russian/i').first();
            await russianOption.waitFor({ state: 'visible', timeout: 5000 });
            await russianOption.click();
            await page.waitForTimeout(2000);
            console.log('[✅] Язык принудительно переключён на русский');
        } else {
            console.log('[✅] Язык уже русский по переключателю');
        }
    }
}

export async function activateSingleCode(account: { email: string, pass: string }, uid: string, code: string, headless: boolean = true): Promise<ActivationResult> {
    const safeEmail = account.email.replace(/[^a-zA-Z0-9]/g, '_');
    const userDataDir = path.resolve(process.cwd(), `sessions/${safeEmail}`);
    
    // Очищаем старую сессию для корректного определения языка
    if (fs.existsSync(userDataDir)) {
        fs.rmSync(userDataDir, { recursive: true, force: true });
    }
    
    fs.mkdirSync(userDataDir, { recursive: true });

    const context = await chromium.launchPersistentContext(userDataDir, {
        headless: headless,
        viewport: { width: 1280, height: 720 },
        args: STEALTH_ARGS,
        userAgent: USER_AGENT,
        locale: 'ru-RU',
        timezoneId: 'Europe/Moscow',
        extraHTTPHeaders: { 'Accept-Language': 'ru-RU' },
        geolocation: { latitude: 55.7558, longitude: 37.6173 }
    });

    const page = context.pages()[0] || await context.newPage();
    let result: ActivationResult = 'ERROR';

    // Диагностика настроек браузера
    const locale = await page.evaluate(() => navigator.language);
    const timezone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
    console.log(`[🔧] Браузер: locale=${locale}, timezone=${timezone}`);

    try {
        console.log(`[🌐] Загрузка Midasbuy...`);
        await page.goto('https://www.midasbuy.com/midasbuy/ru/redeem/pubgm', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(15000); 
        await ensureRussianLanguage(page);
        // await killEverythingOverContent(page);
        const acceptCookiesBtn = page.locator('div, button').filter({ hasText: /^Принять все$|^Accept all$/i }).first();
        if (await acceptCookiesBtn.isVisible().catch(() => false)) {
            console.log(`[🍪] Обнаружены куки, принимаю...`);
            await acceptCookiesBtn.click({ force: true });
            await page.waitForTimeout(2000);
        }

        const emailLabel = page.locator('p[class*="MobileNav_country"][title*="@"]').first();
        let isLoggedIn = await emailLabel.isVisible({ timeout: 4000 }).catch(() => false);

        if (!isLoggedIn) {
            console.log(`[🔑] Авторизация...`);
            const loginBtn = page.locator('text="Войти в аккаунт Midasbuy"').or(page.locator('text="Log in"')).first();
            
            await loginBtn.waitFor({ state: 'visible', timeout: 10000 });
            await loginBtn.click({ force: true });


            await page.waitForTimeout(15000);
            // Снимаем фокус с кнопки, чтобы она не оставалась в активном (синем) состоянии
            await loginBtn.evaluate((el) => {
                (el as HTMLElement).blur();
            }).catch(() => {});
            await page.evaluate(() => document.body.focus()).catch(() => {});
            
            
            let authFrame: Frame | null = null;
            for (let i = 0; i < 5; i++) {
                for (const frame of page.frames()) {
                    if (await frame.locator('.to-other-login').count() > 0 || await frame.locator('input[type="email"]').count() > 0) {
                        authFrame = frame;
                        break;
                    }
                }
                if (authFrame) break;
                await page.waitForTimeout(3000);
            }

            let target: Page | Frame = authFrame || page;

            if (authFrame) {
                console.log(`[🎯] Фрейм найден.`);
                const frameButtons = await authFrame.locator('button, div[role="button"], .btn, a, span').all();
                const frameButtonTexts = await Promise.all(frameButtons.map(async b => {
                    try {
                        return await b.innerText();
                    } catch {
                        return '';
                    }
                }));
                console.log(`[🔍] Кнопки в фрейме: ${frameButtonTexts.filter(t => t.trim()).join(' | ')}`);
                let clicked = false;
                
                // Вариант 1: Класс .to-other-login — нужная кнопка (RU: <div class="to-other-login"><span>Войти/зарегистрироваться другими способами</span></div>)
                const toOtherLogin = authFrame.locator('.to-other-login');
                if (await toOtherLogin.count() > 0) {
                    console.log('[🔍] Найден .to-other-login, кликаю...');
                    try {
                        await toOtherLogin.first().click({ force: true, timeout: 5000 });
                        clicked = true;
                        console.log('[✅] Клик по .to-other-login выполнен');
                    } catch (e) {
                        // Если Playwright не смог — клик через JS
                        try {
                            await toOtherLogin.first().evaluate((el) => {
                                (el as HTMLElement).click();
                            });
                            clicked = true;
                            console.log('[✅] Клик по .to-other-login выполнен (JS)');
                        } catch (e2) {
                            console.log('[⚠️] Не удалось кликнуть .to-other-login:', e2);
                        }
                    }
                }
                
                // Вариант 2: Класс .cancel-txt (английская версия: куки + первый вход)
                if (!clicked) {
                    const cancelTxt = page.locator('text="Other Ways Sign In/Up"')
                    if (await cancelTxt.count() > 0) {
                        console.log('[🔍] Найден Other Ways Sign In/Up (EN), кликаю по кликабельному родителю...');
                        await cancelTxt.waitFor({ state: 'visible', timeout: 10000 });
                        await cancelTxt.click({ force: true });
                            clicked = true;
                            console.log('[✅] Клик по cancelTxt выполнен');
                    }
                } else {
                    console.log('[ℹ️] Кнопка Other Ways Sign In/Up не найдена');
                }
                
                // Вариант 2: Поиск по тексту и клик через JS с dispatchEvent
                if (!clicked) {
                    const textElement = authFrame.getByText(/Other Ways Sign In|Войти.*другими|Другие способы/i);
                    if (await textElement.count() > 0) {
                        console.log('[🔍] Найден элемент с текстом "другие способы", кликаю через JS...');
                        try {
                            const clickedResult = await textElement.first().evaluate((el) => {
                                // Ищем ближайший кликабельный родитель
                                let current: HTMLElement | null = el as HTMLElement;
                                let attempts = 0;
                                while (current && current !== document.body && attempts < 10) {
                                    attempts++;
                                    // Проверяем различные варианты кликабельных элементов
                                    if (current.tagName === 'A' || current.tagName === 'BUTTON' || 
                                        current.getAttribute('role') === 'button' ||
                                        current.onclick !== null ||
                                        current.getAttribute('onclick') ||
                                        current.classList.contains('btn') || 
                                        current.classList.contains('cancel') ||
                                        current.classList.contains('btn-wrap') ||
                                        current.classList.contains('to-other-login')) {
                                        // Пробуем обычный клик
                                        try {
                                            (current as HTMLElement).click();
                                        } catch {
                                            // Если не сработал, пробуем dispatchEvent
                                            const clickEvent = new MouseEvent('click', {
                                                bubbles: true,
                                                cancelable: true,
                                                view: window
                                            });
                                            current.dispatchEvent(clickEvent);
                                        }
                                        return true;
                                    }
                                    current = current.parentElement;
                                }
                                // Если не нашли родителя, пробуем кликнуть сам элемент
                                try {
                                    (el as HTMLElement).click();
                                } catch {
                                    const clickEvent = new MouseEvent('click', {
                                        bubbles: true,
                                        cancelable: true,
                                        view: window
                                    });
                                    el.dispatchEvent(clickEvent);
                                }
                                return true;
                            });
                            if (clickedResult) {
                                clicked = true;
                                console.log('[✅] JS клик выполнен');
                            }
                        } catch (e) {
                            console.log('[⚠️] JS клик не сработал:', e);
                        }
                    }
                }
                
                // Вариант 3: Поиск через locator с фильтром
                if (!clicked) {
                    try {
                        const otherBtn = authFrame.locator('a, button, div[role="button"], [class*="btn"], [class*="cancel"], [class*="btn-wrap"], [class*="to-other"]').filter({
                            hasText: /Other Ways Sign In|Войти.*другими|Другие способы/i
                        }).first();
                        if (await otherBtn.count() > 0) {
                            console.log('[🔍] Найден элемент через locator, кликаю...');
                            await otherBtn.click({ force: true, timeout: 3000 });
                            clicked = true;
                            console.log('[✅] Клик через locator выполнен');
                        }
                    } catch (e) {
                        console.log('[⚠️] Не удалось кликнуть через locator:', e);
                    }
                }
                if (clicked) {
                    console.log('[🔘] Нажимаю войти другим способом');
                    // Увеличиваем время ожидания после клика
                    await page.waitForTimeout(5000);
                    // Проверяем, появилось ли поле email
                    try {
                        await target.locator('input[type="email"]').waitFor({ state: 'visible', timeout: 5000 });
                        console.log('[✅] Форма email открылась');
                    } catch {
                        console.log('[⚠️] Форма email еще не открылась, жду еще...');
                        await page.waitForTimeout(3000);
                    }
                } else {
                    console.log('[ℹ️] Кнопка «другие способы» не найдена');
                }
            }
            
            console.log(`[📧] Заполняю email...`);
            const emailInput = target.locator('input[type="email"]');
            const emailVisible = await emailInput.first().isVisible().catch(() => false);
            if (emailVisible) {
                await emailInput.fill(account.email, { force: true });
            } else {
                await emailInput.waitFor({ state: 'attached', timeout: 10000 });
                await emailInput.first().evaluate((el, email) => {
                    const input = el as HTMLInputElement;
                    input.value = email;
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                }, account.email);
                console.log('[📧] Email введен в скрытое поле (EN-форма)');
            }
            await page.waitForTimeout(1000);
            
            const continueBtn = target.locator('.comfirm-btn').filter({ hasText: /Продолжить|Continue/i });
            if (await continueBtn.count() > 0) {
                try {
                    await continueBtn.first().evaluate((el) => (el as HTMLElement).click());
                } catch {
                    await continueBtn.first().click({ force: true });
                }
            }
            await page.waitForTimeout(2000);
            
            const passwordInput = target.locator('input[type="password"]');
            const passwordVisible = await passwordInput.first().isVisible().catch(() => false);
            if (passwordVisible) {
                await passwordInput.fill(account.pass, { force: true });
            } else {
                await passwordInput.waitFor({ state: 'attached', timeout: 8000 });
                await passwordInput.first().evaluate((el, pass) => {
                    const input = el as HTMLInputElement;
                    input.value = pass;
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                }, account.pass);
                console.log('[🔒] Пароль введен в скрытое поле (EN-форма)');
            }
            
            await page.waitForTimeout(2000); // Ждем появления кнопки
            
            const submitLoginBtn = target.locator('.comfirm-btn').filter({ hasText: /Вход|Log In/i });
            console.log(`[🔍] Ищем кнопку входа...`);
            await submitLoginBtn.waitFor({ state: 'visible', timeout: 10000 })
            const btnCount = await submitLoginBtn.count();
            console.log(`[🔍] Найдено кнопок входа: ${btnCount}`);
            
            if (btnCount > 0) {
                console.log(`[🔘] Нажимаю кнопку входа...`);
                try {
                    await submitLoginBtn.first().click({ force: true });
                } catch (e) {
                    console.log('[⚠️] Не удалось кликнуть по кнопке входа обычным способом, пробую через JS...', e);
                }
            } else {
                console.log('[⚠️] Кнопка входа не найдена, пробуем альтернативные селекторы...');
                // Альтернативные селекторы
                const altBtn = target.locator('button[type="submit"], .login-btn, [class*="submit"], [class*="login"]').filter({ hasText: /Вход|Log In|Sign In|Login/i }).first();
                if (await altBtn.count() > 0) {
                    await altBtn.click({ force: true });
                    console.log('[✅] Альтернативная кнопка входа нажата');
                } else {
                    console.log('[❌] Кнопка входа не найдена вообще');
                }
            }
            
            await page.waitForTimeout(8000);
        }
        
        await page.waitForTimeout(3000);

        console.log('Очистка');
        await page.waitForTimeout(3000);
        await page.evaluate(() => {
            }).catch(() => {});
        const switchUidBtn = page.locator('[class*="UserDataBox_switch_btn"]').first();
        const openIdBtn = page.locator('div[class*="Button"], button').filter({ hasText: /^Введите ID игрока$/i }).first();
        const idInputInModal = page.locator('input[placeholder*="Введите ID"], .input-account').first();
        
        let isIdModalVisible = await idInputInModal.isVisible().catch(() => false);
        if (!isIdModalVisible) {
            if (await switchUidBtn.count() > 0) {
                console.log(`[🖱️] Смена UID...`);
                await switchUidBtn.click({ force: true });
            } else if (await openIdBtn.count() > 0) {
                console.log(`[🖱️] Новый ввод UID...`);
                await openIdBtn.click({ force: true });
            }
            await page.waitForTimeout(2000);
        }
        await idInputInModal.waitFor({ state: 'attached', timeout: 15000 });
        const idInputVisible = await idInputInModal.isVisible().catch(() => false);
        
        // Очищаем поле перед вводом нового UID
        await idInputInModal.evaluate((el) => {
            const input = el as HTMLInputElement;
            input.value = '';
            input.focus();
            input.select();
        }).catch(() => {});
        
        if (idInputVisible) {
            await idInputInModal.fill(uid);
        } else {
            await idInputInModal.evaluate((el, id) => {
                const input = el as HTMLInputElement;
                input.value = id;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
            }, uid);
            console.log('[🆔] UID введен в скрытое поле');
        }
        
        const okIdBtn = page.locator('[class*="Button_text"]', { hasText: /^(Окей|Ок|OK)$/i }).first();
        if (await okIdBtn.count() > 0) {
            try {
                await okIdBtn.evaluate((el) => (el as HTMLElement).click());
            } catch {
                await okIdBtn.click({ force: true });
            }
        }
        
        await page.waitForTimeout(3000); 
        await killEverythingOverContent(page); 

        console.log(`[🎁] Ввод кода: ${code}`);
        const codeInput = page.locator('input[placeholder="Введите код обмена"]').first();
        await codeInput.waitFor({ state: 'attached', timeout: 10000 });
        const codeInputVisible = await codeInput.isVisible().catch(() => false);
        if (codeInputVisible) {
            await codeInput.fill(code);
        } else {
            await codeInput.evaluate((el, c) => {
                const input = el as HTMLInputElement;
                input.value = c;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
            }, code);
            console.log('[🎁] Код введен в скрытое поле');
        }
        
        console.log(`[🔘] Нажимаю первый "Ок"...`);
        const firstOkBtn = page.locator('[class*="Button_text"]', { hasText: /^Ок$/i }).last();
        if (await firstOkBtn.count() > 0) {
            try {
                await firstOkBtn.evaluate((el) => (el as HTMLElement).click());
            } catch {
                await firstOkBtn.click({ force: true });
            }
        }

        console.log(`[🔘] Ожидание кнопки "Отправить"...`);
        const confirmSendBtn = page.locator('[class*="Button_text"]', { hasText: /^Отправить$/i }).first();
        try {
            await confirmSendBtn.waitFor({ state: 'attached', timeout: 10000 });
            try {
                await confirmSendBtn.evaluate((el) => (el as HTMLElement).click());
            } catch {
                await confirmSendBtn.click({ force: true });
            }
        } catch (e) {
            console.log(`[❌] Кнопка "Отправить" не появилась - код нерабочий`);
            return 'ALREADY_REDEEMED';
        }

        console.log(`[⏳] Ожидание финального результата...`);
        const resultPopup = page.locator('.PopUp .content, .modal-content, .result-title, [class*="PurchaseContainer_text"]').first();
        await resultPopup.waitFor({ state: 'attached', timeout: 15000 });
        const text = (await resultPopup.innerText()).toLowerCase();
        
        console.log(`[📄] Ответ сайта: ${text.replace(/\n/g, ' ')}`);

        if (text.includes('success') || text.includes('успешно')) result = 'SUCCESS';
        else if (text.includes('already') || text.includes('использован')) result = 'ALREADY_REDEEMED';
        else if (text.includes('busy') || text.includes('captcha')) result = 'CAPTCHA';
        else result = 'ERROR';

    } catch (e: any) {
        console.error(`[❌] Ошибка: ${e.message}`);
        if (e.message.includes('Timeout') || e.message.includes('visible') || e.message.includes('editable')) {
            result = 'CAPTCHA'; // Аккаунт в капче или заблокирован
        } else {
            result = 'ERROR'; // Другая ошибка (битый код)
        }
    } finally {
        await page.evaluate(() => {
            document.body.style.overflow = 'auto';
            document.documentElement.style.overflow = 'auto';
        }).catch(() => {});

        console.log(`[🕒] Ожидание перед закрытием (тест).`);
        await context.close();
    }
    return result;
}