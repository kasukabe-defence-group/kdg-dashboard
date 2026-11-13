import { PageHeader, Panel, Simulated } from "@/components/kdg/primitives";
export function ComingSoon({ title, description }: { title: string; description: string }) {
  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader title={title} badge={<Simulated />} description={description} />
      <Panel><p className="text-sm text-muted-foreground">This module's interface is not built yet.</p></Panel>
    </div>
  );
}
