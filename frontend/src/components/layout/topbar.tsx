import { useEffect, useState } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { Bell, ChevronRight, LogOut, Moon, Search, Sun, UserCog } from "lucide-react";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { allNavItems } from "./nav";
import { itemPath } from "./app-sidebar";
import { TerminalDockButton } from "@/components/kdg/terminal-dock";
import { useSession } from "@/hooks/use-session";
import { containers, buckets } from "@/services/mocks/data";
import { toast } from "sonner";

export function Initials({ name, className = "" }: { name: string; className?: string }) {
  const i = name.split(" ").map((p) => p[0]).slice(0, 2).join("");
  return <span className={`grid size-7 shrink-0 place-items-center rounded-full bg-accent text-[11px] font-semibold text-accent-foreground ${className}`}>{i}</span>;
}

function Crumbs() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const match = allNavItems.find((i) => itemPath(i) !== "/" && path.startsWith(itemPath(i)));
  const extra = match ? path.slice(itemPath(match).length).split("/").filter(Boolean) : [];
  return (
    <nav aria-label="Breadcrumb" className="hidden min-w-0 items-center gap-1 text-[13px] text-muted-foreground md:flex">
      <Link to="/" className="hover:text-foreground">KDG Cloud</Link>
      {match && (<><ChevronRight className="size-3.5" /><span>{match.group}</span><ChevronRight className="size-3.5" />
        <Link to={match.to as "/"} params={match.params as never} className="text-foreground hover:underline">{match.title}</Link></>)}
      {!match && (<><ChevronRight className="size-3.5" /><span className="text-foreground">Dashboard</span></>)}
      {extra.map((e) => (<span key={e} className="flex items-center gap-1"><ChevronRight className="size-3.5" /><span className="truncate font-mono text-xs text-foreground">{decodeURIComponent(e)}</span></span>))}
    </nav>
  );
}

export function Topbar() {
  const [open, setOpen] = useState(false);
  const nav = useNavigate();
  const { user, logout, theme, toggleTheme } = useSession();

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setOpen((o) => !o); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const go = (fn: () => void) => { setOpen(false); fn(); };
  const displayName = user?.displayName ?? "User";

  return (
    <header className="glass-toolbar sticky top-0 z-20 flex h-16 items-center gap-2 border-b px-3 sm:px-5">
      <SidebarTrigger className="size-9" />
      <Crumbs />
      <div className="flex-1" />
      <button aria-label="Search dashboard (Ctrl+K)" onClick={() => setOpen(true)} className="flex h-9 items-center gap-2 rounded-xl border border-border/70 bg-card/30 px-3 text-[13px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground sm:w-56">
        <Search className="size-4" />
        <span className="hidden sm:inline">Search resources…</span>
        <kbd className="ml-auto hidden rounded border px-1 font-mono text-[10px] sm:inline">Ctrl K</kbd>
      </button>
      <TerminalDockButton />
      <Button variant="outline" size="icon" className="size-9 rounded-xl" onClick={toggleTheme} aria-label={theme === "dark" ? "Switch to light mode" : "Switch to noir mode"} title={theme === "dark" ? "Light" : "Noir"}>
        {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-9" aria-label="Notifications">
            <Bell className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuLabel>Notifications</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled>No notifications</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="flex h-9 items-center gap-2 rounded-md px-1.5 hover:bg-accent" aria-label="Account menu">
            <Initials name={displayName} />
            <span className="hidden text-left leading-tight lg:block">
              <span className="block text-[13px] font-medium">{displayName}</span>
              <span className="block text-[10px] uppercase tracking-wide text-muted-foreground">{user?.role ?? ""}</span>
            </span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel>{displayName} · {user?.role ?? ""}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => nav({ to: "/settings" })}><UserCog className="size-4" /> Settings</DropdownMenuItem>
          <DropdownMenuItem onClick={() => void logout().then(() => nav({ to: "/login", replace: true })).catch(() => toast.error("Sign-out failed"))}><LogOut className="size-4" /> Sign out</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <CommandDialog open={open} onOpenChange={setOpen}>
        <CommandInput placeholder="Search pages, containers, buckets, users…" />
        <CommandList>
          <CommandEmpty>No results.</CommandEmpty>
          <CommandGroup heading="Pages">
            {allNavItems.map((i) => (
              <CommandItem key={i.title} value={`${i.group} ${i.title}`} onSelect={() => go(() => nav({ to: i.to as "/", params: i.params as never }))}>
                <i.icon className="size-4" /> {i.title} <span className="ml-auto text-xs text-muted-foreground">{i.group}</span>
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandGroup heading="Containers">
            {containers.map((c) => (
              <CommandItem key={c.id} value={`container ${c.name}`} onSelect={() => go(() => nav({ to: "/containers/$id", params: { id: c.id } }))}>
                {c.name} <span className="ml-auto font-mono text-xs text-muted-foreground">{c.image}</span>
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandGroup heading="Buckets">
            {buckets.map((b) => (
              <CommandItem key={b.name} value={`bucket ${b.name}`} onSelect={() => go(() => nav({ to: "/s3/$bucket", params: { bucket: b.name } }))}>
                s3://{b.name}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </header>
  );
}
