import { motion } from "framer-motion";
import { Shield, Plus, Clock, CheckCircle, XCircle, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

const policies = [
  { id: "pol_001", name: "Block production deploys", type: "DENY" as const, tool: "Cloud Deploy", env: "production", version: 3, active: true, evaluations: 1247, lastTriggered: "5m ago" },
  { id: "pol_002", name: "Require approval for schema changes", type: "ESCALATE_TO_HUMAN" as const, tool: "Database Proxy", env: "all", version: 2, active: true, evaluations: 89, lastTriggered: "12m ago" },
  { id: "pol_003", name: "Allow staging deploys", type: "ALLOW" as const, tool: "Cloud Deploy", env: "staging", version: 1, active: true, evaluations: 3421, lastTriggered: "1m ago" },
  { id: "pol_004", name: "Block bulk Jira deletes", type: "DENY" as const, tool: "Jira Proxy", env: "all", version: 5, active: true, evaluations: 234, lastTriggered: "1h ago" },
  { id: "pol_005", name: "Block direct push to main", type: "DENY" as const, tool: "GitHub Proxy", env: "all", version: 1, active: true, evaluations: 567, lastTriggered: "30m ago" },
  { id: "pol_006", name: "Night mode — deny all writes", type: "DENY" as const, tool: "all", env: "production", version: 2, active: false, evaluations: 0, lastTriggered: "—" },
];

const typeIcon = { ALLOW: <CheckCircle className="h-3.5 w-3.5" />, DENY: <XCircle className="h-3.5 w-3.5" />, ESCALATE_TO_HUMAN: <AlertTriangle className="h-3.5 w-3.5" /> };
const typeStyle = { ALLOW: "text-success border-success/30 bg-success/10", DENY: "text-destructive border-destructive/30 bg-destructive/10", ESCALATE_TO_HUMAN: "text-warning border-warning/30 bg-warning/10" };

const fadeUp = { hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0 } };
const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.05 } } };

export default function Policies() {
  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Policies</h1>
          <p className="text-sm text-muted-foreground mt-1">Define rules governing agent behavior. Default-deny posture.</p>
        </div>
        <Button className="gap-2"><Plus className="h-4 w-4" /> New Policy</Button>
      </div>

      <motion.div initial="hidden" animate="show" variants={stagger} className="grid gap-3">
        {policies.map((p) => (
          <motion.div key={p.id} variants={fadeUp} className="rounded-xl border border-border bg-card p-5 hover:bg-accent/30 transition-colors cursor-pointer">
            <div className="flex flex-col sm:flex-row sm:items-center gap-3">
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                  <Shield className="h-4 w-4 text-muted-foreground" />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="text-sm font-semibold">{p.name}</h3>
                    <Badge variant="outline" className={`text-[10px] font-mono gap-1 ${typeStyle[p.type]}`}>
                      {typeIcon[p.type]} {p.type}
                    </Badge>
                    {!p.active && <Badge variant="outline" className="text-[10px] text-muted-foreground">INACTIVE</Badge>}
                  </div>
                  <p className="text-xs text-muted-foreground font-mono mt-0.5">{p.id} · v{p.version} · {p.tool} · {p.env}</p>
                </div>
              </div>
              <div className="flex items-center gap-5 text-xs text-muted-foreground">
                <span className="font-mono">{p.evaluations.toLocaleString()} evals</span>
                <span className="flex items-center gap-1"><Clock className="h-3 w-3" /> {p.lastTriggered}</span>
              </div>
            </div>
          </motion.div>
        ))}
      </motion.div>
    </div>
  );
}
