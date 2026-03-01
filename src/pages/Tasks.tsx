import { motion } from "framer-motion";
import { StatusBadge } from "@/components/StatusBadge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const tasks = [
  { id: "tsk_a1b2", name: "Code review PR #482", agent: "CodeReviewer-v3", status: "running" as const, submitted: "2m ago", duration: "1m 23s", tokens: 12400 },
  { id: "tsk_c3d4", name: "Deploy staging v2.4.1", agent: "DeployBot-v1", status: "escalated" as const, submitted: "5m ago", duration: "3m 10s", tokens: 8200 },
  { id: "tsk_e5f6", name: "Triage PROJ-1847", agent: "TriageAgent-v2", status: "completed" as const, submitted: "8m ago", duration: "45s", tokens: 3100 },
  { id: "tsk_g7h8", name: "Validate migration #29", agent: "DBGuard-v1", status: "failed" as const, submitted: "12m ago", duration: "2m 05s", tokens: 6700 },
  { id: "tsk_i9j0", name: "Scan repo security", agent: "SecScanner-v2", status: "completed" as const, submitted: "15m ago", duration: "4m 30s", tokens: 18900 },
  { id: "tsk_k1l2", name: "Generate API docs", agent: "DocWriter-v1", status: "running" as const, submitted: "1m ago", duration: "0m 42s", tokens: 4200 },
  { id: "tsk_m3n4", name: "Refactor utils module", agent: "CodeReviewer-v3", status: "pending" as const, submitted: "20s ago", duration: "—", tokens: 0 },
  { id: "tsk_o5p6", name: "Update JIRA board", agent: "TriageAgent-v2", status: "queued" as const, submitted: "30s ago", duration: "—", tokens: 0 },
];

const fadeUp = { hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0 } };
const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.04 } } };

export default function Tasks() {
  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Tasks</h1>
        <p className="text-sm text-muted-foreground mt-1">Task queue and execution trace</p>
      </div>

      <Tabs defaultValue="all">
        <TabsList className="bg-muted">
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="running">Running</TabsTrigger>
          <TabsTrigger value="escalated">Escalated</TabsTrigger>
          <TabsTrigger value="failed">Failed</TabsTrigger>
        </TabsList>

        <TabsContent value="all" className="mt-4">
          <motion.div initial="hidden" animate="show" variants={stagger} className="rounded-xl border border-border bg-card overflow-hidden">
            <div className="grid grid-cols-[80px_1fr_140px_90px_80px_70px_80px] gap-2 px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground border-b border-border hidden lg:grid">
              <span>ID</span><span>Task</span><span>Agent</span><span>Status</span><span>Duration</span><span>Tokens</span><span>Submitted</span>
            </div>
            {tasks.map((task) => (
              <motion.div
                key={task.id}
                variants={fadeUp}
                className="grid grid-cols-1 lg:grid-cols-[80px_1fr_140px_90px_80px_70px_80px] gap-2 px-4 py-3 items-center hover:bg-accent/40 transition-colors cursor-pointer border-b border-border last:border-0"
              >
                <span className="text-xs font-mono text-muted-foreground">{task.id}</span>
                <span className="text-sm font-medium">{task.name}</span>
                <span className="text-xs text-muted-foreground">{task.agent}</span>
                <StatusBadge status={task.status} />
                <span className="text-xs font-mono text-muted-foreground">{task.duration}</span>
                <span className="text-xs font-mono text-muted-foreground">{task.tokens > 0 ? `${(task.tokens / 1000).toFixed(1)}K` : "—"}</span>
                <span className="text-[11px] text-muted-foreground">{task.submitted}</span>
              </motion.div>
            ))}
          </motion.div>
        </TabsContent>
        <TabsContent value="running"><p className="text-sm text-muted-foreground p-4">Filtered view — running tasks only</p></TabsContent>
        <TabsContent value="escalated"><p className="text-sm text-muted-foreground p-4">Filtered view — escalated tasks requiring human approval</p></TabsContent>
        <TabsContent value="failed"><p className="text-sm text-muted-foreground p-4">Filtered view — failed tasks</p></TabsContent>
      </Tabs>
    </div>
  );
}
