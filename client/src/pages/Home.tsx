import React from 'react';

interface HomeProps {
    onShopClick: () => void;
}
const Home: React.FC<HomeProps> = ({ onShopClick }) => {
    return (
        <div className="flex flex-col gap-6 animate-in fade-in duration-700">
            <div className="relative bg-[#1c1c1e]/80 backdrop-blur-lg rounded-[35px] overflow-hidden border border-white/10 shadow-2xl">
                <div className="relative h-56">
                    <img 
                        src="/photo-banner.jpg"
                        className="w-full h-full object-cover"
                        alt="PUBG Banner"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-[#1c1c1e] via-transparent to-transparent" />
                </div>

                <div className="relative px-6 py-6 -mt-12">
                    <div className="flex items-center justify-between gap-4">
                        <div className="flex items-center gap-4">
                            <div className="relative">
                                <div className="absolute inset-0 bg-blue-500/20 blur-lg rounded-2xl" />
                                <div className="relative w-14 h-14 bg-black rounded-2xl border border-white/10 flex items-center justify-center overflow-hidden">
                                    <img src="/pubg-logo.jpg" alt="Logo" className="w-full h-full object-cover scale-150" />
                                </div>
                            </div>
                            <div className="flex flex-col">
                                <h3 className="font-bold text-white text-lg tracking-tight uppercase">
                                    PUBG MOBILE
                                </h3>
                            </div>
                        </div>

                        {/* Золотая кнопка с рабочим onShopClick */}
                        <button 
                            className="relative w-full max-w-[160px] active:scale-95 transition-all duration-200 outline-none select-none group overflow-hidden rounded-2xl"
                            onClick={() => {
                                window.Telegram?.WebApp?.HapticFeedback.impactOccurred('medium');
                                onShopClick();
                            }}
                        >
                            <div className="absolute inset-0 bg-[#d4af37] blur-lg opacity-10 group-hover:opacity-20 transition-opacity" />
                            <div className="relative p-[1.5px] bg-gradient-to-tr from-[#8a6d3b] via-[#e2c17d] to-[#8a6d3b] rounded-2xl">
                                <div className="relative bg-[#0f0f0f] py-3 rounded-[14px] flex items-center justify-center overflow-hidden">
                                    <div className="absolute top-0 -inset-full h-full w-1/2 z-5 block transform -skew-x-12 bg-gradient-to-r from-transparent via-white/10 to-transparent animate-shine" />
                                    <span className="relative z-10 bg-gradient-to-b from-[#f3d092] via-[#d4af37] to-[#8a6d3b] bg-clip-text text-transparent font-black text-xs uppercase tracking-[0.1em]">
                                        Пополнить
                                    </span>
                                </div>
                            </div>
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default Home;