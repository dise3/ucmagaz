import React from 'react';
import { ChevronLeft } from 'lucide-react';


interface SteamProps {
  onBack: () => void;
}

const Steam: React.FC<SteamProps> = ({ onBack }) => {
  return (
    <div className="flex flex-col gap-4">
    <button onClick={onBack} className="flex items-center gap-2 text-white active:scale-90 transition-all outline-none">
          <div className="bg-white/10 p-2 rounded-xl"><ChevronLeft size={20} /></div>
          <span className="text-sm font-bold uppercase tracking-wider">Назад</span>
    </button>
      <div className="bg-[#1c1c1e]/80 backdrop-blur-lg rounded-[35px] p-6">
        <h2 className="text-2xl font-bold">Магазин Steam</h2>
        <p>В разработке</p>
        {/* Добавьте свою логику для Steam */}
      </div>
    </div>
  );
};

export default Steam;