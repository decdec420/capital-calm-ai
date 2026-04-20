import { Activity, BookOpen, Brain, LayoutDashboard, LineChart, Settings, Shield, Sparkles, TestTube2 } from "lucide-react";
import { NavLink } from "@/components/NavLink";
import { useLocation } from "react-router-dom";
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
import { cn } from "@/lib/utils";

const sections = [
  {
    label: "Operations",
    items: [
      { title: "Overview", url: "/", icon: LayoutDashboard },
      { title: "Market Intel", url: "/market", icon: LineChart },
      { title: "Trades", url: "/trades", icon: Activity },
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
      { title: "Settings", url: "/settings", icon: Settings },
    ],
  },
];

export function AppSidebar() {
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
  const location = useLocation();

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

      <SidebarFooter className="border-t border-sidebar-border">
        {!collapsed && (
          <div className="px-2 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground/60">
            v0.1 · BTC-USD
          </div>
        )}
      </SidebarFooter>
    </Sidebar>
  );
}
