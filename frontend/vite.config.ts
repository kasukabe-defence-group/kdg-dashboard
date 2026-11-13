// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     Nitro, VITE_* env injection, @ path alias, React/TanStack dedupe, error logger plugins,
//     and sandbox detection (port/host/strictPort).
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

export default defineConfig({
  // Build a persistent Node.js HTTP server for the Ubuntu host.
  // The wrapper's default Cloudflare module target exports a fetch handler
  // and exits when launched directly with Node.
  nitro: {
    preset: "node-server",
  },

  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts.
    server: { entry: "server" },
  },

  vite: {
    // Keep local browser requests/cookies on the dashboard origin, including WS.
    server: {
      proxy: {
        "/api/v1": {
          target: process.env["KDG_API_INTERNAL_URL"] || "http://127.0.0.1:8000",
          changeOrigin: true,
          ws: true,
        },
      },
    },
    // Pre-bundle UI libraries at startup to avoid mid-session React re-optimization.
    optimizeDeps: {
      include: [
        "@radix-ui/react-accordion",
        "@radix-ui/react-alert-dialog",
        "@radix-ui/react-aspect-ratio",
        "@radix-ui/react-avatar",
        "@radix-ui/react-checkbox",
        "@radix-ui/react-collapsible",
        "@radix-ui/react-context-menu",
        "@radix-ui/react-dialog",
        "@radix-ui/react-dropdown-menu",
        "@radix-ui/react-hover-card",
        "@radix-ui/react-label",
        "@radix-ui/react-menubar",
        "@radix-ui/react-navigation-menu",
        "@radix-ui/react-popover",
        "@radix-ui/react-progress",
        "@radix-ui/react-radio-group",
        "@radix-ui/react-scroll-area",
        "@radix-ui/react-select",
        "@radix-ui/react-separator",
        "@radix-ui/react-slider",
        "@radix-ui/react-slot",
        "@radix-ui/react-switch",
        "@radix-ui/react-tabs",
        "@radix-ui/react-toggle",
        "@radix-ui/react-toggle-group",
        "@radix-ui/react-tooltip",
        "cmdk",
        "lucide-react",
        "recharts",
        "sonner",
        "vaul",
      ],
    },
  },
});
