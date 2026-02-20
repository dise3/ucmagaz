import { Home, MessagesSquare, Headset } from 'lucide-react';

interface NavigationProps {
    activeTab: string;
    onTabChange: (tab: string) => void;
    isStoreMod: boolean;
}

export const Navigation = ({ activeTab, onTabChange, isStoreMod }: NavigationProps) => {
    const triggerHaptic = (style: 'light' | 'medium' = 'light') => {
        window.Telegram?.WebApp?.HapticFeedback.impactOccurred(style);
    };

    const openLink = (url: string) => {
        triggerHaptic('light');
        window.Telegram?.WebApp?.openTelegramLink(url);
    };

    const tapStyle: React.CSSProperties = {
        WebkitTapHighlightColor: 'transparent',
        WebkitUserSelect: 'none',
        userSelect: 'none',
        outline: 'none',
        backgroundColor: 'transparent',
    };

    const baseBtnClass = "flex-1 flex justify-center py-1 active:scale-90 transition-all outline-none focus:outline-none focus:ring-0 select-none touch-none bg-transparent active:bg-transparent focus:bg-transparent";

    return (
        <nav className="fixed bottom-10 left-6 right-6 z-50">
            {/* Изменили p-2 на p-1 для уменьшения общей высоты панели */}
            <div className="flex items-center justify-between bg-white/10 backdrop-blur-3xl border border-white/20 rounded-[30px] p-1 shadow-2xl transition-all duration-500">
                {isStoreMod ? (
                    <>
                        {[
                            { id: 'uc', src: '/uc-ph.png' },
                            { id: 'promo', src: '/1.png' }, 
                            { id: 'pp', src: '/pp.png' }, 
                            { id: 'car', src: '/car.png' },
                        ].map((item) => (
                            <button 
                                key={item.id}
                                onClick={() => {
                                    onTabChange(item.id); 
                                    triggerHaptic('light');
                                }}
                                className={baseBtnClass}
                                style={tapStyle}
                            >
                                {/* Уменьшили высоту с w-16 h-16 до w-13 h-13 и скруглили чуть меньше (rounded-xl) */}
                                <div className={`w-13 h-13 rounded-[18px] flex items-center justify-center overflow-hidden border transition-all duration-300 ${
                                    activeTab === item.id 
                                    ? 'bg-white/20 border-white/40 shadow-[0_0_15px_rgba(255,255,255,0.1)]' 
                                    : 'bg-white/5 border-white/10'
                                }`}>
                                    <img 
                                        src={item.src} 
                                        alt={item.id} 
                                        className="w-full h-full object-contain transform scale-110 pointer-events-none"
                                        style={{ 
                                            mixBlendMode: 'multiply',
                                            filter: 'contrast(1.1) brightness(1.1)' 
                                        }}
                                    />
                                </div>
                            </button>
                        ))}
                    </>
                ) : (
                    <>
                        {/* Для обычного режима тоже уменьшили p-4 до p-3 */}
                        <button onClick={() => openLink('https://t.me/+o4Y9CxHG2bMxOTYy')} className={`${baseBtnClass} text-white/40 p-3`} style={tapStyle}>
                            <MessagesSquare size={24} strokeWidth={1.5} />
                        </button>
                        <button 
                            onClick={() => { onTabChange('home'); triggerHaptic('medium'); }} 
                            className={`${baseBtnClass} p-3 rounded-[22px] ${activeTab === 'home' ? 'text-white bg-white/10 shadow-[0_4px_20px_rgba(255,255,255,0.1)]' : 'text-white/40'}`}
                            style={tapStyle}
                        >
                            <Home size={26} strokeWidth={activeTab === 'home' ? 2 : 1.5} />
                        </button>
                        <button onClick={() => openLink('https://t.me/KoT9lpa_MANAGER')} className={`${baseBtnClass} text-white/40 p-3`} style={tapStyle}>
                            <Headset size={24} strokeWidth={1.5} />
                        </button>
                    </>
                )}
            </div>
        </nav>
    );
};