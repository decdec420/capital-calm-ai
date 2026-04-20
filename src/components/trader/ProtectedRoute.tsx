import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { WELCOME_KEY } from "@/pages/Welcome";

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-xs text-muted-foreground tracking-wider uppercase animate-pulse">
          Booting Trader OS…
        </div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/auth" state={{ from: location }} replace />;
  }

  // First-login walkthrough — only redirect if they've never seen it AND they're not already there.
  const seen = typeof window !== "undefined" && localStorage.getItem(WELCOME_KEY);
  if (!seen && location.pathname !== "/welcome") {
    return <Navigate to="/welcome" replace />;
  }

  return <>{children}</>;
}
