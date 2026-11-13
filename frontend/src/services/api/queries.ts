import { queryOptions } from "@tanstack/react-query";
import { api } from "./client";

export const overviewQuery = queryOptions({ queryKey: ["overview"], queryFn: api.overview });
export const processesQuery = (sort: "cpu" | "memory") =>
  queryOptions({ queryKey: ["processes", sort], queryFn: () => api.processes(sort) });
export const gpuQuery = queryOptions({ queryKey: ["gpu"], queryFn: api.gpu });
export const servicesQuery = queryOptions({ queryKey: ["services"], queryFn: api.services });
export const auditQuery = queryOptions({ queryKey: ["audit"], queryFn: () => api.audit(100) });
export const metricsHistoryQuery = (minutes = 360) =>
  queryOptions({ queryKey: ["metrics-history", minutes], queryFn: () => api.metricsHistory(minutes), refetchInterval: 15000 });
export const usersUsageQuery = queryOptions({
  queryKey: ["users-usage"],
  queryFn: api.usersUsage,
  refetchInterval: 10000,
});
export const mcServersQuery = queryOptions({
  queryKey: ["minecraft-servers"],
  queryFn: api.mcServers,
  refetchInterval: 8000,
});
export const workspacesQuery = queryOptions({
  queryKey: ["workspaces"],
  queryFn: api.workspaces,
  refetchInterval: 8000,
});
