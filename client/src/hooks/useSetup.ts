import { useEffect } from "react";

export const useSetup = () => {
    useEffect(() => {
        const webApp = window.Telegram?.WebApp;
        if (!webApp) return;

        webApp.ready();
        webApp.expand();

        if (webApp.isVersionAtLeast('7.7')) {
            webApp.isVerticalSwipesEnabled = false;
        }

        if (webApp.disableScaling) {
            webApp.disableScaling();
        }

        const handleTouchStart = (e: TouchEvent) => {
            if (e.touches.length > 1) {
                e.preventDefault();
            }
        };

        let lastTouchTime = 0;
        const handleDoubleTap = (e: TouchEvent) => {
            const now = Date.now();
            if (now - lastTouchTime <= 300) {
                e.preventDefault();
            }
            lastTouchTime = now;
        };

        document.addEventListener('touchstart', handleTouchStart, { passive: false });
        document.addEventListener('touchstart', handleDoubleTap, { passive: false });

        document.title = "AccessWork";

        return () => {
            document.removeEventListener('touchstart', handleTouchStart);
            document.removeEventListener('touchstart', handleDoubleTap);
        };
    }, []);
};