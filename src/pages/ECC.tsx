/**
 * ECC Integration Dashboard — Real-time view of Everything Claude Code integration.
 * Shows connection status, agent registry, cost summary, and instinct rules.
 */

import { motion } from "framer-motion";
import {
  CheckCircle2,
  XCircle,
  RefreshCw,
  Bot,
  DollarSign,
  Brain,
  Loader2,
  Code2,
  Activity,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  useECCStatus,
  useECCAgents,
  useECCCostSummary,
  useECCInstincts,
  useECCSyncAgents,
} from "@/hooks/use-api";

const fadeUp = { hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0 } };
const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.06 } } };

function ConnectionBadge({ connected }: { connected: boolean }) {
  return connected ? (
    <Badge variant="outline" className="border-green-500/30 bg-green-500/10 text-green-400 gap-1">
      <CheckCircle2 className="h-3 w-3" /> Connected
    </Badge>
  ) : (
    <Badge variant="outline" className="border-red-500/30 bg-red-500/10 text-red-400 gap-1">
      <XCircle className="h-3 w-3" /> Disconnected
    </Badge>
  );
}

export default function ECC() {
  const { data: statusData, isLoading: statusLoading } = useECCStatus();
  const { data: agentsData, isLoading: agentsLoading } = useECCAgents();
  const { data: costData, isLoading: costLoading } = useECCCostSummary();
  const { data: instinctsData, isLoading: instinctsLoading } = useECCInstincts();
  const syncAgents = useECCSyncAgents();

  const status = statusData?.data?.data ?? statusData?.data;
  const agents = agentsData?.data?.data?.agents ?? agentsData?.data?.agents ?? [];
  const cost = costData?.data?.data ?? costData?.data;
  const instincts = instinctsData?.data?.data?.instincts ?? instinctsData?.data?.instincts ?? [];

  const isConnected = !!status?.connected;

  return (
    <motion.div
      className="space-y-6"
      variants={stagger}
      initial="hidden"
      animate="show"
    >
      {/* Header */}
      <motion.div variants={fadeUp} className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Code2 className="h-6 w-6 text-primary" />
            Dev Intelligence
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Everything Claude Code integration dashboard
          </p>
        </div>
        <div className="flex items-center gap-3">
          <ConnectionBadge connected={isConnected} />
          <button
            onClick={() => syncAgents.mutate()}
            disabled={syncAgents.isPending}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${syncAgents.isPending ? "animate-spin" : ""}`} />
            Sync Agents
          </button>
        </div>
      </motion.div>

      {/* Status Cards */}
      <motion.div variants={fadeUp} className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatusCard
          icon={Activity}
          label="Sessions (24h)"
          value={status?.sessionsLast24h ?? "—"}
          sub={`${status?.totalSessions ?? 0} total`}
          loading={statusLoading}
        />
        <StatusCard
          icon={Bot}
          label="Agents"
          value={agents.length}
          sub="Registered"
          loading={agentsLoading}
        />
        <StatusCard
          icon={DollarSign}
          label="Total Cost"
          value={cost?.combined?.totalUsd != null ? `$${Number(cost.combined.totalUsd).toFixed(2)}` : "—"}
          sub={`Dev: $${Number(cost?.development?.totalUsd ?? 0).toFixed(2)} | Prod: $${Number(cost?.production?.totalUsd ?? 0).toFixed(2)}`}
          loading={costLoading}
        />
        <StatusCard
          icon={Brain}
          label="Instincts"
          value={instincts.length}
          sub="Active rules"
          loading={instinctsLoading}
        />
      </motion.div>

      {/* Agent Registry */}
      <motion.div variants={fadeUp} className="rounded-xl border border-border bg-card p-5">
        <h2 className="text-base font-semibold mb-4 flex items-center gap-2">
          <Bot className="h-4 w-4 text-muted-foreground" />
          ECC Agent Registry
        </h2>
        {agentsLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : agents.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4">
            No agents synced yet. Click "Sync Agents" to import from ECC.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="pb-2 font-medium">Name</th>
                  <th className="pb-2 font-medium">Status</th>
                  <th className="pb-2 font-medium">Version</th>
                  <th className="pb-2 font-medium">Budget</th>
                  <th className="pb-2 font-medium">Model</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {agents.map((a: { id: string; name: string; status: string; version: string; maxCostUsd?: number; config?: Record<string, unknown> }) => (
                  <tr key={a.id} className="text-foreground">
                    <td className="py-2 font-mono text-xs">{a.name}</td>
                    <td className="py-2">
                      <Badge variant="outline" className="text-[10px]">
                        {a.status}
                      </Badge>
                    </td>
                    <td className="py-2 text-muted-foreground">{a.version}</td>
                    <td className="py-2 text-muted-foreground">
                      {a.maxCostUsd != null ? `$${a.maxCostUsd}` : '—'}
                    </td>
                    <td className="py-2 text-xs text-muted-foreground">
                      {(a.config as Record<string, unknown>)?.model as string ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </motion.div>

      {/* Instincts */}
      <motion.div variants={fadeUp} className="rounded-xl border border-border bg-card p-5">
        <h2 className="text-base font-semibold mb-4 flex items-center gap-2">
          <Brain className="h-4 w-4 text-muted-foreground" />
          Active Instincts
        </h2>
        {instinctsLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : instincts.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4">
            No instinct rules generated yet. Events from ECC hooks will generate instincts automatically.
          </p>
        ) : (
          <div className="space-y-2">
            {instincts.map((i: { id: string; rule: string; confidence: number; source: string }) => (
              <div
                key={i.id}
                className="flex items-start justify-between rounded-lg border border-border bg-background/50 px-4 py-3"
              >
                <div className="space-y-1">
                  <p className="text-sm font-medium">{i.rule}</p>
                  <p className="text-xs text-muted-foreground">Source: {i.source}</p>
                </div>
                <Badge variant="outline" className="shrink-0 text-[10px]">
                  {(i.confidence * 100).toFixed(0)}%
                </Badge>
              </div>
            ))}
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}

function StatusCard({
  icon: Icon,
  label,
  value,
  sub,
  loading,
}: {
  icon: typeof Activity;
  label: string;
  value: string | number;
  sub: string;
  loading: boolean;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : (
        <>
          <p className="text-2xl font-bold tracking-tight">{value}</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">{sub}</p>
        </>
      )}
    </div>
  );
}
