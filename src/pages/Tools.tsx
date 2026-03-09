import { useMemo } from "react";
import { motion } from "framer-motion";
import { StatusBadge } from "@/components/StatusBadge";
import { GitBranch, TicketCheck, Cloud, Database, Loader2, Wrench, AlertCircle } from "lucide-react";
import { useToolCalls } from "@/hooks/use-api";

const fadeUp = { hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0 } };
const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.08 } } };

export default function Tools() {
  const { data: toolCallsData, isLoading, isError } = useToolCalls();

  const iconMap: Record<string, React.ElementType> = {
    github: GitBranch,
    jira: TicketCheck,
    cloud_deploy: Cloud,
    database: Database,
  };

  // Aggregate tool calls into per-proxy summaries if real data exists
  const tools = useMemo(() => {
    const raw = toolCallsData?.data?.items || toolCallsData?.data;
    if (!raw || !Array.isArray(raw) || raw.length === 0) return [];

    const grouped: Record<string, { name: string; icon: string; calls: number; allowed: number; denied: number; escalated: number; latencies: number[]; lastCall: string }> = {};
    for (const call of raw) {
      const key = call.toolType || call.type || "unknown";
      if (!grouped[key]) {
        grouped[key] = { name: `${key} Proxy`, icon: key.toLowerCase().replace(/\s+/g, "_"), calls: 0, allowed: 0, denied: 0, escalated: 0, latencies: [], lastCall: call.createdAt || "—" };
      }
      grouped[key].calls++;
      if (call.result === "ALLOWED" || call.result === "allowed") grouped[key].allowed++;
      else if (call.result === "DENIED" || call.result === "denied") grouped[key].denied++;
      else if (call.result === "ESCALATED" || call.result === "escalated") grouped[key].escalated++;
      if (call.latencyMs) grouped[key].latencies.push(call.latencyMs);
    }

    return Object.values(grouped).map((g) => ({
      ...g,
      status: g.denied > g.calls * 0.1 ? "degraded" : "healthy",
      avgLatency: g.latencies.length > 0 ? `${Math.round(g.latencies.reduce((a, b) => a + b, 0) / g.latencies.length)}ms` : "—",
      lastCall: g.lastCall !== "—" ? new Date(g.lastCall).toLocaleTimeString() : "—",
    }));
  }, [toolCallsData]);

  // Summary totals
  const totals = useMemo(() => ({
    calls: tools.reduce((s, t) => s + t.calls, 0),
    allowed: tools.reduce((s, t) => s + t.allowed, 0),
    denied: tools.reduce((s, t) => s + t.denied, 0),
  }), [tools]);

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Tool Proxies</h1>
        <p className="text-sm text-muted-foreground mt-1">All agent tool calls are routed through secure proxies</p>
      </div>

      {/* Totals strip */}
      <div className="flex gap-4 text-xs">
        <span className="px-3 py-1.5 rounded-lg bg-muted font-mono font-medium">{totals.calls.toLocaleString()} total calls</span>
        <span className="px-3 py-1.5 rounded-lg bg-success/10 text-success font-mono font-medium">{totals.allowed.toLocaleString()} allowed</span>
        <span className="px-3 py-1.5 rounded-lg bg-destructive/10 text-destructive font-mono font-medium">{totals.denied.toLocaleString()} denied</span>
      </div>

      {isError && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" /> Failed to load tool proxy data. Check API connection.
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : tools.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
          <Wrench className="h-10 w-10 mb-3 opacity-40" />
          <p className="text-sm font-medium">No tool proxy data</p>
          <p className="text-xs mt-1">Tool call data will appear here once agents start using proxies.</p>
        </div>
      ) : (
        <motion.div initial="hidden" animate="show" variants={stagger} className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {tools.map((tool) => {
            const IconComponent = iconMap[(tool as any).icon || ""] || Wrench;
            return (
              <motion.div key={tool.name} variants={fadeUp} className="rounded-xl border border-border bg-card p-5 hover:bg-accent/30 transition-colors cursor-pointer">
                <div className="flex items-center gap-3 mb-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
                    <IconComponent className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold">{tool.name}</h3>
                    <p className="text-xs text-muted-foreground">Last call: {(tool as any).lastCall || "—"}</p>
                  </div>
                  <div className="ml-auto">
                    <StatusBadge status={(tool as any).status || "healthy"} pulse />
                  </div>
                </div>
                <div className="grid grid-cols-4 gap-3">
                  {[
                    { label: "Total Calls", value: tool.calls.toLocaleString() },
                    { label: "Avg Latency", value: (tool as any).avgLatency || "—" },
                    { label: "Allowed", value: tool.allowed.toLocaleString() },
                    { label: "Denied", value: tool.denied.toString() },
                  ].map((m) => (
                    <div key={m.label} className="text-center">
                      <p className="text-lg font-bold font-mono">{m.value}</p>
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wider">{m.label}</p>
                    </div>
                  ))}
                </div>
              </motion.div>
            );
          })}
        </motion.div>
      )}
    </div>
  );
}
