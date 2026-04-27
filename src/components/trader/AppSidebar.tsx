import { Activity, BarChart2, Bell, BookOpen, Brain, LayoutDashboard, LineChart, LogOut, Settings, Shield, Sparkles, TestTube2 } from "lucide-react";
import { NavLink } from "@/components/NavLink";
import { useLocation, Link } from "react-router-dom";
import { toast } from "sonner";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useAuth } from "@/contexts/AuthContext";
import { useAlerts } from "@/hooks/useAlerts";
import { useSignals } from "@/hooks/useSignals";
import { useExperiments } from "@/hooks/useExperiments";
import { useGuardrails } from "@/hooks/useGuardrails";

const sections = [
  {
    label: "Operations",
    items: [
      { title: "Overview", url: "/", icon: LayoutDashboard },
      { title: "Market Intel", url: "/market", icon: LineChart },
      { title: "Trades", url: "/trades", icon: Activity },
      { title: "Performance", url: "/performance", icon: BarChart2 },
      { title: "Alerts", url: "/alerts", icon: Bell },
      { title: "Journals", url: "/journals", icon: BookOpen },
    ],
  },
  {
    label: "Strategy",
    items: [
      { title: "Strategy Lab", url: "/strategy", icon: TestTube2 },
      { title: "Risk Center", url: "/risk", icon: Shield },
      { title: "Learning", url: "/learning", icon: Brain },
    ],
  },
  {
    label: "Assistant",
    items: [
      { title: "AI Copilot", url: "/copilot", icon: Sparkles },
    ],
  },
];

const initialsFor = (name?: string | null, email?: string | null) => {
  const source = (name || email || "OP").trim();
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  const initials = (parts[0]?.[0] ?? "O") + (parts[1]?.[0] ?? "");
  return initials.toUpperCase().slice(0, 2);
};

export function AppSidebar() {
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
  const location = useLocation();
  const { user, profile, signOut } = useAuth();
  const { alerts } = useAlerts();
  const { pending } = useSignals();
  const { counts: expCounts } = useExperiments();
  const { guardrails } = useGuardrails();

  const alertCount = alerts.length;
  const signalCount = pending.length;
  const reviewCount = expCounts.needsReview;
  const blockedCount = guardrails.filter((g) => g.level === "blocked").length;

  const badgeFor: Record<string, { count: number; bg: string }> = {
    "/alerts": { count: alertCount, bg: "hsl(var(--status-blocked))" },
    "/copilot": { count: signalCount, bg: "hsl(var(--primary))" },
    "/risk": { count: blockedCount, bg: "hsl(var(--status-caution))" },
    "/learning": { count: reviewCount, bg: "hsl(var(--status-caution))" },
  };

  const displayName = profile?.display_name || user?.email?.split("@")[0] || "Operator";
  const initials = initialsFor(profile?.display_name, user?.email);

  const handleSignOut = async () => {
    await signOut();
    toast.success("Signed out. Stay disciplined.");
  };

  return (
    <Sidebar collapsible="icon" className="border-r border-sidebar-border">
      <SidebarHeader className="border-b border-sidebar-border">
        <div className={cn("flex items-center gap-2.5 px-2 py-1.5", collapsed && "justify-center px-0")}>
          <div className="h-8 w-8 rounded-md bg-gradient-amber flex items-center justify-center shadow-amber shrink-0">
            <span className="text-primary-foreground font-bold text-sm">T</span>
          </div>
          {!collapsed && (
            <div className="flex flex-col leading-tight">
              <span className="text-sm font-semibold tracking-tight text-sidebar-foreground">Trader OS</span>
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Mission Control</span>
            </div>
          )}
        </div>
      </SidebarHeader>

      <SidebarContent className="px-1 py-2">
        {sections.map((section) => (
          <SidebarGroup key={section.label}>
            {!collapsed && (
              <SidebarGroupLabel className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground/60">
                {section.label}
              </SidebarGroupLabel>
            )}
            <SidebarGroupContent>
              <SidebarMenu>
                {section.items.map((item) => {
                  const active = location.pathname === item.url;
                  const badge = badgeFor[item.url];
                  const showBadge = !!badge && badge.count > 0;
                  return (
                    <SidebarMenuItem key={item.title}>
                      <SidebarMenuButton asChild isActive={active}>
                        <NavLink
                          to={item.url}
                          end
                          className={cn(
                            "group flex items-center gap-2.5 rounded-md text-sm transition-colors",
                            "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                          )}
                          activeClassName="bg-sidebar-accent text-primary font-medium border-l-2 border-primary -ml-px pl-[calc(0.5rem-1px)]"
                        >
                          <item.icon className="h-4 w-4 shrink-0" />
                          {!collapsed && <span>{item.title}</span>}
                          {!collapsed && showBadge && (
                            <span
                              className="ml-auto flex items-center justify-center min-w-[16px] h-4 rounded-full text-[9px] font-bold text-white px-1"
                              style={{ background: badge.bg }}
                              aria-label={`${badge.count} ${item.title} items`}
                            >
                              {badge.count > 9 ? "9+" : badge.count}
                            </span>
                          )}
                        </NavLink>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      {/* User shelf — avatar + name + email; popover with Settings & Sign out */}
      <SidebarFooter className="border-t border-sidebar-border p-2">
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn(
                "w-full flex items-center gap-2.5 rounded-md p-1.5 text-left transition-colors",
                "hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                collapsed && "justify-center",
              )}
              aria-label="Open user menu"
            >
              <div className="h-8 w-8 shrink-0 rounded-full bg-secondary border border-border flex items-center justify-center text-[11px] font-medium text-foreground">
                {initials}
              </div>
              {!collapsed && (
                <div className="flex-1 min-w-0 leading-tight">
                  <div className="text-sm text-sidebar-foreground truncate">{displayName}</div>
                  <div className="text-[10px] text-muted-foreground truncate">{user?.email}</div>
                </div>
              )}
              {!collapsed && <Settings className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
            </button>
          </PopoverTrigger>
          <PopoverContent
            side="right"
            align="end"
            className="w-56 p-1 bg-popover border-border"
          >
            <div className="px-2 py-1.5 border-b border-border mb-1">
              <div className="text-sm text-foreground truncate">{displayName}</div>
              <div className="text-[11px] text-muted-foreground truncate">{user?.email}</div>
            </div>
            <Link
              to="/settings"
              className="flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-foreground hover:bg-accent"
            >
              <Settings className="h-4 w-4" /> Settings
            </Link>
            <button
              type="button"
              onClick={handleSignOut}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-destructive hover:bg-destructive/10"
            >
              <LogOut className="h-4 w-4" /> Sign out
            </button>
          </PopoverContent>
        </Popover>
      </SidebarFooter>
    </Sidebar>
  );
}
