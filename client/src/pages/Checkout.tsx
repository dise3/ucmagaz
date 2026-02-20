import React, { useState, useEffect } from 'react';
import { ChevronLeft, HelpCircle, CheckCircle2, X, Loader2, Home } from 'lucide-react';

const PaymentStatusOverlay: React.FC<{ orderId: string; onClose: () => void; apiBase: string }> = ({ orderId, onClose, apiBase }) => {
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
                Пожалуйста, завершите платеж в открывшемся окне. Статус обновится автоматически.
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
                Заказ оплачен. UC будут зачислены на ваш аккаунт в течение 5-15 минут.
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
    image?: string; 
    is_code?: boolean; 
    is_skin?: boolean;
    is_prime?: boolean;
    items?: Array<{ id: number; amount: number; price: number; quantity: number }>;
    type?: 'pp' | 'tickets' | 'skin' | 'prime' | 'prime_plus';
    title?: string;
  };
  onBack: () => void;
}

const Checkout: React.FC<CheckoutProps> = ({ pack, onBack }) => {
  const [paymentMethod, setPaymentMethod] = useState<'sbp' | 'card'>('sbp');
  const [uid, setUid] = useState('');
  const [showHelp, setShowHelp] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [activeOrderId, setActiveOrderId] = useState<string | null>(null);
  const [primePrices, setPrimePrices] = useState<any>(null);

  const VITE_API_NGROK = import.meta.env.VITE_API_NGROK;
  const isMultiCode = pack.items && pack.items.length > 0;
  const items = pack.items || [];

  useEffect(() => {
    if (pack.type === 'pp' || pack.type === 'tickets' || pack.type === 'prime' || pack.type === 'prime_plus') {
      fetch(`${VITE_API_NGROK}/api/prime-prices`, {
        headers: { 
          'ngrok-skip-browser-warning': 'true',
          'tuna-skip-browser-warning': 'true'
        }
      }).then(res => res.json()).then(setPrimePrices);
    }
  }, [pack.type, VITE_API_NGROK]);

  const COMMISSION_SBP = 0.052;
  const COMMISSION_CARD = 0.0745;

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
    if (pack.type === 'pp') {
      if (!primePrices) return 0;
      const pricePer10000 = paymentMethod === 'sbp' ? primePrices.prime_prices[0].price_rub_sbp : primePrices.prime_prices[0].price_rub_card;
      return Math.ceil(pricePer10000 * ((pack.amount || 0) / 10000));
    } else if (pack.type === 'tickets') {
      if (!primePrices) return 0;
      const pricePer100 = paymentMethod === 'sbp' ? primePrices.ticket_prices[0].price_rub_sbp : primePrices.ticket_prices[0].price_rub_card;
      return Math.ceil(pricePer100 * ((pack.amount || 0) / 100));
    } else if (pack.type === 'prime') {
      if (!primePrices) return pack.price || 0;
      return paymentMethod === 'sbp' ? primePrices.prime_item_prices[0].price_rub_sbp : primePrices.prime_item_prices[0].price_rub_card;
    } else if (pack.type === 'prime_plus') {
      if (!primePrices) return pack.price || 0;
      return paymentMethod === 'sbp' ? primePrices.prime_plus_item_prices[0].price_rub_sbp : primePrices.prime_plus_item_prices[0].price_rub_card;
    } else if (pack.type === 'skin') {
      return pack.price || 0; // Скины без комиссии
    } else if (isMultiCode) {
      return items.reduce((sum: number, item: any) => sum + (getPriceForMethod(item.price, paymentMethod) * item.quantity), 0);
    } else {
      return getPriceForMethod(pack.price || 0, paymentMethod);
    }
  };

  const triggerHapticFeedback = (style: 'light' | 'medium' | 'heavy' | 'success' | 'error' = 'medium') => {
    const tg = (window as any).Telegram?.WebApp?.HapticFeedback;
    if (tg) {
      if (style === 'success' || style === 'error') {
        tg.notificationOccurred(style);
      } else {
        tg.impactOccurred(style);
      }
    }
  };

  const handlePayment = async () => {
    setIsLoading(true);
    setError('');
    
    if (!pack.is_code && !uid.trim() && pack.type !== 'pp' && pack.type !== 'tickets' && pack.type !== 'skin' && pack.type !== 'prime' && pack.type !== 'prime_plus') {
      setError('Пожалуйста, введите UID');
      setIsLoading(false);
      return;
    }

    const tg = (window as any).Telegram?.WebApp;
    const user_chat_id = tg?.initDataUnsafe?.user?.id;

    const totalAmount = isMultiCode
      ? items.reduce((sum: number, item: any) => sum + (item.amount * item.quantity), 0)
      : (pack.amount || 0);
    const totalPrice = getTotalPrice();
    const itemName = pack.type === 'pp' 
      ? `${totalAmount} ПП` 
      : pack.type === 'tickets' 
      ? `${totalAmount} билетов` 
      : pack.type === 'skin'
      ? pack.title || 'Скин'
      : pack.type === 'prime'
      ? 'Prime Gaming'
      : pack.type === 'prime_plus'
      ? 'Prime Gaming Plus'
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
          uid: pack.type === 'skin' ? pack.title : pack.type === 'prime' || pack.type === 'prime_plus' ? 'PRIME_SUBSCRIPTION' : pack.is_code ? 'MANUAL_ORDER' : uid.trim(),
          amount: pack.type === 'skin' ? 1 : totalAmount,
          price: totalPrice,
          method_slug: paymentMethod,
          user_chat_id: user_chat_id,
          is_code: pack.is_code || false,
          type: pack.type || 'uc',
          item_name: itemName,
          promo_items: isMultiCode ? items : undefined
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

      <div 
        className={`fixed bottom-0 left-0 right-0 z-[101] bg-[#1c1c1e] border-t border-white/10 rounded-t-[40px] transition-transform duration-500 ease-out ${
          showHelp ? 'translate-y-0' : 'translate-y-full'
        }`} 
        style={{ height: '72%' }}
      >
        <div className="px-6 flex justify-between items-center mt-8 mb-6">
          <h2 className="text-xl font-black text-white uppercase italic">Где найти UID?</h2>
          <button 
            onClick={() => setShowHelp(false)} 
            className="p-3 bg-white/5 hover:bg-white/10 rounded-full text-white/50 active:scale-90 transition-all"
          >
            <X size={24} />
          </button>
        </div>

        <div className="px-6 pb-10 overflow-y-auto h-[calc(100%-100px)]">
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
        {isMultiCode ? (
          <div className="relative z-10 space-y-3">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-16 h-16 bg-amber-500/20 rounded-[20px] flex items-center justify-center border-2 border-amber-500/30">
                <span className="text-amber-400 text-2xl">🎁</span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xl font-black italic text-white tracking-tighter">
                  {items.reduce((sum: number, item: any) => sum + (item.amount * item.quantity), 0).toLocaleString()} <span className="text-amber-400">UC</span>
                </span>
                <span className="text-amber-400 text-[14px] font-black">
                  {getTotalPrice().toLocaleString()} ₽
                </span>
              </div>
            </div>
            <div className="space-y-2">
              {items.map((item: any, index: number) => (
                <div key={index} className="flex items-center justify-between bg-white/5 rounded-xl p-3">
                  <span className="text-white text-sm font-bold">
                    {item.amount} UC × {item.quantity}
                  </span>
                  <span className="text-amber-400 text-sm font-black">
                    {(getPriceForMethod(item.price, paymentMethod) * item.quantity).toLocaleString()} ₽
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-5 relative z-10">
            <img src={pack.image || '/pp.png'} className="w-16 h-16 rounded-[20px] object-cover border-2 border-white/30" alt="Pack" />
            <div className="flex flex-col gap-2">
              <span className="text-2xl font-black italic text-white tracking-tighter">
                {pack.title || `${(pack.amount || 0).toLocaleString()} ${pack.type === 'pp' ? 'ПП' : pack.type === 'tickets' ? 'билетов' : pack.type === 'prime' ? 'Prime' : pack.type === 'prime_plus' ? 'Prime Plus' : 'UC'}`}
              </span>
              <div className="flex items-center gap-2 bg-amber-500/30 border-2 border-amber-500/50 px-3 py-1 rounded-full w-fit">
                <span className="text-amber-400 text-[14px] font-black">{getTotalPrice().toLocaleString()} ₽</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {(!pack.is_code && pack.type !== 'pp' && pack.type !== 'tickets' && pack.type !== 'skin' && pack.type !== 'prime' && pack.type !== 'prime_plus') && (
        <div className="space-y-3">
          <div className="flex justify-between items-end px-1">
            <label className="text-[12px] font-black text-white uppercase tracking-[0.2em]">PUBG UID</label>
            <button onClick={() => { triggerHapticFeedback('light'); setShowHelp(true); }} className="flex items-center gap-1.5 text-[12px] text-amber-400 font-black uppercase tracking-wider">
              <span>Где мой UID?</span>
              <HelpCircle size={14} strokeWidth={3} />
            </button>
          </div>
          <div className="relative">
            <input 
              value={uid}
              onChange={(e) => setUid(e.target.value)}
              className="w-full bg-white/15 border-2 border-white/20 rounded-2xl py-4 px-6 text-white font-black text-lg outline-none focus:border-amber-500/60 transition-all" 
              placeholder="Введите UID" 
              disabled={isLoading}
            />
          </div>
        </div>
      )}
      
      {pack.is_code && (
        <div className="bg-amber-500/10 border-2 border-amber-500/30 rounded-2xl p-4">
          <p className="text-amber-300 font-bold text-center text-sm">
          Промокод будет отправлен вам в личные сообщения в боте сразу после оплаты
          </p>
        </div>
      )}

      <div className="space-y-3">
        <label className="text-[12px] font-black text-white uppercase tracking-[0.2em] px-1 text-center block">Метод оплаты</label>
        <div className="grid grid-cols-2 gap-4">
          {[
            { id: 'sbp' as const, img: '/sbp.jpg', label: 'СБП' },
            { id: 'card' as const, img: '/card.jpg', label: 'Карты' }
          ].map((method) => (
            <button 
              key={method.id}
              onClick={() => { triggerHapticFeedback('light'); setPaymentMethod(method.id); }} 
              className={`h-24 rounded-3xl border-4 transition-all flex flex-col items-center justify-center relative overflow-hidden ${
                paymentMethod === method.id ? 'bg-amber-500/20 border-amber-500 shadow-lg' : 'bg-white/5 border-white/10 opacity-70'
              }`}
            >
              <img src={method.img} className="h-10 object-contain relative z-10" alt={method.label} />
              {paymentMethod === method.id && (
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
        disabled={(!pack.is_code && !uid.trim() && pack.type !== 'pp' && pack.type !== 'tickets' && pack.type !== 'skin' && pack.type !== 'prime' && pack.type !== 'prime_plus') || isLoading}
      >
        <div className="relative z-10 flex items-center justify-center gap-2">
          {isLoading ? <><Loader2 className="w-5 h-5 animate-spin" /><span>Обработка...</span></> : <span>Оплатить сейчас</span>}
        </div>
      </button>
    </div>
  );
};

export default Checkout;