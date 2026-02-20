    import React, { useEffect, useState } from 'react';
    import { Loader2, CheckCircle2, Home } from 'lucide-react';

    interface PaymentStatusProps {
    orderId: string;
    onClose: () => void;
    }

    const PaymentStatus: React.FC<PaymentStatusProps> = ({ orderId, onClose }) => {
    const [status, setStatus] = useState<'pending' | 'paid' | 'error'>('pending');
    const VITE_API_NGROK = import.meta.env.VITE_API_NGROK;

    useEffect(() => {
        const interval = setInterval(async () => {
        try {
            const res = await fetch(`${VITE_API_NGROK}/api/check-status/${orderId}`);
            const data = await res.json();

            if (data.status === 'paid') {
            setStatus('paid');
            clearInterval(interval);
            if (window.Telegram?.WebApp?.HapticFeedback) {
                window.Telegram.WebApp.HapticFeedback.notificationOccurred('success');
            }
            }
        } catch (err) {
            console.error('Ошибка проверки статуса:', err);
        }
        }, 3000);

        const timeout = setTimeout(() => clearInterval(interval), 300000);

        return () => {
        clearInterval(interval);
        clearTimeout(timeout);
        };
    }, [orderId]);

    return (
        <div className="fixed inset-0 bg-[#0f0f10] z-[200] flex flex-col items-center justify-center px-6 text-center animate-in fade-in duration-500">
        <div className="w-full max-w-xs space-y-8">
            
            {status === 'pending' && (
            <>
                <div className="relative">
                <div className="absolute inset-0 bg-amber-500/20 blur-3xl rounded-full" />
                <Loader2 className="w-20 h-20 text-amber-500 animate-spin mx-auto relative z-10" strokeWidth={3} />
                </div>
                <div className="space-y-2">
                <h2 className="text-2xl font-black text-white uppercase italic">Ожидаем оплату</h2>
                <p className="text-white/50 font-medium text-sm">
                    Пожалуйста, завершите платеж в открывшемся окне. Это займет всего пару секунд.
                </p>
                </div>
            </>
            )}

            {status === 'paid' && (
            <>
                <div className="relative">
                <div className="absolute inset-0 bg-green-500/20 blur-3xl rounded-full" />
                <CheckCircle2 className="w-20 h-20 text-green-500 mx-auto relative z-10 animate-bounce" strokeWidth={3} />
                </div>
                <div className="space-y-2">
                <h2 className="text-2xl font-black text-white uppercase italic">Успешно!</h2>
                <p className="text-white/50 font-medium text-sm">
                    UC будут зачислены на ваш аккаунт в течение 5-10 минут.
                </p>
                </div>
            </>
            )}

            <button 
            onClick={onClose}
            className="w-full bg-white/5 hover:bg-white/10 py-4 rounded-2xl text-white font-black uppercase tracking-widest transition-all flex items-center justify-center gap-2"
            >
            <Home size={18} />
            На главную
            </button>
        </div>
        </div>
    );
    };

    export default PaymentStatus;