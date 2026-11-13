// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider, useSession } from "@/hooks/use-session";

vi.mock("@/services/api/client", () => ({ api: { authSession: vi.fn().mockResolvedValue(null) } }));

function ThemeControl() {
  const { theme, toggleTheme } = useSession();
  return <button onClick={toggleTheme}>{theme}</button>;
}

beforeEach(() => {
  // Node 26's experimental localStorage shadows jsdom's storage in Vitest.
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  });
  document.documentElement.className = "";
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("dashboard theme", () => {
  it("loads a saved White / Blue preference", async () => {
    localStorage.setItem("kdg-theme", "light");
    render(<SessionProvider><ThemeControl /></SessionProvider>);
    await waitFor(() => expect(screen.getByRole("button").textContent).toBe("light"));
    expect(document.documentElement.classList.contains("light")).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("toggles and retains the choice after remount", async () => {
    const view = render(<SessionProvider><ThemeControl /></SessionProvider>);
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(localStorage.getItem("kdg-theme")).toBe("light"));
    view.unmount();
    render(<SessionProvider><ThemeControl /></SessionProvider>);
    await waitFor(() => expect(screen.getByRole("button").textContent).toBe("light"));
    fireEvent.click(screen.getByRole("button"));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem("kdg-theme")).toBe("dark");
  });

  it("still switches themes when browser storage is blocked", async () => {
    vi.spyOn(localStorage, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    await act(async () => { render(<SessionProvider><ThemeControl /></SessionProvider>); });
    fireEvent.click(screen.getByRole("button"));
    expect(document.documentElement.classList.contains("light")).toBe(true);
  });
});
