import { useState } from "react";
import { useSetup } from "./hooks/useSetup";
import { Navigation } from "./Navigation/AppL";
import Home from "./pages/Home";
import Store from "./pages/Store";
import Checkout from "./pages/Checkout";
import Prime from "./pages/PPandBilets"; 
import PromoStore from "./pages/PromoStore";
import Skins from "./pages/Skins";

declare global {
  interface Window {
    Telegram: {
      WebApp: any;
    };
  }
}

function App() {
  useSetup();
  const [onShop, setOnShop] = useState(false);
  const [page, setPage] = useState<"store" | "promo" | "checkout" | "prime" | "skins">("store");
  const [selectedPack, setSelectedPack] = useState<any>(null);

  const handlePackSelect = (pack: any) => {
    setSelectedPack(pack);
    setPage("checkout");
  };

  const handleBackToHome = () => {
    setOnShop(false);
    setPage("store");
  };

  return (
    <div className="relative h-screen w-full overflow-hidden text-white font-sans">
      <div 
        className="fixed inset-0 z-0 bg-cover bg-center bg-no-repeat"
        style={{ backgroundImage: "url('/back.jpg')" }}
      />
      
      <div className="fixed inset-0 z-0 bg-black/30" />

      <main className="relative z-10 h-full overflow-y-auto">
        <div className={`px-5 pt-4 ${page === "checkout" ? "pb-10" : "pb-32"}`}>
          {!onShop ? (
            <Home onShopClick={() => { setOnShop(true); setPage("store"); }} />
          ) : (
            <>
              {page === "store" && (
                <Store onBack={handleBackToHome} onSelect={handlePackSelect} />
              )}
              {page === "promo" && (
                <PromoStore onBack={handleBackToHome} />
              )}
              {page === "prime" && (
                <Prime onBack={handleBackToHome} onSelect={handlePackSelect} />
              )}
              {page === "skins" && (
                <Skins onBack={handleBackToHome} onSelect={handlePackSelect} />
              )}
              {page === "checkout" && (
                <Checkout pack={selectedPack} onBack={() => setPage(selectedPack?.is_code ? "promo" : "store")} />
              )}
            </>
          )}
        </div>
      </main>

      {page !== "checkout" && (
        <Navigation 
          activeTab={
            !onShop ? "home" : 
            page === "store" ? "uc" : 
            page === "promo" ? "promo" : 
            page === "prime" ? "pp" : 
            "car"
          } 
          onTabChange={(tabId) => {
            if (tabId === "home") {
              handleBackToHome();
            } else {
              setOnShop(true);
              if (tabId === "uc") setPage("store");
              if (tabId === "promo") setPage("promo"); // Теперь страница промокодов активна
              if (tabId === "pp") setPage("prime");
              if (tabId === "car") setPage("skins");
            }
          }} 
          isStoreMod={onShop} 
        />
      )}
    </div>
  );
}

export default App;