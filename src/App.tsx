import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppLayout } from "@/components/trader/AppLayout";
import { AuthProvider } from "@/contexts/AuthContext";
import { HelpModeProvider } from "@/contexts/HelpModeContext";
import { ProtectedRoute } from "@/components/trader/ProtectedRoute";
import Auth from "./pages/Auth";
import ResetPassword from "./pages/ResetPassword";
import Welcome from "./pages/Welcome";
import Overview from "./pages/Overview";
import MarketIntel from "./pages/MarketIntel";
import Trades from "./pages/Trades";
import Journals from "./pages/Journals";
import StrategyLab from "./pages/StrategyLab";
import RiskCenter from "./pages/RiskCenter";
import Learning from "./pages/Learning";
import Copilot from "./pages/Copilot";
import Settings from "./pages/Settings";
import NotFound from "./pages/NotFound.tsx";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <AuthProvider>
          <HelpModeProvider>
          <Routes>
            <Route path="/auth" element={<Auth />} />
            <Route path="/reset-password" element={<ResetPassword />} />
            <Route
              path="/welcome"
              element={
                <ProtectedRoute>
                  <Welcome />
                </ProtectedRoute>
              }
            />
            <Route
              element={
                <ProtectedRoute>
                  <AppLayout />
                </ProtectedRoute>
              }
            >
              <Route path="/" element={<Overview />} />
              <Route path="/market" element={<MarketIntel />} />
              <Route path="/trades" element={<Trades />} />
              <Route path="/journals" element={<Journals />} />
              <Route path="/strategy" element={<StrategyLab />} />
              <Route path="/risk" element={<RiskCenter />} />
              <Route path="/learning" element={<Learning />} />
              <Route path="/copilot" element={<Copilot />} />
              <Route path="/settings" element={<Settings />} />
            </Route>
            {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
            <Route path="*" element={<NotFound />} />
          </Routes>
          </HelpModeProvider>
        </AuthProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
