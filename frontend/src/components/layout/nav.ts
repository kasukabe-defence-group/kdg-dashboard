import {
  Activity, AppWindow, Archive, Bell, Boxes, Brain, Code2, Container, Cpu, Database, FileText, Folder,
  Gauge, Globe, HardDrive, KeyRound, Layers, LayoutDashboard, ListTree, Lock, Network, Route as RouteIcon,
  ScrollText, Server, Settings, Share2, Shield, SquareTerminal, Users, Gamepad2, BookOpen, Wrench, BarChart3,
  FlaskConical,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  title: string;
  to: string;
  params?: Record<string, string>;
  icon: LucideIcon;
}
export interface NavGroup {
  label: string;
  items: NavItem[];
}

const m = (slug: string, title: string, icon: LucideIcon): NavItem => ({ title, to: "/m/$slug", params: { slug }, icon });

export const navGroups: NavGroup[] = [
  { label: "Overview", items: [
    { title: "Dashboard", to: "/", icon: LayoutDashboard },
    m("infrastructure", "Infrastructure", Server),
    m("utilization", "Resource utilization", Gauge),
    m("activity", "Activity feed", Activity),
    m("alerts", "Alerts", Bell),
  ]},
  { label: "Compute", items: [
    { title: "Containers", to: "/containers", icon: Container },
    { title: "Compose apps", to: "/compose", icon: Layers },
    m("services", "Services", Boxes),
    { title: "Processes", to: "/processes", icon: ListTree },
    { title: "Terminal", to: "/terminal", icon: SquareTerminal },
    { title: "GPU Lab", to: "/gpu", icon: Cpu },
  ]},
  { label: "Storage", items: [
    { title: "KDG Drive", to: "/kdg-drive", icon: Folder },
    m("shared", "Shared files", Share2),
    { title: "S3 Buckets", to: "/s3", icon: Database },
    m("access-keys", "Access keys", KeyRound),
    m("storage-analytics", "Storage analytics", BarChart3),
    m("backups", "Backups", Archive),
  ]},
  { label: "Networking", items: [
    m("networks", "Networks", Network),
    m("reverse-proxy", "Reverse proxy", Shield),
    m("domains", "Domains & routes", RouteIcon),
    m("endpoints", "Endpoints", Globe),
  ]},
  { label: "Applications", items: [
    { title: "Catalogue", to: "/apps", icon: AppWindow },
    { title: "Nextcloud", to: "/nextcloud", icon: HardDrive },
    { title: "Minecraft", to: "/minecraft", icon: Gamepad2 },
    m("websites", "Websites & APIs", Code2),
    m("ai-workloads", "AI workloads", Brain),
    { title: "Workspaces", to: "/workspace", icon: BookOpen },
    { title: "JupyterLab", to: "/lab", icon: FlaskConical },
    m("devtools", "Developer tools", Wrench),
  ]},
  { label: "Administration", items: [
    { title: "Users & teams", to: "/users", icon: Users },
    { title: "User resources", to: "/user-usage", icon: Gauge },
    { title: "API keys", to: "/api-keys", icon: KeyRound },
    m("roles", "Roles & permissions", Lock),
    { title: "Audit logs", to: "/audit", icon: ScrollText },
    m("sessions", "Sessions", FileText),
    m("security", "Security", Shield),
    { title: "Settings", to: "/settings", icon: Settings },
  ]},
];

export const allNavItems = navGroups.flatMap((g) => g.items.map((i) => ({ ...i, group: g.label })));

export const bottomNav: NavItem[] = [
  { title: "Home", to: "/", icon: LayoutDashboard },
  { title: "Containers", to: "/containers", icon: Container },
  { title: "Terminal", to: "/terminal", icon: SquareTerminal },
  { title: "Drive", to: "/kdg-drive", icon: Folder },
];
