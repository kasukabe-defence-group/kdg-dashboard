import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Shield, Users, UserCircle } from "lucide-react";
import { api } from "@/services/api/client";
import { PageHeader, TableWrap, th, td, tr, Pill, Empty } from "@/components/kdg/primitives";

export const Route = createFileRoute("/users")({
  head: () => ({ meta: [
    { title: "Users & Teams · KDG Cloud" },
    { name: "description", content: "Dashboard users and role groups." },
  ]}),
  component: UsersPage,
});

const roleTone: Record<string, "success" | "warning" | "muted" | "destructive"> = {
  owner: "success",
  admin: "warning",
  moderator: "muted",
  member: "muted",
};

function UsersPage() {
  const { data: users = [], isPending, isError, error } = useQuery({
    queryKey: ["auth-users"],
    queryFn: api.users,
    refetchInterval: 30000,
  });

  const groups = [
    { label: "Owners", role: "owner", description: "Full control over dashboard and infrastructure actions." },
    { label: "Admins", role: "admin", description: "Administrative access to operations, keys, and control actions." },
    { label: "Moderators", role: "moderator", description: "Operational access with limited administrative privileges." },
    { label: "Members", role: "member", description: "Standard dashboard access." },
  ];

  return (
    <div className="mx-auto max-w-[1200px]">
      <PageHeader
        title="Users & Teams"
        badge={
          <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs text-primary">
            <Users className="size-3.5" /> {users.length} users
          </span>
        }
        description="Dashboard accounts provisioned for KDG Cloud, grouped by role/team."
        actions={
          <Link to="/user-usage" className="inline-flex items-center gap-1 text-[13px] text-primary hover:underline">
            Live resource usage →
          </Link>
        }
      />

      <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        {groups.map((g) => {
          const count = users.filter((u) => u.role === g.role).length;
          return (
            <div key={g.role} className="rounded-lg border bg-card p-4">
              <div className="mb-1 flex items-center justify-between">
                <div className="flex items-center gap-2 font-medium"><Shield className="size-4 text-muted-foreground" /> {g.label}</div>
                <Pill tone={roleTone[g.role] ?? "muted"}>{count}</Pill>
              </div>
              <p className="text-xs text-muted-foreground">{g.description}</p>
            </div>
          );
        })}
      </div>

      <TableWrap>
        {isPending ? (
          <div className="p-5 text-sm text-muted-foreground">Loading users…</div>
        ) : isError ? (
          <Empty title="Could not load users" hint={error instanceof Error ? error.message : "Request failed"} />
        ) : users.length === 0 ? (
          <Empty title="No users found" hint="No dashboard users are configured." />
        ) : (
          <table className="w-full text-[13px]">
            <thead className="bg-muted/40">
              <tr>
                <th className={th}>User</th>
                <th className={th}>Username</th>
                <th className={th}>Role / Team</th>
                <th className={th}>Access</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.username} className={tr}>
                  <td className={td}>
                    <div className="flex items-center gap-2">
                      <UserCircle className="size-4 text-muted-foreground" />
                      <span className="font-medium">{u.displayName || u.username}</span>
                    </div>
                  </td>
                  <td className={`${td} font-mono text-xs text-muted-foreground`}>{u.username}</td>
                  <td className={td}><Pill tone={roleTone[u.role] ?? "muted"}>{u.role}</Pill></td>
                  <td className={`${td} text-xs text-muted-foreground`}>
                    {u.role === "owner" ? "Full control" : u.role === "admin" ? "Admin & control actions" : u.role === "moderator" ? "Operational access" : "Standard access"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </TableWrap>
      <p className="mt-2 text-xs text-muted-foreground">Dashboard accounts are managed server-side. Only owner/admin sessions can view this list.</p>
    </div>
  );
}
