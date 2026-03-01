import { motion } from "framer-motion";
import { StatusBadge } from "@/components/StatusBadge";
import { GitBranch, TicketCheck, Cloud, Database } from "lucide-react";

const tools = [
  { name: "GitHub Proxy", icon: GitBranch, status: "healthy" as const, calls: 2847, avgLatency: "23ms", lastCall: "12s ago", allowed: 2712, denied: 98, escalated: 37 },
  { name: "Jira Proxy", icon: TicketCheck, status: "healthy" as const, calls: 1293, avgLatency: "45ms", lastCall: "1m ago", allowed: 1248, denied: 34, escalated: 11 },
  { name: "Cloud Deploy Proxy", icon: Cloud, status: "degraded" as const, calls: 412, avgLatency: "180ms", lastCall: "5m ago", allowed: 389, denied: 18, escalated: 5 },
  { name: "Database Proxy", icon: Database, status: "healthy" as const, calls: 5621, avgLatency: "8ms", lastCall: "3s ago", allowed: 5498, denied: 112, escalated: 11 },
];

const fadeUp = { hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0 } };
const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.08 } } };

export default function Tools() {
  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Tool Proxies</h1>
        <p className="text-sm text-muted-foreground mt-1">All agent tool calls are routed through secure proxies</p>
      </div>

      <motion.div initial="hidden" animate="show" variants={stagger} className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {tools.map((tool) => (
          <motion.div key={tool.name} variants={fadeUp} className="rounded-xl border border-border bg-card p-5 hover:bg-accent/30 transition-colors cursor-pointer">
            <div className="flex items-center gap-3 mb-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
                <tool.icon className="h-5 w-5 text-muted-foreground" />
              </div>
              <div>
                <h3 className="text-sm font-semibold">{tool.name}</h3>
                <p className="text-xs text-muted-foreground">Last call: {tool.lastCall}</p>
              </div>
              <div className="ml-auto">
                <StatusBadge status={tool.status} pulse />
              </div>
            </div>
            <div className="grid grid-cols-4 gap-3">
              {[
                { label: "Total Calls", value: tool.calls.toLocaleString() },
                { label: "Avg Latency", value: tool.avgLatency },
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
        ))}
      </motion.div>
    </div>
  );
}
