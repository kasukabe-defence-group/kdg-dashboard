import { Link, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel,
  SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem,
} from "@/components/ui/sidebar";
import { navGroups, type NavItem } from "./nav";
import { overviewQuery } from "@/services/api/queries";

export function itemPath(i: NavItem) {
  return i.params?.["slug"] ? `/m/${i.params["slug"]}` : i.to;
}

export function AppSidebar() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const { data: overview } = useQuery({
    ...overviewQuery,
    refetchInterval: 30000,
  });
  const active = (i: NavItem) => {
    const p = itemPath(i);
    return p === "/" ? path === "/" : path === p || path.startsWith(p + "/");
  };

  return (
    <Sidebar collapsible="icon" variant="floating">
      <SidebarHeader className="h-[72px] justify-center border-b border-sidebar-border px-3">
        <Link to="/" className="flex items-center gap-2 px-1">
          <img src="/kdg-logo.png" alt="KDG Cloud" className="size-9 shrink-0 rounded-md object-cover" />
          <div className="leading-tight group-data-[collapsible=icon]:hidden">
            <div className="text-base font-medium tracking-tight text-foreground">KDG Cloud</div>
            <div className="text-[9px] uppercase tracking-[0.12em] text-muted-foreground">Kasukabe Defence Group</div>
          </div>
        </Link>
      </SidebarHeader>
      <SidebarContent className="gap-1 py-3">
        {navGroups.map((g) => (
          <SidebarGroup key={g.label} className="py-1">
            <SidebarGroupLabel className="h-6 text-[10px] uppercase tracking-wider">{g.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu className="gap-1">
                {g.items.map((i) => (
                  <SidebarMenuButton key={i.title} asChild isActive={active(i)} tooltip={i.title} size="sm" className="h-9 rounded-lg px-3 text-[13px] data-[active=true]:text-primary">
                    <Link to={i.to as "/"} params={i.params as never} aria-current={active(i) ? "page" : undefined}>
                      <i.icon className="size-4" />
                      <span>{i.title}</span>
                    </Link>
                  </SidebarMenuButton>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter className="border-t border-sidebar-border">
        <SidebarMenu>
          <SidebarMenuItem>
            <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
              <span className={`size-2 shrink-0 rounded-full ${overview?.online ? "bg-success" : "bg-muted-foreground"}`} />
              <span className="truncate group-data-[collapsible=icon]:hidden">
                {overview ? `${overview.hostname} · ${overview.online ? "online" : "offline"}` : "Checking KDG node…"}
              </span>
            </div>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
