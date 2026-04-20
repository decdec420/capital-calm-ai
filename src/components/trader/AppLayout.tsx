import { SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/trader/AppSidebar";
import { TopBar } from "@/components/trader/TopBar";
import { StatusFooter } from "@/components/trader/StatusFooter";
import { Outlet } from "react-router-dom";
import { useMarkToMarket } from "@/hooks/useMarkToMarket";

export function AppLayout() {
  // Live-mark every open position to market and roll equity. Runs once
  // per session so Overview/footer/Trades all reflect AI- and manually-
  // logged positions in real time.
  useMarkToMarket();
  return (
    <SidebarProvider defaultOpen>
      <div className="min-h-screen flex w-full bg-background">
        <AppSidebar />
        <div className="flex-1 flex flex-col min-w-0">
          <TopBar />
          <main className="flex-1 overflow-auto">
            <div className="p-6 max-w-[1600px] mx-auto w-full">
              <Outlet />
            </div>
          </main>
          <StatusFooter />
        </div>
      </div>
    </SidebarProvider>
  );
}
