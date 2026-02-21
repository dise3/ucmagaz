import React, { useState, useEffect } from 'react';
import { ChevronLeft, Minus, Plus, Star } from 'lucide-react';

interface PrimeProps {
    onBack: () => void;
    onSelect: (pack: any) => void;
}

const Prime: React.FC<PrimeProps> = ({ onBack, onSelect }) => {
    const [amountUC, setAmountUC] = useState(10000);
    const [amountTickets, setAmountTickets] = useState(100);
    const [settings, setSettings] = useState<any>(null);

    const VITE_API_NGROK = import.meta.env.VITE_API_NGROK;

    useEffect(() => {
        fetch(`${VITE_API_NGROK}/api/settings`, {
            headers: { 'ngrok-skip-browser-warning': 'true' }
        }).then(res => res.json()).then(setSettings);
    }, [VITE_API_NGROK]);

    const handleUCChange = (delta: number) => {
        setAmountUC(prev => Math.min(Math.max(prev + delta, 10000), 1000000));
        window.Telegram?.WebApp?.HapticFeedback.selectionChanged();
    };

    const handleTicketChange = (delta: number) => {
        setAmountTickets(prev => Math.min(Math.max(prev + delta, 100), 5000));
        window.Telegram?.WebApp?.HapticFeedback.selectionChanged();
    };

    const getPrice = (type: 'pp' | 'tickets', amount: number) => {
        if (!settings) return 0;
        const base = type === 'pp' 
            ? (settings.pp_price_usd * (amount / 10000)) * settings.usd_rate + (settings.pp_markup_rub || 0)
            : (settings.ticket_price_usd * (amount / 100)) * settings.usd_rate + (settings.ticket_markup_rub || 0);
        return Math.ceil(base * (1 + settings.fee_percent));
    };

    return (
        <div className="flex flex-col gap-6 animate-in slide-in-from-right duration-500 pb-32">
            {/* Header */}
            <div className="flex items-center justify-between px-2 pt-2">
                <button onClick={onBack} className="flex items-center gap-2 text-white active:scale-90 transition-all outline-none">
                    <div className="bg-white/10 p-2 rounded-xl"><ChevronLeft size={20} /></div>
                    <span className="text-sm font-bold uppercase tracking-wider">Назад</span>
                </button>
                <h1 className="text-xs font-bold text-white/40 uppercase tracking-[0.2em]">ПП, Билеты</h1>
                <div className="w-10" />
            </div>

            {/* Banner */}
            <div className="relative overflow-hidden bg-gradient-to-br from-[#1c1c1e] to-[#0a0a0a] border border-white/10 rounded-[32px] p-6 shadow-2xl mx-1">
                <div className="absolute top-0 right-0 w-32 h-32 bg-amber-500/10 blur-[50px] -mr-10 -mt-10" />
                <div className="relative z-10 flex items-center gap-4 mb-3">
                    <div className="w-12 h-12 bg-gradient-to-tr from-amber-400 to-amber-600 rounded-2xl flex items-center justify-center p-2 shadow-lg">
                        <Star className="text-black fill-black" size={24} />
                    </div>
                    <h2 className="text-xl font-black text-white tracking-tight italic uppercase">Покупка ПП, Билетов</h2>
                </div>
                <p className="relative z-10 text-[13px] text-white/60 leading-relaxed font-medium">
                    Покупка за 15 минут и меньше до конца раунда битвы <span className="text-amber-400 font-bold">разрешена только после согласования с менеджером</span>
                </p>
            </div>

            {/* Content Container */}
            <div className="flex flex-col gap-4 px-2">
                
                {/* Item 1: Prime Plus UC */}
                <div className="relative bg-[#121212]/60 border border-white/10 rounded-[32px] p-5 flex flex-col gap-5 overflow-hidden">
                    {/* Картинка на всю ширину */}
                    <div className="w-full h-full bg-white/5 rounded-2xl overflow-hidden border border-white/10">
                        <img src="/pporder.jpg" className="w-full h-full object-cover" alt="Prime Plus Banner" />
                    </div>

                    <div className="flex flex-col gap-1">
                        <h3 className="text-white font-black italic uppercase text-lg">Популярность</h3>
                    </div>

                    {/* Selector */}
                    <div className="flex items-center justify-between bg-black/40 rounded-2xl p-2 border border-white/5 select-none">
                        <button onPointerDown={() => handleUCChange(-10000)} className="w-12 h-12 bg-white/5 rounded-xl flex items-center justify-center active:scale-90 transition-all text-white/60 touch-manipulation"><Minus /></button>
                        <div className="text-center">
                            <span className="text-2xl font-black text-white italic">{amountUC.toLocaleString()}</span>
                        </div>
                        <button onPointerDown={() => handleUCChange(10000)} className="w-12 h-12 bg-white/5 rounded-xl flex items-center justify-center active:scale-90 transition-all text-white/60 touch-manipulation"><Plus /></button>
                    </div>

                    {/* Buy Button */}
                    <button 
                        onClick={() => onSelect({ amount: amountUC, type: 'pp' })}
                        className="relative w-full p-[1.5px] bg-gradient-to-tr from-[#8a6d3b] via-[#e2c17d] to-[#8a6d3b] rounded-2xl overflow-hidden active:scale-95 transition-all"
                    >
                        <div className="bg-[#0f0f0f] py-4 rounded-[14px] flex items-center justify-center gap-2">
                            <span className="text-white/40 font-bold text-xs">ИТОГО:</span>
                            <span className="text-[#d4af37] font-black text-lg">{getPrice('pp', amountUC).toLocaleString()} ₽</span>
                        </div>
                    </button>
                </div>

                {/* Item 2: Tickets */}
                <div className="relative bg-[#121212]/60 border border-white/10 rounded-[32px] p-5 flex flex-col gap-5 overflow-hidden">
                    {/* Картинка на всю ширину для Билетов */}
                    <div className="w-full h-full bg-white/5 rounded-2xl overflow-hidden border border-white/10">
                        <img src="/dom.jpg" className="w-full h-full object-cover" alt="Tickets Banner" />
                    </div>

                    <div className="flex flex-col gap-1">
                        <h3 className="text-white font-black italic uppercase text-lg">Билеты для дома</h3>
                    </div>

                    {/* Selector */}
                    <div className="flex items-center justify-between bg-black/40 rounded-2xl p-2 border border-white/5 select-none">
                        <button onPointerDown={() => handleTicketChange(-100)} className="w-12 h-12 bg-white/5 rounded-xl flex items-center justify-center active:scale-90 transition-all text-white/60 touch-manipulation"><Minus /></button>
                        <div className="text-center">
                            <span className="text-2xl font-black text-white italic">{amountTickets.toLocaleString()}</span>
                            <span className="ml-2 text-amber-500 font-bold text-xs uppercase">ШТ</span>
                        </div>
                        <button onPointerDown={() => handleTicketChange(100)} className="w-12 h-12 bg-white/5 rounded-xl flex items-center justify-center active:scale-90 transition-all text-white/60 touch-manipulation"><Plus /></button>
                    </div>

                    {/* Buy Button */}
                    <button 
                        onClick={() => onSelect({ amount: amountTickets, type: 'tickets' })}
                        className="relative w-full p-[1.5px] bg-gradient-to-tr from-[#8a6d3b] via-[#e2c17d] to-[#8a6d3b] rounded-2xl overflow-hidden active:scale-95 transition-all"
                    >
                        <div className="bg-[#0f0f0f] py-4 rounded-[14px] flex items-center justify-center gap-2">
                            <span className="text-white/40 font-bold text-xs">ИТОГО:</span>
                            <span className="text-[#d4af37] font-black text-lg">{getPrice('tickets', amountTickets).toLocaleString()} ₽</span>
                        </div>
                    </button>
                </div>

            </div>
        </div>
    );
};

export default Prime;