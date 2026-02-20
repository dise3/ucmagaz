import React, { useEffect, useState } from 'react';
import { ChevronLeft } from 'lucide-react';

interface Skin {
  id: number;
  title: string;
  price: number;
  image: string;
}

interface SkinsProps {
  onBack: () => void;
  onSelect: (skin: any) => void;
}

const Skins: React.FC<SkinsProps> = ({ onBack, onSelect }) => {
  const [skins, setSkins] = useState<Skin[]>([]);
  const [loading, setLoading] = useState(true);
  const VITE_API_NGROK = import.meta.env.VITE_API_NGROK;

  useEffect(() => {
    const fetchSkins = async () => {
      try {
        const response = await fetch(`${VITE_API_NGROK}/api/skin-products`, {
          headers: {
            'ngrok-skip-browser-warning': 'true',
            'Accept': 'application/json',
            'Content-Type': 'application/json'
          }
        });
        
        const data = await response.json();
        
        const formattedSkins = data.map((s: any) => ({
          id: s.id,
          title: s.title,
          price: s.price_rub, // Используем цену в рублях напрямую
          image: s.image_url
        }));
        
        setSkins(formattedSkins);
      } catch (error) {
        console.error('Ошибка при загрузке скинов:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchSkins();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <div className="text-white/50 font-bold uppercase tracking-widest animate-pulse">
          Загрузка гардероба...
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 animate-in slide-in-from-right duration-500 pb-32">
      {/* Шапка */}
      <div className="flex items-center justify-between px-2 pt-2">
        <button onClick={onBack} className="flex items-center gap-2 text-white active:scale-90 transition-all outline-none">
          <div className="bg-white/10 p-2 rounded-xl"><ChevronLeft size={20} /></div>
          <span className="text-sm font-bold uppercase tracking-wider">Назад</span>
        </button>
        <h1 className="text-xs font-bold text-white/40 uppercase tracking-[0.2em]">Магазин Скинов</h1>
        <div className="w-10" />
      </div>

      {/* Инфо-карточка */}
      <div className="relative overflow-hidden bg-gradient-to-br from-[#1e1c1c] to-[#0a0a0a] border border-white/10 rounded-[32px] p-6 shadow-2xl mx-1">
        <div className="absolute top-0 right-0 w-32 h-32 bg-red-500/10 blur-[50px] -mr-10 -mt-10" />
        <div className="relative z-10 flex items-center gap-4 mb-3">
          <div className="relative w-14 h-14 bg-black rounded-2xl border border-white/10 flex items-center justify-center overflow-hidden">
            <img src="/pubg-logo.jpg" alt="Skins" className="w-full h-full object-cover scale-150" />
          </div>
          <h2 className="text-xl font-black text-white tracking-tight italic uppercase">Эксклюзивные Скины</h2>
        </div>
        <p className="relative z-10 text-[13px] text-white/60 leading-relaxed font-medium">
          Получайте эксклюзивные скины <span className="text-amber-400 font-bold">уточняйте о выдаче у продавца</span> ⚡️
        </p>
      </div>

      {/* Сетка товаров */}
      <div className="grid grid-cols-2 gap-3 px-2">
        {skins.map((skin) => (
          <div 
            key={skin.id} 
            onClick={() => {
              window.Telegram?.WebApp?.HapticFeedback.impactOccurred('medium');
              onSelect({ ...skin, is_skin: true }); 
            }}
            className="relative bg-[#121212]/60 border border-white/10 rounded-[28px] p-3 flex flex-col items-center gap-3 active:scale-95 transition-all cursor-pointer group overflow-hidden"
          >
            {/* Картинка товара (загруженная админом через ТГ) */}
            <div className="relative w-full aspect-square rounded-[20px] overflow-hidden bg-white/5">
              <img 
                src={skin.image || '/skin-placeholder.png'} 
                className="w-full h-full object-cover transform group-hover:scale-110 transition-transform duration-500" 
                alt={skin.title} 
              />
            </div>
            
            <div className="relative z-10 flex flex-col items-center gap-2 w-full overflow-hidden text-center">
              {/* Название скина */}
              <div className="text-[15px] font-bold text-white leading-tight h-10 flex items-center justify-center line-clamp-2 px-1">
                {skin.title}
              </div>

              {/* Цена */}
              <div className="relative w-full group overflow-hidden rounded-2xl">
                <div className="absolute inset-0 bg-[#d4af37] blur-lg opacity-10 group-hover:opacity-20 transition-opacity" />
                <div className="relative p-[1.5px] bg-gradient-to-tr from-[#8a6d3b] via-[#e2c17d] to-[#8a6d3b] rounded-2xl">
                  <div className="relative bg-[#0f0f0f] py-2.5 rounded-[14px] flex items-center justify-center overflow-hidden">
                    <span className="relative z-10 bg-gradient-to-b from-[#f3d092] via-[#d4af37] to-[#8a6d3b] bg-clip-text text-transparent font-black text-[15px] uppercase tracking-wider">
                      {skin.price.toLocaleString()} ₽
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

export default Skins;