import React, { useState, useEffect, useMemo } from 'react';
import { ChevronLeft, HelpCircle, CheckCircle2, X, Loader2, Home } from 'lucide-react';

// Обновленный компонент статуса с поддержкой разных сообщений
const PaymentStatusOverlay: React.FC<{
  orderId: string;
  onClose: () => void;
  apiBase: string;
  type?: string;
}> = ({ orderId, onClose, apiBase, type }) => {
  const [status, setStatus] = useState<'pending' | 'paid'>('pending');

  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`${apiBase}/api/check-status/${orderId}`, {
          headers: {
            'ngrok-skip-browser-warning': 'true',
            'tuna-skip-browser-warning': 'true'
          }
        });
        const data = await res.json();
        if (data.status === 'paid' || data.status === 'completed') {
          setStatus('paid');
          clearInterval(interval);
          if (window.Telegram?.WebApp?.HapticFeedback) {
            window.Telegram.WebApp.HapticFeedback.notificationOccurred('success');
          }
        }
      } catch (e) {
        console.error("Status check error:", e);
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [orderId, apiBase]);

  const getSuccessMessage = () => {
    if (type === 'steam_topup') return 'Средства будут зачислены на баланс Steam в течение 5-15 минут.';
    return 'Заказ оплачен. Товары будут зачислены на ваш аккаунт в течение 5-15 минут.';
  };

  return (
    <div className="fixed inset-0 bg-black/90 backdrop-blur-xl z-[200] flex flex-col items-center justify-center px-6 text-center animate-in fade-in duration-500">
      <div className="w-full max-w-xs space-y-8">
        {status === 'pending' ? (
          <>
            <div className="relative">
              <div className="absolute inset-0 bg-amber-500/20 blur-3xl rounded-full" />
              <Loader2 className="w-20 h-20 text-amber-500 animate-spin mx-auto relative z-10" strokeWidth={3} />
            </div>
            <div className="space-y-2">
              <h2 className="text-2xl font-black text-white uppercase italic tracking-tight">Ожидаем оплату</h2>
              <p className="text-white/50 font-medium text-sm leading-relaxed">
                Пожалуйста, завершите платеж. Статус обновится автоматически.
              </p>
            </div>
          </>
        ) : (
          <>
            <div className="relative">
              <div className="absolute inset-0 bg-green-500/20 blur-3xl rounded-full" />
              <CheckCircle2 className="w-20 h-20 text-green-500 mx-auto relative z-10 animate-bounce" strokeWidth={3} />
            </div>
            <div className="space-y-2">
              <h2 className="text-2xl font-black text-white uppercase italic tracking-tight">Успешно!</h2>
              <p className="text-white/50 font-medium text-sm leading-relaxed">
                {getSuccessMessage()}
              </p>
            </div>
          </>
        )}

        <button
          onClick={onClose}
          className="w-full bg-white/10 hover:bg-white/20 py-5 rounded-2xl text-white font-black uppercase tracking-widest transition-all active:scale-95 flex items-center justify-center gap-3 border border-white/10"
        >
          <Home size={20} />
          <span>На главную</span>
        </button>
      </div>
    </div>
  );
};

interface CheckoutProps {
  pack: {
    amount?: number;
    price?: number;
    basePrice?: number;
    image?: string;
    is_code?: boolean;
    is_skin?: boolean;
    is_prime?: boolean;
    items?: Array<{ id: number; amount: number; price: number; quantity: number }>;
    type?: 'pp' | 'tickets' | 'skin' | 'prime' | 'prime_plus' | 'uc' | 'steam_topup' | "ps_gift";
    title?: string;
    uid?: string;
    months?: number;
  };
  onBack: () => void;
}

const Checkout: React.FC<CheckoutProps> = ({ pack, onBack }) => {
  const [paymentMethod, setPaymentMethod] = useState<'sbp' | 'card'>('sbp');
  const [uid, setUid] = useState(pack.uid || '');
  const [username, setUsername] = useState('');
  const [showHelp, setShowHelp] = useState(false);
  const [showUsernameHelp, setShowUsernameHelp] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [activeOrderId, setActiveOrderId] = useState<string | null>(null);
  const [settings, setSettings] = useState<any>(null);

  const tg = (window as any).Telegram?.WebApp;
  const isTelegramApp = !!(window as any).Telegram?.WebApp;

  const VITE_API_NGROK = import.meta.env.VITE_API_NGROK;
  const isMultiCode = pack.items && pack.items.length > 0;
  const items = pack.items || [];

  useEffect(() => {
    const fetchData = async () => {
      try {
        const settingsRes = await fetch(`${VITE_API_NGROK}/api/settings`, {
          headers: {
            'ngrok-skip-browser-warning': 'true',
            'tuna-skip-browser-warning': 'true'
          }
        });
        setSettings(await settingsRes.json());
      } catch (e) {
        console.error("Settings error:", e);
      }
    };
    fetchData();
  }, [VITE_API_NGROK]);

  const COMMISSION_SBP = 0.0485;
  const COMMISSION_CARD = 0.071;

  const calculatePriceWithCommission = (basePrice: number, method: 'sbp' | 'card'): number => {
    const commission = method === 'sbp' ? COMMISSION_SBP : COMMISSION_CARD;
    return Math.ceil(basePrice * (1 + commission));
  };

  const getBasePrice = (priceSbp: number): number => {
    return priceSbp / (1 + COMMISSION_SBP);
  };

  const getPriceForMethod = (originalPrice: number, method: 'sbp' | 'card'): number => {
    const basePrice = getBasePrice(originalPrice);
    return calculatePriceWithCommission(basePrice, method);
  };

  const getTotalPrice = (): number => {
    if (!settings) return pack.price || 0;

    // --- ЛОГИКА STEAM ИЗ 2 ФАЙЛА ---
    if (pack.type === 'steam_topup') {
      const rate = settings.usd_rate_store || settings.usd_rate || 95;
      const steamFee = settings.steam_fee_percent || 0.15;
      const baseRub = (pack.amount || 0) * rate * (1 + steamFee);
      const commission = paymentMethod === 'sbp' ? COMMISSION_SBP : COMMISSION_CARD;
      return Math.floor(baseRub * (1 + commission) + 1);
    }

    if (pack.type === 'ps_gift') {
      const commission = paymentMethod === 'sbp' ? COMMISSION_SBP : COMMISSION_CARD;
      return Math.floor((pack.price || 0) * (1 + commission));
    }

    // ОСТАЛЬНАЯ ЛОГИКА
    if (pack.type === 'pp') {
      const base = (settings.pp_price_usd * ((pack.amount || 0) / 10000)) * settings.usd_rate + (settings.pp_markup_rub || 0);
      return calculatePriceWithCommission(Math.ceil(base), paymentMethod);
    } else if (pack.type === 'tickets') {
      const base = (settings.ticket_price_usd * ((pack.amount || 0) / 100)) * settings.usd_rate + (settings.ticket_markup_rub || 0);
      return calculatePriceWithCommission(Math.ceil(base), paymentMethod);
    } else if (pack.type === 'prime' || pack.type === 'prime_plus') {
      return calculatePriceWithCommission(pack.price || 0, paymentMethod);
    } else if (pack.type === 'skin') {
      return pack.price || 0;
    } else if (isMultiCode) {
      return items.reduce((sum: number, item: any) => sum + (getPriceForMethod(item.price, paymentMethod) * item.quantity), 0);
    } else {
      return calculatePriceWithCommission(pack.price || 0, paymentMethod);
    }
  };

  const triggerHapticFeedback = (style: 'light' | 'medium' | 'heavy' | 'success' | 'error' = 'medium') => {
    if (tg?.HapticFeedback) {
      if (style === 'success' || style === 'error') {
        tg.HapticFeedback.notificationOccurred(style);
      } else {
        tg.HapticFeedback.impactOccurred(style);
      }
    }
  };

  const handlePayment = async () => {
    setIsLoading(true);
    setError('');

    if (!pack.is_code && pack.type !== 'ps_gift' && !uid.trim()) {
      setError(pack.type === 'steam_topup' ? 'Пожалуйста, введите логин Steam' : 'Пожалуйста, введите UID');
      setIsLoading(false);
      return;
    }
    // Валидация email для ps_gift в вебе
    if (pack.type === 'ps_gift' && !isTelegramApp) {
      const email = username.trim();
      if (!email) {
        setError('Пожалуйста, укажите email для получения кода');
        setIsLoading(false);
        return;
      }
      // Простая проверка формата
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        setError('Введите корректный email');
        setIsLoading(false);
        return;
      }
    }

    const user_chat_id = tg?.initDataUnsafe?.user?.id;
    const totalAmount = isMultiCode
      ? items.reduce((sum: number, item: any) => sum + (item.amount * item.quantity), 0)
      : (pack.amount || 0);

    const totalPrice = getTotalPrice();
    const itemName = pack.type === 'steam_topup'
      ? `Пополнение Steam: $${pack.amount}`
      : pack.type === 'pp'
        ? `${totalAmount} ПП`
        : pack.type === 'tickets'
          ? `${totalAmount} билетов`
          : pack.type === 'skin'
            ? pack.title || 'Скин'
            : isMultiCode
              ? `Промокоды: ${items.map((item: any) => `${item.amount} UC × ${item.quantity}`).join(', ')}`
              : (pack.is_code ? `Промокод ${totalAmount} UC` : `${totalAmount} UC`);

    try {
      const response = await fetch(`${VITE_API_NGROK}/api/create-payment`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'ngrok-skip-browser-warning': 'true',
          'tuna-skip-browser-warning': 'true'
        },
        body: JSON.stringify({
          uid: uid.trim(),
          amount: pack.type === 'skin' ? 1 : (pack.amount || totalAmount),
          price: totalPrice,
          method_slug: paymentMethod,
          user_chat_id: user_chat_id,
          is_code: pack.is_code || false,
          type: pack.type || 'uc',
          item_name: itemName,
          promo_items: isMultiCode ? items : undefined,
          username: !isTelegramApp ? username.trim() : undefined
        })
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Ошибка при создании заказа');

      if (data.url) {
        setActiveOrderId(data.order_id);
        if (tg && tg.openLink) {
          tg.openLink(data.url);
        } else {
          window.location.href = data.url;
        }
      } else {
        setError('Платежная система не вернула ссылку');
      }
    } catch (err: any) {
      setError(err.message || 'Ошибка сети');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-6 animate-in fade-in slide-in-from-bottom-4 duration-500 pb-12 px-4 max-w-md mx-auto relative z-10">

      {activeOrderId && (
        <PaymentStatusOverlay
          orderId={activeOrderId}
          apiBase={VITE_API_NGROK}
          type={pack.type}
          onClose={() => {
            setActiveOrderId(null);
            onBack();
          }}
        />
      )}

      {showHelp && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[100] animate-in fade-in duration-300"
          onClick={() => setShowHelp(false)}
        />
      )}

      {/* Помощь */}
      <div
        className={`fixed bottom-0 left-0 right-0 z-[101] bg-[#1c1c1e] border-t border-white/10 rounded-t-[40px] transition-transform duration-500 ease-out ${showHelp ? 'translate-y-0' : 'translate-y-full'
          }`}
        style={{ height: '72%' }}
      >
        <div className="px-6 flex justify-between items-center mt-8 mb-6">
          <h2 className="text-xl font-black text-white uppercase italic">
            {pack.type === 'steam_topup' ? 'Где найти логин?' : 'Где найти UID?'}
          </h2>
          <button
            onClick={() => setShowHelp(false)}
            className="p-3 bg-white/5 hover:bg-white/10 rounded-full text-white/50 active:scale-90 transition-all"
          >
            <X size={24} />
          </button>
        </div>

        <div className="px-6 pb-10 overflow-y-auto h-[calc(100%-100px)]">
          {pack.type === 'steam_topup' ? (
            <div className="space-y-4 text-center">
              <p className="text-white/60 text-sm">Введите "Имя аккаунта", которое вы используете при входе в Steam.</p>
              <img src="/steam_i.png" className="w-full rounded-2xl border border-white/10 shadow-lg" alt="Steam Help" />
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-3 text-center">
                <p className="text-[10px] font-bold text-white/40 uppercase tracking-wider">1. На аватар</p>
                <div className="overflow-hidden rounded-2xl border border-white/10 shadow-lg aspect-[3/4]">
                  <img src="/guide-1.jpg" className="w-full h-full object-cover" alt="Guide 1" />
                </div>
              </div>
              <div className="space-y-3 text-center">
                <p className="text-[10px] font-bold text-white/40 uppercase tracking-wider">2. Копируйте ID</p>
                <div className="overflow-hidden rounded-2xl border border-white/10 shadow-lg aspect-[3/4]">
                  <img src="/guide-2.jpg" className="w-full h-full object-cover" alt="Guide 2" />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-4 pt-6">
        <button
          onClick={() => { triggerHapticFeedback('light'); onBack(); }}
          className="p-3 bg-white/10 hover:bg-white/20 backdrop-blur-md rounded-2xl active:scale-90 transition-all border border-white/30"
        >
          <ChevronLeft size={20} className="text-white" strokeWidth={3} />
        </button>
        <h1 className="text-2xl font-black tracking-tight text-white uppercase italic">Оплата</h1>
      </div>

      <div className="bg-black/50 backdrop-blur-xl rounded-[32px] p-6 border border-amber-500/40 relative overflow-hidden group">
        <div className="absolute inset-0 bg-gradient-to-br from-amber-500/15 to-transparent opacity-60" />
        <div className="flex items-center gap-5 relative z-10">
          <img src={pack.image || '/pp.png'} className="w-16 h-16 rounded-[20px] object-cover border-2 border-white/30" alt="Pack" />
          <div className="flex flex-col gap-2">
            <span className="text-2xl font-black italic text-white tracking-tighter uppercase">
              {pack.type === 'steam_topup' ? `$${pack.amount} Steam` : pack.title || `${(pack.amount || 0).toLocaleString()} UC`}
            </span>
            <div className="flex items-center gap-2 bg-amber-500/30 border-2 border-amber-500/50 px-3 py-1 rounded-full w-fit">
              <span className="text-amber-400 text-[14px] font-black">{getTotalPrice().toLocaleString()} ₽</span>
            </div>
          </div>
        </div>
      </div>

      {!pack.is_code && pack.type !== 'ps_gift' && (
        <div className="space-y-3">
          <div className="flex justify-between items-end px-1">
            <label className="text-[12px] font-black text-white uppercase tracking-[0.2em]">
              {pack.type === 'steam_topup' && 'Логин Steam'}
              {pack.type !== 'steam_topup' && 'UID для зачисления'}
            </label>
            <button onClick={() => { triggerHapticFeedback('light'); setShowHelp(true); }} className="flex items-center gap-1.5 text-[12px] text-amber-400 font-black uppercase tracking-wider">
              <span>Где найти?</span>
              <HelpCircle size={14} strokeWidth={3} />
            </button>
          </div>
          <div className="relative">
            <input
              value={uid}
              onChange={(e) => setUid(e.target.value)}
              className="w-full bg-white/15 border-2 border-white/20 rounded-2xl py-4 px-6 text-white font-black text-lg outline-none focus:border-amber-500/60 transition-all"
              placeholder={pack.type === 'steam_topup' ? "Введите логин" :
                "Введите UID"
              }
              disabled={isLoading}
            />
          </div>
        </div>
      )}

      {/* Юзернейм для веб-версии */}
      {!isTelegramApp && (
        <div className="space-y-3">
          <label className="text-[12px] font-black text-white uppercase tracking-[0.2em]">
            {pack.type === 'ps_gift' ? 'Email для получения кода' : 'Юзернейм для связи'}
          </label>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="w-full bg-white/15 border-2 border-white/20 rounded-2xl py-4 px-6 text-white font-black text-lg outline-none focus:border-amber-500/60 transition-all"
            placeholder={pack.type === 'ps_gift' ? "Введите email" : "@username"}
            type={pack.type === 'ps_gift' ? "email" : "text"}
            disabled={isLoading}
          />
        </div>
      )}

      {/* Метод оплаты */}
      <div className="space-y-3">
        <label className="text-[12px] font-black text-white uppercase tracking-[0.2em] px-1 text-center block">Метод оплаты</label>
        <div className="grid grid-cols-2 gap-4">
          {(['sbp', 'card'] as const).map((method) => (
            <button
              key={method}
              onClick={() => { triggerHapticFeedback('light'); setPaymentMethod(method); }}
              className={`h-24 rounded-3xl border-4 transition-all flex flex-col items-center justify-center relative overflow-hidden ${paymentMethod === method ? 'bg-amber-500/20 border-amber-500 shadow-lg' : 'bg-white/5 border-white/10 opacity-70'
                }`}
            >
              <img src={method === 'sbp' ? '/sbp.jpg' : '/card.jpg'} className="h-10 object-contain relative z-10" alt={method} />
              {paymentMethod === method && (
                <div className="absolute top-2 right-2 bg-amber-500 rounded-full p-0.5 shadow-md">
                  <CheckCircle2 size={16} className="text-black" strokeWidth={3} />
                </div>
              )}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="bg-red-500/20 border-2 border-red-500/50 rounded-2xl p-4 animate-in fade-in">
          <p className="text-red-300 font-bold text-center text-sm">{error}</p>
        </div>
      )}

      <div className="bg-black/70 backdrop-blur-2xl rounded-[40px] p-8 space-y-6 border-2 border-white/10 shadow-2xl mt-auto">
        <div className="flex justify-between items-center">
          <span className="text-2xl font-black text-white uppercase italic tracking-tight">Итого</span>
          <span className="text-4xl font-black text-amber-400 tracking-tighter">
            {getTotalPrice().toFixed(2)}<span className="text-xl ml-1">₽</span>
          </span>
        </div>
      </div>

      <button
        onClick={() => { triggerHapticFeedback('heavy'); handlePayment(); }}
        className="w-full bg-amber-500 hover:bg-amber-400 py-6 rounded-2xl font-black text-black text-xl active:scale-[0.98] transition-all uppercase tracking-tight relative overflow-hidden disabled:opacity-70"
        disabled={(!pack.is_code && !uid.trim()) || isLoading}
      >
        <div className="relative z-10 flex items-center justify-center gap-2">
          {isLoading ? <><Loader2 className="w-5 h-5 animate-spin" /><span>Обработка...</span></> : <span>Оплатить сейчас</span>}
        </div>
      </button>
    </div>
  );
};

export default Checkout;