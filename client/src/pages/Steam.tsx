import React, { useState, useEffect } from 'react';
import { ChevronLeft, HelpCircle, ArrowLeftRight, Info, X, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import Checkout from './Checkout';

interface SteamProps {
  onBack: () => void;
}

const Steam: React.FC<SteamProps> = ({ onBack }) => {
  const [login, setLogin] = useState('');
  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState<'receive' | 'pay'>('receive');
  const [showCheckout, setShowCheckout] = useState(false);
  const [settings, setSettings] = useState<any>(null);
  const [showHelp, setShowHelp] = useState(false);

  const [selectedCurrency, setSelectedCurrency] = useState<'RUB' | 'KZT' | 'USD' | 'UAH'>('RUB');

  const [isValidating, setIsValidating] = useState(false);
  const [loginStatus, setLoginStatus] = useState<'idle' | 'valid' | 'invalid'>('idle');

  const VITE_API_NGROK = import.meta.env.VITE_API_NGROK;
  const MIN_AMOUNT = 50; // Минимальная сумма

  useEffect(() => {
    fetch(`${VITE_API_NGROK}/api/settings`, {
      headers: { 'ngrok-skip-browser-warning': 'true' }
    }).then(res => res.json()).then(setSettings);
  }, []);

  const handleLoginChange = (val: string) => {
    setLogin(val);
    if (loginStatus !== 'idle') setLoginStatus('idle');
  };

  const handleCheckUser = async () => {
    if (!login.trim() || isValidating) return;
    setIsValidating(true);
    try {
      const res = await fetch(`${VITE_API_NGROK}/api/steam/check-user`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login: login.trim() })
      });
      const data = await res.json();
      setLoginStatus(data.valid ? 'valid' : 'invalid');
      const tg = (window as any).Telegram?.WebApp?.HapticFeedback;
      if (tg) tg.notificationOccurred(data.valid ? 'success' : 'error');
    } catch (e) {
      setLoginStatus('invalid');
    } finally {
      setIsValidating(false);
    }
  };

  const usdRate = settings?.ns_rate_rub;
  const steamMarkup = settings?.steam_fee_percent ?? 0.15;
  const paymentCommision = 1.0485;
  const kztRate = settings?.ns_rate_kzt / usdRate;
  const uahRate = settings?.ns_rate_uah / usdRate;

  const amountNum = parseFloat(amount) || 0;
  const amountInRub = amountNum;

  const calculateFinalPriceRub = () => {
    if (mode === 'pay') return Math.ceil(amountInRub);
    return Math.ceil(amountInRub * (1 + steamMarkup) * paymentCommision);
  };

  const calculateReceiveRub = () => {
    if (mode === 'receive') return Math.floor(amountInRub);
    const pureRub = (amountInRub / paymentCommision) / (1 + steamMarkup);
    return Math.floor(pureRub);
  };

  const finalPrice = calculateFinalPriceRub();
  const receiveRub = calculateReceiveRub();

  // Пересчёт в выбранную валюту
  let receiveSelected = receiveRub; // по умолчанию – рубли
  if (selectedCurrency === 'USD') receiveSelected = receiveRub / usdRate;
  else if (selectedCurrency === 'KZT') receiveSelected = receiveRub * kztRate;
  else if (selectedCurrency === 'UAH') receiveSelected = receiveRub * uahRate;


  const calculateUsdForApi = () => {
    const receiveRub = calculateReceiveRub();
    return (receiveRub / usdRate).toFixed(2);
  };

  const isAmountTooLow = amount !== '' && amountInRub < MIN_AMOUNT;

  if (showCheckout) {
    return (
      <Checkout
        onBack={() => setShowCheckout(false)}
        pack={{
          type: 'steam_topup',
          amount: parseFloat(calculateUsdForApi()),
          price: calculateFinalPriceRub(),
          uid: login,
          title: `Steam пополнение`,
          image: '/steam-logo.jpg'
        }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-6 pb-12 animate-in fade-in duration-500 px-4 max-w-md mx-auto relative">

      {/* ПЛАШКА ИНСТРУКЦИИ */}
      {showHelp && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[100] animate-in fade-in duration-300" onClick={() => setShowHelp(false)} />
      )}

      <div className={`fixed bottom-0 left-0 right-0 z-[101] bg-[#1c1c21] border-t border-amber-500/20 rounded-t-[32px] transition-transform duration-500 ease-out shadow-2xl flex flex-col items-center ${showHelp ? 'translate-y-0' : 'translate-y-full'}`}>
        <div className="w-12 h-1.5 bg-white/10 rounded-full mt-3 mb-2" />
        <div className="w-full px-6 pt-2 pb-8 flex flex-col items-center gap-4">
          <div className="flex justify-between items-center w-full">
            <h3 className="text-white font-bold text-lg italic">Помощь с логином</h3>
            <button onClick={() => setShowHelp(false)} className="p-2 bg-white/5 rounded-full text-white/50 active:scale-90"><X size={20} /></button>
          </div>
          <div className="w-full overflow-hidden rounded-2xl border border-white/10">
            <img src="/steam_i.png" alt="Instruction" className="w-full h-auto object-contain" />
          </div>
          <button onClick={() => setShowHelp(false)} className="w-full py-4 bg-amber-500 text-black font-black rounded-xl uppercase tracking-wider text-sm active:scale-95 transition-all">Понятно</button>
        </div>
      </div>

      {/* Header */}
      <div className="flex items-center gap-4 py-2">
        <button onClick={onBack} className="p-2 bg-white/5 rounded-xl active:scale-90 transition-all border border-white/5">
          <ChevronLeft size={20} className="text-amber-500" />
        </button>
        <h1 className="text-xl font-black text-white uppercase italic tracking-tight">Steam <span className="text-amber-500">Top-up</span></h1>
      </div>

      {/* 01 - ЛОГИН */}
      <div className="relative group">
        <div className="absolute -top-3 -left-2 bg-gradient-to-br from-amber-400 to-orange-600 w-10 h-10 rounded-xl flex items-center justify-center shadow-lg shadow-amber-900/40 transform -rotate-12 z-20 border border-amber-300/30">
          <span className="text-black font-black text-lg italic">01</span>
        </div>

        <div className="bg-[#242429] border border-white/5 rounded-[28px] p-6 pt-8 space-y-4 shadow-xl">
          <div className="flex justify-between items-center">
            <h2 className="text-[15px] font-bold text-white/90">Ваш аккаунт</h2>
            <button onClick={() => setShowHelp(true)} className="flex items-center gap-1 text-amber-500 font-bold text-xs bg-amber-500/10 px-2 py-1 rounded-lg">Где логин? <HelpCircle size={14} /></button>
          </div>

          <div className="relative">
            <input
              value={login}
              onChange={(e) => handleLoginChange(e.target.value)}
              placeholder="Введите логин Steam"
              className={`w-full bg-[#1c1c21] border-2 rounded-xl py-4 pl-5 pr-28 text-white outline-none transition-all ${loginStatus === 'valid' ? 'border-green-500/50' :
                loginStatus === 'invalid' ? 'border-red-500/50' : 'border-white/10'
                }`}
            />
            <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-2">
              {loginStatus === 'valid' && <CheckCircle2 className="text-green-500" size={20} />}
              {loginStatus === 'invalid' && <AlertCircle className="text-red-500" size={20} />}
              <button
                onClick={handleCheckUser}
                disabled={isValidating || !login}
                className="bg-amber-500 hover:bg-amber-400 disabled:opacity-30 text-black font-black text-[10px] uppercase px-3 py-2 rounded-lg transition-all active:scale-90"
              >
                {isValidating ? <Loader2 size={14} className="animate-spin" /> : 'Проверить'}
              </button>
            </div>
          </div>

          <div className="space-y-1">
            <p className="text-amber-500/60 text-[10px] font-black uppercase tracking-widest">Доступные регионы</p>
            <p className="text-gray-500 text-[10px] leading-relaxed font-medium uppercase">Russia, Belarus, Ukraine, Armenia, Azerbaijan, Georgia, Kazakhstan, Kyrgyzstan, Moldova, Tajikistan, Turkmenistan, Uzbekistan</p>
          </div>
        </div>
      </div>


      {/* 02 */}
      <div className="relative group">
        <div className="absolute -top-3 -left-2 bg-gradient-to-br from-amber-400 to-orange-600 w-10 h-10 rounded-xl flex items-center justify-center shadow-lg shadow-amber-900/40 transform -rotate-12 z-20 border border-amber-300/30">
          <span className="text-black font-black text-lg italic">02</span>
        </div>
        <div className="bg-[#242429] border border-white/5 rounded-[28px] p-6 pt-8 space-y-4 shadow-xl">
          <div className='flex ustify-between items-center'>
            <h2 className="text-[15px] font-bold text-white/90 uppercase italic">Выберите регион</h2>
          </div>

          <div className="flex gap-2 mt-6">
            {(['RUB', 'KZT', 'USD', 'UAH'] as const).map((cur) => (
              <button
                key={cur}
                onClick={() => setSelectedCurrency(cur)}
                className={`flex-1 py-2 rounded-xl font-black text-sm transition-all ${selectedCurrency === cur
                  ? 'bg-amber-500 text-black'
                  : 'bg-white/5 text-white/50'
                  }`}
              >
                {cur}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 03 - СУММА */}
      <div className="relative group">
        <div className="absolute -top-3 -left-2 bg-gradient-to-br from-amber-400 to-orange-600 w-10 h-10 rounded-xl flex items-center justify-center shadow-lg shadow-amber-900/40 transform -rotate-12 z-20 border border-amber-300/30">
          <span className="text-black font-black text-lg italic">03</span>
        </div>


        <div className="bg-[#242429] border border-white/5 rounded-[28px] p-6 pt-8 space-y-4 shadow-xl">
          <div className="flex justify-between items-center">
            <h2 className="text-[15px] font-bold text-white/90 uppercase italic">{mode === 'receive' ? 'Сумма зачисления' : 'Сумма пополнения'}</h2>
            <button onClick={() => setMode(m => m === 'receive' ? 'pay' : 'receive')} className="p-2 bg-amber-500/10 rounded-xl active:scale-75 border border-amber-500/20"><ArrowLeftRight size={16} className="text-amber-500" /></button>
          </div>

          <div className="relative">
            <input
              type="number" min="0" value={amount}
              onKeyDown={(e) => ["-", "e", "E"].includes(e.key) && e.preventDefault()}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0"
              className={`w-full bg-[#1c1c21] border-2 rounded-xl py-4 px-5 text-white text-2xl font-black outline-none transition-all focus:border-amber-500/50 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none ${isAmountTooLow ? 'border-red-500/50' : 'border-white/10'}`}
            />
            <span className="absolute right-5 top-1/2 -translate-y-1/2 text-amber-500 font-black text-sm uppercase italic opacity-50">RUB</span>
          </div>

          {/* Предупреждение о минимальной сумме */}
          {isAmountTooLow && (
            <div className="flex items-center gap-1.5 text-red-500 px-1 animate-in slide-in-from-top-1">
              <AlertCircle size={14} />
              <span className="text-[11px] font-black uppercase tracking-tighter">Минимальная сумма — {MIN_AMOUNT} ₽</span>
            </div>
          )}

          {amount && !isAmountTooLow && (
            <div className="bg-amber-500/5 rounded-xl p-4 border border-amber-500/10 animate-in zoom-in-95 duration-300 space-y-2">
              {/* Сумма пополнения */}
              <div className="flex justify-between text-sm">
                <span className="text-white/70">Сумма пополнения</span>
                <span className="text-white font-bold">
                  {receiveSelected.toFixed(2)} {selectedCurrency === 'RUB' ? '₽' : selectedCurrency === 'USD' ? '$' : selectedCurrency === 'KZT' ? '₸' : '₴'}
                </span>
              </div>
              {/* Итого */}
              <div className="flex justify-between text-sm border-t border-white/10 pt-2">
                <span className="text-white font-bold">Итого</span>
                <span className="text-white font-bold">
                  {finalPrice} ₽
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ПРАВИЛА */}
      <div className="space-y-4 px-1">
        <div className="flex items-center gap-2 text-white/90 font-black text-xs uppercase tracking-tighter"><Info size={18} className="text-amber-500" /><span>Важные правила покупки</span></div>
        <div className="space-y-3">
          {[
            { id: 1, text: 'Нужно ввести логин аккаунта, если Вы введете его неправильно, то средства могут быть утеряны' },
            { id: 2, text: 'Никнейм не всегда совпадает с логином, нужно ввести именно логин.' },
            { id: 3, text: 'После успешной оплаты средства поступят до 10 минут, если они не пришли, то обратитесь в поддержку.' },
          ].map(rule => (
            <div key={rule.id} className="flex gap-4 items-start">
              <div className="w-8 h-8 shrink-0 bg-amber-500/10 border border-amber-500/20 rounded-lg flex items-center justify-center text-amber-500 font-black text-sm">{rule.id}</div>
              <p className="text-white/60 text-[13px] leading-snug pt-0.5 font-medium">{rule.text}</p>
            </div>
          ))}
        </div>
      </div>

      <button
        disabled={!login || !amount || amountInRub < MIN_AMOUNT || loginStatus !== 'valid'}
        onClick={() => setShowCheckout(true)}
        className="w-full bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-400 hover:to-orange-500 disabled:opacity-30 disabled:grayscale py-6 rounded-2xl text-black font-black text-xl uppercase transition-all shadow-lg shadow-amber-900/40 mt-2 active:scale-[0.98]"
      >
        {loginStatus !== 'valid'
          ? 'Проверьте логин'
          : isAmountTooLow
            ? `Мин. сумма ${MIN_AMOUNT} ₽`
            : 'Пополнить баланс'}
      </button>
    </div>
  );
};

export default Steam;