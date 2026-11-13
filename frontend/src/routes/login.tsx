import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { LogIn, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSession } from "@/hooks/use-session";
import { toast } from "sonner";

export const Route = createFileRoute("/login")({
  component: LoginPage,
});

function LoginPage() {
  const { login, theme, toggleTheme } = useSession();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      await login(username.trim(), password);
      toast.success("Signed in");
      await navigate({ to: "/", replace: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Sign-in failed";
      setError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-ground flex min-h-screen flex-col items-center justify-center px-5 py-12">
      <Button type="button" variant="outline" size="icon" onClick={toggleTheme} className="absolute right-5 top-5 rounded-lg" aria-label={theme === "dark" ? "Switch to light mode" : "Switch to noir mode"}>
        {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
      </Button>
      <div className="page-enter mb-7 text-center">
        <img src="/kdg-logo.png" alt="KDG Cloud" className="mx-auto mb-5 size-14 rounded-md object-cover" />
        <p className="mb-2 text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Kasukabe Defence Group</p>
        <h1 className="text-4xl font-medium tracking-tight">KDG Cloud</h1>
        <p className="mt-3 text-sm text-muted-foreground">One console. Your infrastructure.</p>
      </div>
      <form onSubmit={onSubmit} className="panel page-enter w-full max-w-[400px] p-7 sm:p-8">
        <h2 className="mb-1 text-xl font-medium tracking-tight">Welcome back</h2>
        <p className="mb-6 text-[13px] text-muted-foreground">Sign in to your private cloud.</p>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="username">Username</Label>
            <Input id="username" className="h-11" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required aria-describedby={error ? "login-error" : undefined} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input id="password" className="h-11" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required aria-describedby={error ? "login-error" : undefined} />
          </div>
          {error && <p id="login-error" role="alert" className="rounded-lg border border-destructive/25 bg-destructive/10 p-3 text-xs text-destructive">{error}</p>}
          <Button type="submit" className="h-11 w-full" disabled={loading || !username || !password}>
            <LogIn className="size-4" /> {loading ? "Signing in…" : "Sign in"}
          </Button>
        </div>
        <p className="mt-4 text-center text-xs text-muted-foreground">Authorized KDG operators only.</p>
      </form>
      <p className="mt-6 text-[11px] text-muted-foreground">{theme === "dark" ? "Vision Noir" : "Light"} · KDG Cloud Console</p>
    </div>
  );
}
