import { motion } from "framer-motion";
import { ScrollText, Filter } from "lucide-react";
import { Button } from "@/components/ui/button";

const events = [
  { id: "evt_001", timestamp: "2026-03-01T14:23:45Z", type: "POLICY_VIOLATION", actor: "DeployBot-v1", action: "cloud_deploy.push_production", result: "DENIED", detail: "Policy pol_001 blocked production deploy" },
  { id: "evt_002", timestamp: "2026-03-01T14:20:12Z", type: "TASK_ESCALATED", actor: "DBGuard-v1", action: "db.alter_schema", result: "ESCALATED", detail: "Schema change requires human approval" },
  { id: "evt_003", timestamp: "2026-03-01T14:18:30Z", type: "AGENT_SPAWNED", actor: "admin@nexusops.io", action: "agent.create", result: "SUCCESS", detail: "DocWriter-v1 spawned in workspace ws_prod" },
  { id: "evt_004", timestamp: "2026-03-01T14:15:00Z", type: "TASK_COMPLETED", actor: "SecScanner-v2", action: "github.scan_repo", result: "SUCCESS", detail: "Security scan completed — 0 vulnerabilities" },
  { id: "evt_005", timestamp: "2026-03-01T14:12:44Z", type: "AGENT_KILLED", actor: "admin@nexusops.io", action: "agent.force_kill", result: "SUCCESS", detail: "DBGuard-v1 force killed after timeout" },
  { id: "evt_006", timestamp: "2026-03-01T14:10:20Z", type: "POLICY_UPDATED", actor: "admin@nexusops.io", action: "policy.update", result: "SUCCESS", detail: "pol_004 updated to v5" },
  { id: "evt_007", timestamp: "2026-03-01T14:08:11Z", type: "TOOL_CALL", actor: "TriageAgent-v2", action: "jira.create_ticket", result: "ALLOWED", detail: "Created PROJ-1848" },
  { id: "evt_008", timestamp: "2026-03-01T14:05:33Z", type: "POLICY_VIOLATION", actor: "CleanupBot-v1", action: "jira.bulk_delete", result: "DENIED", detail: "Policy pol_004 blocked bulk delete" },
];

const typeColors: Record<string, string> = {
  POLICY_VIOLATION: "text-destructive",
  TASK_ESCALATED: "text-warning",
  AGENT_SPAWNED: "text-primary",
  TASK_COMPLETED: "text-success",
  AGENT_KILLED: "text-destructive",
  POLICY_UPDATED: "text-primary",
  TOOL_CALL: "text-muted-foreground",
};

const fadeUp = { hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0 } };
const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.03 } } };

export default function Audit() {
  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2"><ScrollText className="h-6 w-6" /> Audit Log</h1>
          <p className="text-sm text-muted-foreground mt-1">Immutable event log — every action traced and attributed</p>
        </div>
        <Button variant="outline" className="gap-2"><Filter className="h-4 w-4" /> Filter</Button>
      </div>

      <motion.div initial="hidden" animate="show" variants={stagger} className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="grid grid-cols-[140px_140px_1fr_80px] gap-2 px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground border-b border-border hidden md:grid">
          <span>Timestamp</span><span>Type</span><span>Detail</span><span>Result</span>
        </div>
        {events.map((evt) => (
          <motion.div key={evt.id} variants={fadeUp} className="grid grid-cols-1 md:grid-cols-[140px_140px_1fr_80px] gap-2 px-4 py-3 items-center border-b border-border last:border-0 hover:bg-accent/30 transition-colors cursor-pointer">
            <span className="text-[11px] font-mono text-muted-foreground">{new Date(evt.timestamp).toLocaleTimeString()}</span>
            <span className={`text-xs font-mono font-medium ${typeColors[evt.type] || "text-foreground"}`}>{evt.type}</span>
            <div className="min-w-0">
              <p className="text-sm truncate">{evt.detail}</p>
              <p className="text-[11px] text-muted-foreground font-mono">{evt.actor} → {evt.action}</p>
            </div>
            <span className={`text-[11px] font-mono font-medium ${evt.result === "DENIED" ? "text-destructive" : evt.result === "ESCALATED" ? "text-warning" : "text-success"}`}>{evt.result}</span>
          </motion.div>
        ))}
      </motion.div>
    </div>
  );
}
