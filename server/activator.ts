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

export async function activateSingleCode(account: { email: string, pass: string }, uid: string, code: string, headless: boolean = true): Promise<ActivationResult> {
    const safeEmail = account.email.replace(/[^a-zA-Z0-9]/g, '_');
    const userDataDir = path.resolve(process.cwd(), `sessions/${safeEmail}`);
    if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });

    const context = await chromium.launchPersistentContext(userDataDir, {
        headless: headless,
        viewport: { width: 1280, height: 720 },
        args: STEALTH_ARGS,
        userAgent: USER_AGENT,
        locale: 'ru-RU'
    });

    const page = context.pages()[0] || await context.newPage();
    let result: ActivationResult = 'ERROR';

    try {
        console.log(`[🌐] Загрузка Midasbuy...`);
        await page.goto('https://www.midasbuy.com/midasbuy/ru/redeem/pubgm', { waitUntil: 'domcontentloaded', timeout: 60000 });
        
        await page.waitForTimeout(15000); 
        await killEverythingOverContent(page);
        const acceptCookiesBtn = page.locator('div, button').filter({ hasText: /^Принять все$|^Accept all$/i }).first();
        if (await acceptCookiesBtn.isVisible().catch(() => false)) {
            console.log(`[🍪] Обнаружены куки, принимаю...`);
            await acceptCookiesBtn.click({ force: true });
            await page.waitForTimeout(4000);
        }

        const emailLabel = page.locator('p[class*="MobileNav_country"][title*="@"]').first();
        let isLoggedIn = await emailLabel.isVisible({ timeout: 4000 }).catch(() => false);

        if (!isLoggedIn) {
            console.log(`[🔑] Авторизация...`);
            const loginBtn = page.locator('text="Войти в аккаунт Midasbuy"').or(page.locator('text="Log in"')).first();
            
            await loginBtn.waitFor({ state: 'visible', timeout: 10000 });
            await loginBtn.click({ force: true });
            // Снимаем фокус с кнопки, чтобы она не оставалась в активном (синем) состоянии
            await loginBtn.evaluate((el) => {
                (el as HTMLElement).blur();
            }).catch(() => {});
            await page.evaluate(() => document.body.focus()).catch(() => {});
            
            await page.waitForTimeout(7000);
            
            let authFrame: Frame | null = null;
            for (let i = 0; i < 5; i++) {
                for (const frame of page.frames()) {
                    if (await frame.locator('.to-other-login').count() > 0 || await frame.locator('input[type="email"]').count() > 0) {
                        authFrame = frame;
                        break;
                    }
                }
                if (authFrame) break;
                await page.waitForTimeout(1000);
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
                    const cancelTxt = authFrame.locator('.cancel-txt');
                    if (await cancelTxt.count() > 0) {
                        console.log('[🔍] Найден .cancel-txt (EN), кликаю по кликабельному родителю...');
                        try {
                            await cancelTxt.first().evaluate((el) => {
                                const trigger = (target: HTMLElement) => {
                                    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
                                    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
                                    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                                };
                                let parent = el.parentElement;
                                while (parent && parent !== document.body) {
                                    if (parent.classList.contains('to-other-login')) {
                                        trigger(parent);
                                        return;
                                    }
                                    if (parent.classList.contains('btn-wrap') || parent.classList.contains('btn')) {
                                        trigger(parent);
                                        return;
                                    }
                                    parent = parent.parentElement;
                                }
                                trigger(el as HTMLElement);
                            });
                            clicked = true;
                            console.log('[✅] Клик по .cancel-txt выполнен');
                        } catch (e) {
                            console.log('[⚠️] Не удалось кликнуть .cancel-txt:', e);
                        }
                    }
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
            await page.waitForTimeout(1500);
            
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
            
            const submitLoginBtn = target.locator('.comfirm-btn').filter({ hasText: /Вход|Log In/i });
            if (await submitLoginBtn.count() > 0) {
                try {
                    await submitLoginBtn.first().evaluate((el) => (el as HTMLElement).click());
                } catch {
                    await submitLoginBtn.first().click({ force: true });
                }
            }
            await page.waitForTimeout(8000);
        }
        
        await page.waitForTimeout(3000);

        await page.waitForTimeout(50000);
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