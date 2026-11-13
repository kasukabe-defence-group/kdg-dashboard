import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "@/services/api/client";
import type { AuthUser, Role } from "@/types";

type Theme = "dark" | "light";
interface SessionCtx {
  user: AuthUser | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<AuthUser>;
  logout: () => Promise<void>;
  can: (min: Role) => boolean;
  theme: Theme;
  toggleTheme: () => void;
}

const rank: Record<Role, number> = { member: 0, moderator: 1, admin: 2, owner: 3 };
const Ctx = createContext<SessionCtx | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [theme, setTheme] = useState<Theme>("dark");
  const [themeReady, setThemeReady] = useState(false);

  useEffect(() => {
    try { setTheme(localStorage.getItem("kdg-theme") === "light" ? "light" : "dark"); } catch { /* Storage may be disabled. */ }
    setThemeReady(true);
  }, []);

  useEffect(() => {
    let done = false;
    const finish = (next: AuthUser | null) => {
      if (done) return;
      done = true;
      setUser(next);
      setLoading(false);
    };
    const timeout = window.setTimeout(() => finish(null), 10000);
    void api.authSession()
      .then((u) => finish(u))
      .catch(() => finish(null))
      .finally(() => window.clearTimeout(timeout));
  }, []);

  useEffect(() => {
    if (!themeReady) return;
    document.documentElement.classList.toggle("light", theme === "light");
    document.documentElement.classList.toggle("dark", theme === "dark");
    try { localStorage.setItem("kdg-theme", theme); } catch { /* Theme still works without persistence. */ }
  }, [theme, themeReady]);

  const login = async (username: string, password: string) => {
    const next = await api.login(username, password);
    setUser(next);
    return next;
  };

  const logout = async () => {
    await api.logout().catch(() => undefined);
    setUser(null);
  };

  return <Ctx.Provider value={{ user, loading, login, logout, can: (min) => !!user && rank[user.role] >= rank[min], theme, toggleTheme: () => setTheme((value) => value === "dark" ? "light" : "dark") }}>{children}</Ctx.Provider>;
}

export function useSession() {
  const context = useContext(Ctx);
  if (!context) throw new Error("useSession outside SessionProvider");
  return context;
}
