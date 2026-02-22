import React, { useEffect, useState } from 'react';
import { ChevronLeft, Info } from 'lucide-react';

interface Pack {
  id: number | string;
  amount?: number;
  price: number;
  image: string;
  type?: 'prime' | 'prime_plus' | 'uc';
  title?: string;
  periods?: { months: number; price: number }[]; // Для Prime товаров
  months?: number; // Выбранный период
}

interface StoreProps {
  onBack: () => void;
  onSelect: (pack: Pack) => void;
}

const Store: React.FC<StoreProps> = ({ onBack, onSelect }) => {
  const [packs, setPacks] = useState<Pack[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTooltip, setActiveTooltip] = useState<string | null>(null);
  const [selectedPeriods, setSelectedPeriods] = useState<{ [key: string]: { months: number; price: number } }>({});
  const VITE_API_NGROK = import.meta.env.VITE_API_NGROK;

  const getPrimeBenefits = (type: string) => {
    if (type === 'prime') {
      return '• 60 UC сразу\n• Купоны на 150 UC\n• Ежедневно: 3 UC, 5 RP';
    } else if (type === 'prime_plus') {
      return '• 660 UC, 300 RP сразу\n• Купоны на 1200 UC\n• Ежедневно: 8 UC, 10 RP, 50 AG';
    }
    return '';
  };

  useEffect(() => {
    const fetchProducts = async () => {
      try {
        const headers = {
          'ngrok-skip-browser-warning': 'true',
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        };

        const [primeRes, ucRes] = await Promise.all([
          fetch(`${VITE_API_NGROK}/api/prime-prices?store=store`, { headers }),
          fetch(`${VITE_API_NGROK}/api/products?store=store`, { headers })
        ]);

        const primePrices = await primeRes.json();
        const ucData = await ucRes.json();
        
        const formattedPrimePacks = primePrices.map((item: any) => ({
          id: item.id,
          title: item.title,
          price: item.periods && item.periods.length > 0 ? Number(item.periods[0].price) : 0,
          image: item.image_url,
          type: item.id as 'prime' | 'prime_plus',
          periods: item.periods // Массив периодов
        }));
        
        const formattedUcPacks = ucData.map((p: any) => ({
          id: p.id,
          amount: p.amount_uc,
          price: p.price || 0,
          image: p.image_url,
          type: 'uc' as const
        }));
        
        setPacks([...formattedPrimePacks, ...formattedUcPacks]);

        // Инициализируем выбранные периоды для Prime товаров
        const initialPeriods: { [key: string]: { months: number; price: number } } = {};
        primePrices.forEach((item: any) => {
          if (item.periods && item.periods.length > 0 && item.periods[0]) {
            initialPeriods[item.id] = { months: item.periods[0].months, price: Number(item.periods[0].price) };
          }
        });
        setSelectedPeriods(initialPeriods);
      } catch (error) {
        console.error('Ошибка при загрузке товаров:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchProducts();
  }, [VITE_API_NGROK]);

  // Обработчик изменения периода
  const handlePeriodChange = (productId: string, months: number, periods: { months: number; price: number }[]) => {
    const selected = periods.find(p => p.months === months);
    if (selected) {
      setSelectedPeriods(prev => ({ ...prev, [productId]: { months: selected.months, price: Number(selected.price) } }));
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <div className="text-white/50 font-bold uppercase tracking-widest animate-pulse">
          Загрузка магазина...
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 animate-in slide-in-from-right duration-500 pb-32">
      {/* Header */}
      <div className="flex items-center justify-between px-2 pt-2">
        <button onClick={onBack} className="flex items-center gap-2 text-white active:scale-90 transition-all outline-none">
          <div className="bg-white/10 p-2 rounded-xl"><ChevronLeft size={20} /></div>
          <span className="text-sm font-bold uppercase tracking-wider">Назад</span>
        </button>
        <h1 className="text-xs font-bold text-white/40 uppercase tracking-[0.2em]">Магазин UC</h1>
        <div className="w-10" />
      </div>

      {/* Banner */}
      <div className="relative overflow-hidden bg-gradient-to-br from-[#1c1c1e] to-[#0a0a0a] border border-white/10 rounded-[32px] p-6 shadow-2xl mx-1">
        <div className="absolute top-0 right-0 w-32 h-32 bg-blue-500/10 blur-[50px] -mr-10 -mt-10" />
        <div className="relative z-10 flex items-center gap-4 mb-3">
          <div className="relative w-14 h-14 bg-black rounded-2xl border border-white/10 flex items-center justify-center overflow-hidden">
            <img src="/pubg-logo.jpg" alt="Logo" className="w-full h-full object-cover scale-150" />
          </div>
          <h2 className="text-xl font-black text-white tracking-tight italic uppercase">UC по ID 24/7</h2>
        </div>
        <p className="relative z-10 text-[13px] text-white/60 leading-relaxed font-medium">
          Работаем круглосуточно! Время пополнения <span className="text-amber-400 font-bold">от 1 до 15 минут</span> ⚡️
        </p>
      </div>

      {/* Grid */}
      <div className="grid grid-cols-2 gap-3 px-2">
        {packs.map((pack) => (
          <div 
            key={pack.id} 
            onClick={() => {
              window.Telegram?.WebApp?.HapticFeedback.impactOccurred('medium');
              const selectedPack = {
                ...pack,
                price: Number(selectedPeriods[pack.id]?.price || pack.price || 0),
                months: selectedPeriods[pack.id]?.months
              };
              onSelect(selectedPack);
            }} 
            className="relative bg-[#121212]/60 border border-white/10 rounded-[28px] p-3 flex flex-col items-center gap-3 active:scale-95 transition-all cursor-pointer group"
          >
              {/* Блок Info & Tooltip */}
              {(pack.type === 'prime' || pack.type === 'prime_plus') && (
                <div className="absolute top-4 right-4 z-[50]">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      window.Telegram?.WebApp?.HapticFeedback.impactOccurred('light');
                      setActiveTooltip(activeTooltip === String(pack.id) ? null : String(pack.id));
                    }}
                    className="w-7 h-7 bg-black/80 backdrop-blur-md rounded-full flex items-center justify-center border border-white/20 active:scale-90 transition-all shadow-xl"
                  >
                    <Info size={14} className={activeTooltip === String(pack.id) ? "text-amber-400" : "text-white/80"} />
                  </button>

                {activeTooltip === String(pack.id) && (
                  <div 
                    className={`absolute bottom-full mb-3 w-52 z-[100] animate-in fade-in zoom-in-95 duration-200 
                      ${pack.type === 'prime' 
                        ? 'left-0 origin-bottom-left'   // Обычный Прайм раскрывается ВПРАВО
                        : 'right-0 origin-bottom-right' // Прайм Плюс раскрывается ВЛЕВО
                      }`}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="relative bg-[#1a1a1a] border border-white/20 rounded-2xl p-3 shadow-[0_20px_50px_rgba(0,0,0,0.7)] backdrop-blur-2xl">
                      <p className="text-[11px] leading-relaxed text-white/90 font-medium whitespace-pre-line">
                        {getPrimeBenefits(pack.type || '')}
                      </p>
                      {/* Динамическая стрелочка под иконку */}
                      <div className={`absolute -bottom-1 w-2 h-2 bg-[#1a1a1a] border-r border-b border-white/20 transform rotate-45 
                        ${pack.type === 'prime' ? 'left-2.5' : 'right-2.5'}`} 
                      />
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="relative w-full aspect-square rounded-[20px] overflow-hidden z-10">
              <img src={pack.image} className="w-full h-full object-cover" alt="" />
            </div>
            
            <div className="relative z-10 flex flex-col items-center gap-2 w-full text-center">
              <div className="text-lg font-black italic text-white whitespace-nowrap uppercase">
                {pack.type === 'prime' || pack.type === 'prime_plus' 
                  ? pack.title 
                  : `${pack.amount?.toLocaleString('ru-RU')} UC`}
              </div>

              {/* Period Selector for Prime */}
              {pack.periods && pack.periods.length > 1 && (
                <select
                  value={selectedPeriods[pack.id]?.months?.toString() || (pack.periods[0]?.months?.toString() || '')}
                  onChange={(e) => {
                    e.stopPropagation();
                    handlePeriodChange(pack.id, parseInt(e.target.value), pack.periods);
                  }}
                  className="w-full bg-[#1a1a1a] border border-white/20 rounded-lg px-3 py-1 text-white text-sm"
                  onClick={(e) => e.stopPropagation()}
                >
                  {pack.periods.map(period => (
                    <option key={period.months} value={period.months.toString()}>
                      {period.months} мес - {period.price}₽
                    </option>
                  ))}
                </select>
              )}

              {/* Price Tag */}
              <div className="relative w-full overflow-hidden rounded-2xl">
                <div className="absolute inset-0 bg-[#d4af37] blur-lg opacity-10" />
                <div className="relative p-[1.5px] bg-gradient-to-tr from-[#8a6d3b] via-[#e2c17d] to-[#8a6d3b] rounded-2xl">
                  <div className="relative bg-[#0f0f0f] py-2.5 rounded-[14px] flex items-center justify-center overflow-hidden">
                    <div className="absolute top-0 -inset-full h-full w-1/2 z-5 block transform -skew-x-12 bg-gradient-to-r from-transparent via-white/10 to-transparent animate-shine" />
                    <span className="relative z-10 bg-gradient-to-b from-[#f3d092] via-[#d4af37] to-[#8a6d3b] bg-clip-text text-transparent font-black text-[15px] uppercase tracking-wider">
                      {Number(selectedPeriods[pack.id]?.price || pack.price || 0).toLocaleString('ru-RU')} ₽
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default Store;