import type { ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { Menu } from "lucide-react";
import { SidebarProvider, useSidebar } from "@/components/ui/sidebar";
import { AppSidebar } from "./app-sidebar";
import { Topbar } from "./topbar";
import { TerminalDock } from "@/components/kdg/terminal-dock";
import { bottomNav } from "./nav";
import { cn } from "@/lib/utils";
import { USING_MOCKS } from "@/services/api/client";

function BottomNav() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const { setOpenMobile } = useSidebar();
  return (
    <nav aria-label="Mobile navigation" className="glass-toolbar fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t pb-[env(safe-area-inset-bottom)] md:hidden">
      {bottomNav.map((i) => {
        const on = i.to === "/" ? path === "/" : path.startsWith(i.to);
        return (
          <Link key={i.to} to={i.to as "/"} className={cn("flex h-14 flex-col items-center justify-center gap-0.5 text-[10px]", on ? "text-primary" : "text-muted-foreground")}>
            <i.icon className="size-5" />{i.title}
          </Link>
        );
      })}
      <button onClick={() => setOpenMobile(true)} className="flex h-14 flex-col items-center justify-center gap-0.5 text-[10px] text-muted-foreground">
        <Menu className="size-5" />More
      </button>
    </nav>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <SidebarProvider>
      <a href="#dashboard-content" className="skip-link">Skip to content</a>
      <div className="flex min-h-screen w-full">
        <AppSidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar />
          {USING_MOCKS && (
            <div className="border-b border-dashed border-warning/30 bg-warning/5 px-4 py-1 text-[11px] text-warning">
              Demo mode — showing mock data. Actions are simulated and do not touch the server.
            </div>
          )}
          <main id="dashboard-content" tabIndex={-1} className="min-w-0 flex-1 px-4 py-6 pb-[calc(5rem+env(safe-area-inset-bottom))] sm:px-6 md:pb-8 lg:px-8">{children}</main>
        </div>
      </div>
      <BottomNav />
      <TerminalDock />
    </SidebarProvider>
  );
}
