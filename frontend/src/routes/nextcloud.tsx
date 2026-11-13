import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { api } from "@/services/api/client";
import { PageHeader } from "@/components/kdg/primitives";
import { Button } from "@/components/ui/button";
import { ExternalLink, RefreshCw } from "lucide-react";

export const Route = createFileRoute("/nextcloud")({
  component: NextcloudPage,
});

function NextcloudPage() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState(0);

  const connect = async () => {
    setError(null);
    setReady(false);
    try {
      await api.nextcloudSso();
      setReady(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start Nextcloud session");
    }
  };

  useEffect(() => { void connect(); }, [key]);

  return (
    <div className="mx-auto flex h-[calc(100vh-7rem)] max-w-[1600px] flex-col">
      <PageHeader title="Nextcloud" description="Native Nextcloud interface embedded in the dashboard (SSO)." actions={<>
        <Button size="sm" variant="outline" onClick={() => setKey((v) => v + 1)}><RefreshCw className="size-4" /> Reconnect</Button>
        <Button size="sm" variant="outline" asChild><a href="/drive/" target="_blank" rel="noreferrer"><ExternalLink className="size-4" /> Open in new tab</a></Button>
      </>} />
      {error && <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}
      {!error && !ready && <div className="flex flex-1 items-center justify-center rounded-md border bg-card text-sm text-muted-foreground">Connecting to Nextcloud…</div>}
      {ready && <iframe key={key} title="Nextcloud" src="/drive/apps/files/" className="min-h-0 flex-1 rounded-md border bg-background" />}
    </div>
  );
}
