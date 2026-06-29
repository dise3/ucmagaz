import React, { useState, useEffect, useMemo } from 'react';
import { ChevronLeft, HelpCircle, CheckCircle2, X, Loader2, Home } from 'lucide-react';

// --- КОМПОНЕНТ СТАТУСА ОПЛАТЫ (УНИВЕРСАЛЬНЫЙ) ---
const PaymentStatusOverlay: React.FC<{ 
  orderId: string; 
  onClose: () => void; 
  apiBase: string; 
  type?: string 
}> = ({ orderId, onClose, apiBase, type }) => {
  const [status, setStatus] = useState<'pending' | 'paid'>('pending');

  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`${apiBase}/api/check-status/${orderId}`, {
          headers: { 'ngrok-skip-browser-warning': 'true' }
        });
        const data = await res.json();
        if (data.status === 'paid' || data.status === 'completed') {
          setStatus('paid');
          clearInterval(interval);
          if (window.Telegram?.WebApp?.HapticFeedback) {
            window.Telegram.WebApp.HapticFeedback.notificationOccurred('success');
          }
        }
      } catch (e) { console.error("Status check error:", e); }
    }, 3000);
    return () => clearInterval(interval);
  }, [orderId, apiBase]);

  const getSuccessMessage = () => {
    switch (type) {
      case 'steam_topup': return 'Средства будут зачислены на баланс Steam в течение 5-15 минут.';
      case 'ps_gift': return 'Код активации придет в чат-бот в ближайшее время.';
      case 'uc':
      case 'pp':
      case 'tickets': return 'UC/Валюта будут зачислены на ваш аккаунт в течение 5-15 минут.';
      default: return 'Ваш заказ будет выполнен в течение 5-15 минут.';
    }
  };

  return (
    <div className="fixed inset-0 bg-black/95 backdrop-blur-xl z-[200] flex flex-col items-center justify-center px-6 text-center animate-in fade-in duration-500">
      <div className="w-full max-w-xs space-y-8">
        {status === 'pending' ? (
          <>
            <div className="relative">
              <div className="absolute inset-0 bg-amber-500/20 blur-3xl rounded-full" />
              <Loader2 className="w-20 h-20 text-amber-500 animate-spin mx-auto relative z-10" strokeWidth={3} />
            </div>
            <h2 className="text-2xl font-black text-white uppercase italic tracking-tight">Ожидаем оплату</h2>
            <p className="text-white/50 text-sm">Статус обновится автоматически после проведения платежа.</p>
          </>
        ) : (
          <>
            <div className="relative">
              <div className="absolute inset-0 bg-green-500/20 blur-3xl rounded-full" />
              <CheckCircle2 className="w-20 h-20 text-green-500 mx-auto relative z-10 animate-bounce" strokeWidth={3} />
            </div>
            <h2 className="text-2xl font-black text-white uppercase italic tracking-tight">Успешно!</h2>
            <p className="text-white/50 font-medium text-sm leading-relaxed">{getSuccessMessage()}</p>
          </>
        )}
        <button onClick={onClose} className="w-full bg-white/10 py-5 rounded-2xl text-white font-black uppercase flex items-center justify-center gap-3 border border-white/10 active:scale-95 transition-all">
          <Home size={20} /><span>На главную</span>
        </button>
      </div>
    </div>
  );
};

// --- ОСНОВНОЙ КОМПОНЕНТ ОФОРМЛЕНИЯ ---
interface CheckoutProps {
  pack: { 
    amount?: number; 
    price?: number; 
    image?: string; 
    is_code?: boolean; 
    type?: 'uc' | 'pp' | 'tickets' | 'skin' | 'prime' | 'prime_plus' | 'steam_topup' | 'ps_gift';
    title?: string;
    items?: Array<{ id: number; amount: number; price: number; quantity: number }>; // Для корзины промокодов
  };
  onBack: () => void;
}

const Checkout: React.FC<CheckoutProps> = ({ pack, onBack }) => {
  const [paymentMethod, setPaymentMethod] = useState<'sbp' | 'card'>('sbp');
  const [uid, setUid] = useState('');
  const [username, setUsername] = useState(''); // Для веб-версии
  const [showHelp, setShowHelp] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [settings, setSettings] = useState<any>(null);
  const [activeOrderId, setActiveOrderId] = useState<string | null>(null);

  const VITE_API_NGROK = import.meta.env.VITE_API_NGROK;
  const isMultiCode = !!(pack.items && pack.items.length > 0);
  
  // Детекция окружения
  const tg = (window as any).Telegram?.WebApp;
  const isTelegramApp = !!(tg?.initDataUnsafe?.user);

  useEffect(() => {
    fetch(`${VITE_API_NGROK}/api/settings`, { headers: { 'ngrok-skip-browser-warning': 'true' } })
      .then(res => res.json())
      .then(setSettings)
      .catch(err => console.error("Settings load error:", err));
  }, [VITE_API_NGROK]);

  // Константы комиссий
  const COMMISSION_SBP = 0.0485;
  const COMMISSION_CARD = 0.071;

  // ЛОГИКА РАСЧЕТА ЦЕНЫ (ОБЪЕДИНЕННАЯ)
  const calculateFinalPrice = (priceSbp: number, method: 'sbp' | 'card'): number => {
    const basePrice = priceSbp / (1 + COMMISSION_SBP);
    const commission = method === 'sbp' ? COMMISSION_SBP : COMMISSION_CARD;
    return Math.ceil(basePrice * (1 + commission));
  };

  const totalPrice = useMemo(() => {
    if (!settings) return pack.price || 0;
    
    // 1. Логика для Steam
    if (pack.type === 'steam_topup') {
      const rate = settings.usd_rate_store || settings.usd_rate || 95;
      const steamFee = settings.steam_fee_percent || 0.15;
      const baseRub = (pack.amount || 0) * rate * (1 + steamFee);
      const comm = paymentMethod === 'sbp' ? COMMISSION_SBP : COMMISSION_CARD;
      return Math.floor(baseRub * (1 + comm) + 1);
    }

    // 2. Логика для Корзины (Multi-code)
    if (isMultiCode) {
      return pack.items!.reduce((sum, item) => 
        sum + (calculateFinalPrice(item.price, paymentMethod) * item.quantity), 0
      );
    }

    // 3. Логика для специальных типов (PP, Tickets)
    if (pack.type === 'pp' || pack.type === 'tickets') {
      const isPP = pack.type === 'pp';
      const usdPrice = isPP ? settings.pp_price_usd : settings.ticket_price_usd;
      const markup = isPP ? settings.pp_markup_rub : settings.ticket_markup_rub;
      const divider = isPP ? 10000 : 100;
      
      const base = (usdPrice * ((pack.amount || 0) / divider)) * settings.usd_rate + (markup || 0);
      const withFee = Math.ceil(base * (1 + settings.fee_percent));
      return calculateFinalPrice(withFee, paymentMethod);
    }

    // 4. Обычные товары (UC, Skins, Prime)
    const baseWithStoreFee = (pack.price || 0) * (1 + (settings.fee_percent || 0));
    return calculateFinalPrice(baseWithStoreFee, paymentMethod);
  }, [pack, paymentMethod, settings, isMultiCode]);

  const handlePayment = async () => {
    if (!pack.is_code && !uid.trim()) {
      setError(pack.type === 'steam_topup' ? 'Введите логин Steam' : 'Введите UID');
      return;
    }

    setIsLoading(true);
    setError('');

    const userData = tg?.initDataUnsafe?.user;

    try {
      const response = await fetch(`${VITE_API_NGROK}/api/create-payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' },
        body: JSON.stringify({
          uid: uid.trim(),
          amount: pack.amount || 0,
          price: totalPrice,
          method_slug: paymentMethod,
          user_chat_id: userData?.id || 0,
          buyer_first_name: userData?.first_name || 'Web',
          buyer_last_name: userData?.last_name || 'User',
          username: !isTelegramApp ? username.trim() : undefined,
          type: pack.type || 'uc',
          is_code: pack.is_code || false,
          promo_items: isMultiCode ? pack.items : undefined,
          item_name: pack.title || `${pack.amount} ${pack.type}`
        })
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Ошибка создания заказа');

      if (data.url) {
        setActiveOrderId(data.order_id);
        if (tg?.openLink) tg.openLink(data.url);
        else window.location.href = data.url;
      }
    } catch (err: any) {
      setError(err.message || 'Ошибка сети');
    } finally { setIsLoading(false); }
  };

  const triggerHaptic = (style: 'light' | 'heavy' = 'light') => {
    if (tg?.HapticFeedback) tg.HapticFeedback.impactOccurred(style);
  };

  return (
    <div className="flex flex-col gap-6 animate-in fade-in slide-in-from-bottom-4 duration-500 pb-12 px-4 max-w-md mx-auto relative z-10 text-white">
      {activeOrderId && (
        <PaymentStatusOverlay 
          orderId={activeOrderId} 
          apiBase={VITE_API_NGROK} 
          type={pack.type} 
          onClose={() => { setActiveOrderId(null); onBack(); }} 
        />
      )}

      {/* Помощь (Drawer) */}
      <div className={`fixed inset-x-0 bottom-0 z-[101] bg-[#1c1c21] border-t border-white/10 rounded-t-[40px] transition-transform duration-500 ${showHelp ? 'translate-y-0' : 'translate-y-full'}`} style={{ height: '70%' }}>
        <div className="px-6 py-8 flex justify-between items-center">
          <h2 className="text-xl font-black uppercase italic">Где найти данные?</h2>
          <button onClick={() => setShowHelp(false)} className="p-3 bg-white/5 rounded-full text-white/50"><X size={24} /></button>
        </div>
        <div className="px-6 text-center space-y-6">
          <p className="text-white/60">
            {pack.type === 'steam_topup' 
              ? 'Введите "Имя аккаунта" (логин), который вы используете при входе в Steam.' 
              : 'ID игрока находится в вашем профиле PUBG Mobile под аватаром.'}
          </p>
          <img 
            src={pack.type === 'steam_topup' ? "/steam-help.jpg" : "/guide-1.jpg"} 
            className="rounded-3xl border border-white/10 mx-auto shadow-2xl max-h-60 object-contain" 
            alt="Help" 
          />
        </div>
      </div>

      {/* Header */}
      <div className="flex items-center gap-4 pt-6">
        <button onClick={() => { triggerHaptic(); onBack(); }} className="p-3 bg-white/10 rounded-2xl border border-white/20 active:scale-90 transition-all">
          <ChevronLeft size={20} />
        </button>
        <h1 className="text-2xl font-black uppercase italic tracking-tight">Оплата</h1>
      </div>

      {/* Инфо о товаре */}
      <div className="bg-black/50 backdrop-blur-xl rounded-[32px] p-6 border border-amber-500/40 relative overflow-hidden group shadow-2xl">
        <div className="absolute inset-0 bg-gradient-to-br from-amber-500/10 to-transparent opacity-60" />
        <div className="flex items-center gap-5 relative z-10">
          <div className="relative">
            <img src={pack.image || '/pp.png'} className="w-16 h-16 rounded-[20px] object-cover border-2 border-white/20 shadow-lg" alt="Pack" />
            {isMultiCode && <span className="absolute -top-2 -right-2 bg-amber-500 text-black text-[10px] font-black px-2 py-0.5 rounded-full">PACK</span>}
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-lg font-black italic uppercase leading-tight text-white">
              {isMultiCode ? 'Набор промокодов' : (pack.title || `${pack.amount} ${pack.type === 'uc' ? 'UC' : 'ед.'}`)}
            </span>
            <div className="flex items-center gap-2 bg-amber-500/20 border border-amber-500/30 px-3 py-0.5 rounded-full w-fit">
               <span className="text-amber-400 font-black text-sm">{totalPrice.toLocaleString()} ₽</span>
            </div>
          </div>
        </div>
      </div>

      {/* Поля ввода */}
      {!pack.is_code && (
        <div className="space-y-4">
          <div className="space-y-2">
            <div className="flex justify-between items-end px-1">
              <label className="text-[11px] font-black uppercase tracking-widest text-white/50">
                {pack.type === 'steam_topup' ? 'Логин Steam' : 'Игровой UID'}
              </label>
              <button onClick={() => setShowHelp(true)} className="flex items-center gap-1.5 text-[11px] text-amber-400 font-bold">
                Где найти? <HelpCircle size={14} />
              </button>
            </div>
            <input 
              value={uid} 
              onChange={(e) => setUid(e.target.value)} 
              placeholder={pack.type === 'steam_topup' ? "Steam" : "UID"} 
              className="w-full bg-white/5 border-2 border-white/10 rounded-2xl py-5 px-6 text-white font-black text-lg outline-none focus:border-amber-500/50 transition-all shadow-inner" 
            />
          </div>

          {!isTelegramApp && (
            <div className="space-y-2">
              <label className="text-[11px] font-black uppercase tracking-widest text-white/50 px-1">Юзернейм для связи</label>
              <input 
                value={username} 
                onChange={(e) => setUsername(e.target.value)} 
                placeholder="@username" 
                className="w-full bg-white/5 border-2 border-white/10 rounded-2xl py-4 px-6 text-white font-black text-lg outline-none focus:border-amber-500/50" 
              />
            </div>
          )}
        </div>
      )}

      {/* Выбор оплаты */}
      <div className="space-y-3">
        <label className="text-[11px] font-black text-white/30 uppercase tracking-widest text-center block">Метод оплаты</label>
        <div className="grid grid-cols-2 gap-4">
          {(['sbp', 'card'] as const).map((m) => (
            <button 
              key={m} 
              onClick={() => { triggerHaptic(); setPaymentMethod(m); }} 
              className={`h-20 rounded-[24px] border-2 transition-all flex items-center justify-center relative ${
                paymentMethod === m ? 'bg-amber-500/10 border-amber-500 shadow-[0_0_15px_rgba(245,158,11,0.15)]' : 'bg-white/5 border-white/5 opacity-60'
              }`}
            >
              <img src={m === 'sbp' ? '/sbp.jpg' : '/card.jpg'} className="h-8 object-contain" alt={m} />
              {paymentMethod === m && (
                <div className="absolute -top-2 -right-2 bg-amber-500 rounded-full p-1 shadow-lg animate-in zoom-in duration-300">
                  <CheckCircle2 size={14} className="text-black" strokeWidth={4} />
                </div>
              )}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="bg-red-500/10 border border-red-500/30 rounded-2xl p-4 text-red-400 font-bold text-center text-sm animate-shake">{error}</div>}

      {/* Футер */}
      <div className="mt-auto space-y-4 pt-6">
        <div className="flex justify-between items-end px-2">
          <div className="flex flex-col">
            <span className="text-[11px] font-black text-white/30 uppercase tracking-widest">К оплате:</span>
            <span className="text-4xl font-black tracking-tighter">
              {totalPrice.toFixed(2)}<span className="text-amber-400 text-2xl ml-1">₽</span>
            </span>
          </div>
        </div>
        <button 
          onClick={() => { triggerHaptic('heavy'); handlePayment(); }} 
          disabled={isLoading || (!pack.is_code && !uid.trim())} 
          className="w-full bg-amber-500 hover:bg-amber-400 py-6 rounded-[24px] font-black text-black text-xl uppercase transition-all active:scale-[0.97] disabled:opacity-50 shadow-xl shadow-amber-900/30 flex items-center justify-center gap-3"
        >
          {isLoading ? <Loader2 className="animate-spin w-7 h-7" /> : 'Подтвердить и оплатить'}
        </button>
      </div>
    </div>
  );
};

export default Checkout;