import { Film, Flame, Heart, Home, Palette, Plus, Sparkles, Settings, Tv } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";

const mainItems = [
  { title: "Home", url: "/?tab=home", tab: "home", icon: Home },
  { title: "Movies", url: "/?tab=movies", tab: "movies", icon: Film },
  { title: "TV Shows", url: "/?tab=shows", tab: "shows", icon: Tv },
  { title: "Anime", url: "/?tab=anime", tab: "anime", icon: Sparkles },
  { title: "Cartoon", url: "/?tab=cartoon", tab: "cartoon", icon: Palette },
  { title: "Hent", url: "/?tab=hentai", tab: "hentai", icon: Flame },
  { title: "Favorites", url: "/?tab=favorites", tab: "favorites", icon: Heart },
];

const bottomItems = [
  { title: "Settings", url: "/?tab=settings", tab: "settings", icon: Settings },
];

interface AppSidebarProps {
  activeTab: string;
  onTabChange: (tab: string) => void;
}

export function AppSidebar({ activeTab, onTabChange }: AppSidebarProps) {
  const { state } = useSidebar();
  const collapsed = state === "collapsed";

  return (
    <Sidebar variant="floating" collapsible="icon" className="border-0 bg-transparent">
      <SidebarContent className="gap-4 overflow-hidden rounded-[24px] border border-white/8 bg-[linear-gradient(180deg,rgba(4,6,10,0.98),rgba(7,9,14,0.95))] px-2 py-3 shadow-[0_28px_80px_rgba(0,0,0,0.38)] group-data-[collapsible=icon]:px-0 group-data-[collapsible=icon]:py-2">
        <div className={cn("flex items-center", collapsed ? "justify-center px-0" : "justify-between px-2")}>
          <div className={cn("flex items-center gap-3", collapsed && "justify-center")}>
            <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-emerald-300/12 bg-[radial-gradient(circle_at_top,rgba(52,211,153,0.22),rgba(255,255,255,0.04))] shadow-[0_12px_30px_rgba(20,184,166,0.12)]">
              <Film className="h-[18px] w-[18px] text-[#7df4c8]" />
            </div>
            {!collapsed && (
              <div>
                <div className="text-[11px] uppercase tracking-[0.3em] text-white/38">Library</div>
                <div className="text-base font-semibold text-[#e8fff7]">CineVault</div>
              </div>
            )}
          </div>
        </div>

        <SidebarGroup className="p-1 group-data-[collapsible=icon]:p-0">
          <SidebarGroupLabel className="px-3 text-[10px] uppercase tracking-[0.3em] text-white/34">
            Browse
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="gap-2">
              {mainItems.map((item) => (
                <SidebarMenuItem key={item.tab}>
                  <SidebarMenuButton
                    isActive={activeTab === item.tab}
                    onClick={() => onTabChange(item.tab)}
                    tooltip={item.title}
                    className={cn(
                      "relative h-11 rounded-xl border px-3 text-sm transition-all duration-200 group-data-[collapsible=icon]:!size-11 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:!p-0",
                      activeTab === item.tab
                        ? "border-emerald-300/18 bg-[linear-gradient(180deg,rgba(45,212,191,0.18),rgba(16,185,129,0.08))] text-[#8ef6cf] shadow-[0_14px_34px_rgba(16,185,129,0.14)] before:absolute before:inset-y-3 before:left-0 before:w-[3px] before:rounded-full before:bg-[#5eead4] before:content-[''] group-data-[collapsible=icon]:before:left-1"
                        : "border-transparent text-slate-400 hover:border-white/6 hover:bg-white/[0.05] hover:text-white",
                    )}
                  >
                    <item.icon className="h-4 w-4" />
                    {!collapsed && <span className="font-medium">{item.title}</span>}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup className="mt-auto p-1 group-data-[collapsible=icon]:p-0">
          <SidebarGroupContent>
            <SidebarMenu className="gap-2">
              {bottomItems.map((item) => (
                <SidebarMenuItem key={item.tab}>
                  <SidebarMenuButton
                    isActive={activeTab === item.tab}
                    onClick={() => onTabChange(item.tab)}
                    tooltip={item.title}
                    className={cn(
                      "relative h-11 rounded-xl border px-3 text-sm transition-all duration-200 group-data-[collapsible=icon]:!size-11 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:!p-0",
                      activeTab === item.tab
                        ? "border-emerald-300/18 bg-[linear-gradient(180deg,rgba(45,212,191,0.18),rgba(16,185,129,0.08))] text-[#8ef6cf] shadow-[0_14px_34px_rgba(16,185,129,0.14)] before:absolute before:inset-y-3 before:left-0 before:w-[3px] before:rounded-full before:bg-[#5eead4] before:content-[''] group-data-[collapsible=icon]:before:left-1"
                        : "border-transparent text-slate-400 hover:border-white/6 hover:bg-white/[0.05] hover:text-white",
                    )}
                  >
                    <item.icon className="h-4 w-4" />
                    {!collapsed && <span className="font-medium">{item.title}</span>}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
              <SidebarMenuItem>
                <SidebarMenuButton
                  onClick={() => onTabChange("add")}
                  className="h-11 rounded-xl border border-emerald-300/18 bg-[linear-gradient(135deg,rgba(16,185,129,0.22),rgba(45,212,191,0.14))] px-3 font-semibold text-[#ebfff7] shadow-[0_18px_40px_rgba(16,185,129,0.14)] hover:brightness-110 group-data-[collapsible=icon]:!size-11 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:!p-0"
                  tooltip="Add Item"
                >
                  <Plus className="h-4 w-4" />
                  {!collapsed && <span>Add Item</span>}
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
