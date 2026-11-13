import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { api, type ContainerInfo } from "@/services/api/client";
import { KV, PageHeader, Panel, Status, Empty } from "@/components/kdg/primitives";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type Search = { tab?: string | undefined };

export const Route = createFileRoute("/containers/$id")({
  validateSearch: (s: Record<string, unknown>): Search => ({
    tab: typeof s["tab"] === "string" ? s["tab"] : undefined,
  }),
  loader: async ({ context, params }) => {
    try {
      const list = await context.queryClient.ensureQueryData({
        queryKey: ["containers"],
        queryFn: api.containers,
      });
      const container = list.find((c) => c.id === params.id);
      if (!container) throw notFound();
      return container;
    } catch (e) {
      // SSR may run without a session cookie; let client handle auth/data.
      if (e && typeof e === "object" && "status" in (e as any)) throw e;
      return null;
    }
  },
  head: ({ loaderData }) => ({
    meta: [
      { title: `${(loaderData as ContainerInfo | null)?.name ?? "Container"} · KDG Cloud` },
      { name: "description", content: "Live Docker container details." },
    ],
  }),
  component: ContainerDetail,
});

function statusFor(c: ContainerInfo): "running" | "stopped" | "unhealthy" | "restarting" {
  const state = c.state.toLowerCase();
  if (state === "running") return "running";
  if (state === "restarting") return "restarting";
  if (["exited", "dead", "created"].includes(state)) return "stopped";
  return "unhealthy";
}

function ContainerDetail() {
  const initial = Route.useLoaderData() as ContainerInfo | null;
  const { id } = Route.useParams();
  const { tab } = Route.useSearch();
  const { data: list = [] } = useQuery({
    queryKey: ["containers"],
    queryFn: api.containers,
    ...(initial ? { initialData: [initial] } : {}),
    refetchInterval: 10000,
  });
  const c = list.find((item) => item.id === id) ?? initial ?? null;

  const unavailable = (feature: string) => (
    <Empty
      title={`${feature} not available`}
      hint="The current read-only Docker API does not expose this information yet. Nothing is fabricated."
    />
  );

  if (!c) {
    return (
      <div className="mx-auto max-w-[1400px]">
        <Link to="/containers" className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3" /> Containers
        </Link>
        <Empty title="Loading container…" hint="Fetching live container details." />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1400px]">
      <Link to="/containers" className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3" /> Containers
      </Link>
      <PageHeader
        title={c.name}
        badge={<Status value={statusFor(c)} />}
        description={`${c.image} · ${c.id}`}
      />
      <Tabs defaultValue={tab ?? "overview"}>
        <TabsList className="mb-3 flex-wrap h-auto">
          {["overview", "logs", "stats", "configuration", "health"].map((t) => (
            <TabsTrigger key={t} value={t} className="capitalize">{t}</TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="overview">
          <Panel title="Docker-reported summary">
            <KV rows={[
              ["Name", c.name],
              ["Container ID", <span className="font-mono">{c.id}</span>],
              ["Image", <span className="font-mono">{c.image}</span>],
              ["State", <Status value={statusFor(c)} />],
              ["Docker status", c.status || "Not reported"],
            ]} />
          </Panel>
        </TabsContent>
        <TabsContent value="logs">{unavailable("Logs")}</TabsContent>
        <TabsContent value="stats">{unavailable("Stats")}</TabsContent>
        <TabsContent value="configuration">{unavailable("Configuration")}</TabsContent>
        <TabsContent value="health">{unavailable("Health")}</TabsContent>
      </Tabs>
    </div>
  );
}
