import React from 'react';
import { ChevronLeft } from 'lucide-react';

interface PsStoreProps {
  onBack: () => void;
}

const PsStore: React.FC<PsStoreProps> = ({ onBack }) => {
  return (
    <div className="flex flex-col gap-4">
      <button onClick={onBack} className="flex items-center gap-2 text-white active:scale-90 transition-all outline-none">
          <div className="bg-white/10 p-2 rounded-xl"><ChevronLeft size={20} /></div>
          <span className="text-sm font-bold uppercase tracking-wider">Назад</span>
    </button>
      <div className="bg-[#1c1c1e]/80 backdrop-blur-lg rounded-[35px] p-6 border border-white/10">
        <h2 className="text-2xl font-bold">PlayStation Store</h2>
        <p className="text-white/60">В разработке</p>
        {/* Добавьте здесь свой контент для PS Store */}
      </div>
    </div>
  );
};

export default PsStore;