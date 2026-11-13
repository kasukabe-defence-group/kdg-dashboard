import { createFileRoute } from "@tanstack/react-router";
import { Layers } from "lucide-react";
import { PageHeader, Empty } from "@/components/kdg/primitives";

export const Route = createFileRoute("/compose")({
  head: () => ({ meta: [
    { title: "Compose Apps · KDG Cloud" },
    { name: "description", content: "Docker Compose applications and stacks." },
  ]}),
  component: ComposePage,
});

function ComposePage() {
  return (
    <div className="mx-auto max-w-[1200px]">
      <PageHeader title="Compose Apps" description="Docker Compose stacks and multi-container applications." />
      <Empty
        title="No Compose stacks configured"
        hint="Compose stack management is not configured in this dashboard yet. Running platform containers and services are visible on the Containers and Applications pages."
        icon={<Layers className="size-6" />}
      />
    </div>
  );
}
