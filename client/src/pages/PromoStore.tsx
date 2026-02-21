import React, { useEffect, useState } from 'react';
import { ChevronLeft } from 'lucide-react';

interface Pack {
    id: number;
    amount: number;
    price: number;
    image: string;
}

interface PromoStoreProps {
    onBack: () => void;
}

const PromoStore: React.FC<PromoStoreProps> = ({ onBack }) => {
    const [packs, setPacks] = useState<Pack[]>([]);
    const [loading, setLoading] = useState(true);
    const VITE_API_NGROK = import.meta.env.VITE_API_NGROK;

    useEffect(() => {
        const fetchProducts = async () => {
            try {
                const response = await fetch(`${VITE_API_NGROK}/api/products?store=promo`, {
                    headers: {
                        'ngrok-skip-browser-warning': 'true',
                        'Accept': 'application/json',
                        'Content-Type': 'application/json'
                    }
                });

                const data = await response.json();

                const formattedPacks = data
                    .filter((p: any) => p.amount_uc >= 445)
                    .map((p: any) => ({
                        id: p.id,
                        amount: p.amount_uc,
                        price: p.price,
                        image: p.image_url
                    }));

                setPacks(formattedPacks);
            } catch (error) {
                console.error('Ошибка при загрузке товаров:', error);
            } finally {
                setLoading(false);
            }
        };

        fetchProducts();
    }, []);

    const handleSelect = async () => {
        window.Telegram?.WebApp?.openTelegramLink('https://t.me/KoT9lpa_MANAGER');
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
            <div className="flex items-center justify-between px-2 pt-2">
                <button onClick={onBack} className="flex items-center gap-2 text-white active:scale-90 transition-all outline-none">
                    <div className="bg-white/10 p-2 rounded-xl"><ChevronLeft size={20} /></div>
                    <span className="text-sm font-bold uppercase tracking-wider">Назад</span>
                </button>
                <h1 className="text-xs font-bold text-white/40 uppercase tracking-[0.2em]">Магазин UC</h1>
                <div className="w-10" />
            </div>

            <div className="relative overflow-hidden bg-gradient-to-br from-[#1c1c1e] to-[#0a0a0a] border border-white/10 rounded-[32px] p-6 shadow-2xl mx-1">
                <div className="absolute top-0 right-0 w-32 h-32 bg-blue-500/10 blur-[50px] -mr-10 -mt-10" />
                <div className="relative z-10 flex items-center gap-4 mb-3">
                    <div className="relative w-14 h-14 bg-black rounded-2xl border border-white/10 flex items-center justify-center overflow-hidden">
                        <img src="/pubg-logo.jpg" alt="Logo" className="w-full h-full object-cover scale-150" />
                    </div>
                    <h2 className="text-xl font-black text-white tracking-tight italic uppercase">Дешёвое пополнение UC</h2>
                </div>
                <p className="relative z-10 text-[13px] text-white/60 leading-relaxed font-medium">
                    Занимает ощутимо больше времени, нежели  <span className="text-amber-400 font-bold">автоматическое пополнение</span> 
                </p>
            </div>

            <div className="grid grid-cols-2 gap-3 px-2">
                {packs.map((pack) => (
                    <div
                        key={pack.id}
                        onClick={() => {
                            window.Telegram?.WebApp?.HapticFeedback.impactOccurred('medium');
                            handleSelect();
                        }}
                        className="relative bg-[#121212]/60 border border-white/10 rounded-[28px] p-3 flex flex-col items-center gap-3 active:scale-95 transition-all cursor-pointer group overflow-hidden"
                    >
                        <div className="relative w-full aspect-square rounded-[20px] overflow-hidden">
                            <img src={pack.image} className="w-full h-full object-cover" alt="" />
                        </div>

                        <div className="relative z-10 flex flex-col items-center gap-2 w-full overflow-hidden text-center">
                            <div className="text-lg font-black italic text-white whitespace-nowrap">
                                {pack.amount.toLocaleString().replace(/,/g, ' ')} UC
                            </div>

                            <div className="relative w-full group overflow-hidden rounded-2xl">
                                <div className="absolute inset-0 bg-[#d4af37] blur-lg opacity-10 group-hover:opacity-20 transition-opacity" />
                                <div className="relative p-[1.5px] bg-gradient-to-tr from-[#8a6d3b] via-[#e2c17d] to-[#8a6d3b] rounded-2xl">
                                    <div className="relative bg-[#0f0f0f] py-2.5 rounded-[14px] flex items-center justify-center overflow-hidden">
                                        <div className="absolute top-0 -inset-full h-full w-1/2 z-5 block transform -skew-x-12 bg-gradient-to-r from-transparent via-white/10 to-transparent animate-shine" />
                                        <span className="relative z-10 bg-gradient-to-b from-[#f3d092] via-[#d4af37] to-[#8a6d3b] bg-clip-text text-transparent font-black text-[15px] uppercase tracking-wider">
                                            {pack.price.toLocaleString().replace(/,/g, ' ')} ₽
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

export default PromoStore;