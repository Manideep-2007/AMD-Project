import { motion } from "framer-motion";
import { MetricCard } from "@/components/MetricCard";
import { StatusBadge } from "@/components/StatusBadge";
import { Bot, DollarSign, ShieldAlert, Activity, ArrowRight } from "lucide-react";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { Link } from "react-router-dom";

const costData = Array.from({ length: 24 }, (_, i) => ({
  hour: `${i}:00`,
  cost: Math.round(Math.random() * 40 + 10),
  tokens: Math.round(Math.random() * 50000 + 10000),
}));

const recentTasks = [
  { id: "tsk_01", name: "Code Review — PR #482", agent: "CodeReviewer-v3", status: "running" as const, time: "2m ago" },
  { id: "tsk_02", name: "Deploy staging build", agent: "DeployBot-v1", status: "escalated" as const, time: "5m ago" },
  { id: "tsk_03", name: "Jira ticket triage", agent: "TriageAgent-v2", status: "completed" as const, time: "8m ago" },
  { id: "tsk_04", name: "DB migration validation", agent: "DBGuard-v1", status: "failed" as const, time: "12m ago" },
  { id: "tsk_05", name: "Security scan — repo X", agent: "SecScanner-v2", status: "completed" as const, time: "15m ago" },
];

const violations = [
  { rule: "DENY: Production write", agent: "DeployBot-v1", tool: "Cloud Deploy", time: "5m ago" },
  { rule: "ESCALATE: Schema change", agent: "DBGuard-v1", tool: "Database Proxy", time: "12m ago" },
  { rule: "DENY: Bulk delete", agent: "CleanupBot-v1", tool: "Jira Proxy", time: "1h ago" },
];

const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.08 } } };
const fadeUp = { hidden: { opacity: 0, y: 16 }, show: { opacity: 1, y: 0, transition: { duration: 0.4 } } };

export default function Dashboard() {
  return (
    <div className="p-6 space-y-6 gradient-mesh min-h-full">
      <motion.div initial="hidden" animate="show" variants={stagger}>
        <motion.div variants={fadeUp} className="mb-6">
          <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground mt-1">Real-time overview of your AI agent operations</p>
        </motion.div>

        <motion.div variants={fadeUp} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <MetricCard label="Active Agents" value={12} icon={<Bot className="h-4 w-4" />} variant="primary" change={8} />
          <MetricCard label="Cost Today" value={247.50} prefix="$" decimals={2} icon={<DollarSign className="h-4 w-4" />} variant="warning" change={-3} />
          <MetricCard label="Policy Violations" value={7} icon={<ShieldAlert className="h-4 w-4" />} variant="destructive" change={12} />
          <MetricCard label="Tasks / Hour" value={184} icon={<Activity className="h-4 w-4" />} variant="success" change={15} />
        </motion.div>
      </motion.div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Cost Chart */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="lg:col-span-2 rounded-xl border border-border bg-card p-5"
        >
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-sm font-semibold">Cost & Token Usage</h2>
              <p className="text-xs text-muted-foreground">Last 24 hours</p>
            </div>
            <div className="flex gap-4 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-primary" /> Cost ($)</span>
              <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-success" /> Tokens (K)</span>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={costData}>
              <defs>
                <linearGradient id="gradCost" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="hsl(217,91%,60%)" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="hsl(217,91%,60%)" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="gradTokens" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="hsl(160,84%,39%)" stopOpacity={0.2} />
                  <stop offset="100%" stopColor="hsl(160,84%,39%)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="hour" tick={{ fontSize: 10, fill: "hsl(220,10%,50%)" }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: "hsl(220,10%,50%)" }} axisLine={false} tickLine={false} />
              <Tooltip
                contentStyle={{
                  backgroundColor: "hsl(230,14%,8%)",
                  border: "1px solid hsl(230,10%,16%)",
                  borderRadius: 8,
                  fontSize: 12,
                }}
              />
              <Area type="monotone" dataKey="cost" stroke="hsl(217,91%,60%)" fill="url(#gradCost)" strokeWidth={2} />
              <Area type="monotone" dataKey="tokens" stroke="hsl(160,84%,39%)" fill="url(#gradTokens)" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </motion.div>

        {/* Violations */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4 }}
          className="rounded-xl border border-border bg-card p-5"
        >
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold">Recent Violations</h2>
            <Link to="/audit" className="text-xs text-primary hover:underline flex items-center gap-1">View all <ArrowRight className="h-3 w-3" /></Link>
          </div>
          <div className="space-y-3">
            {violations.map((v, i) => (
              <div key={i} className="p-3 rounded-lg bg-muted/50 border border-border space-y-1">
                <p className="text-xs font-medium text-foreground">{v.rule}</p>
                <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                  <span>{v.agent} → {v.tool}</span>
                  <span>{v.time}</span>
                </div>
              </div>
            ))}
          </div>
        </motion.div>
      </div>

      {/* Recent Tasks */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.5 }}
        className="rounded-xl border border-border bg-card"
      >
        <div className="flex items-center justify-between p-5 pb-0">
          <h2 className="text-sm font-semibold">Recent Tasks</h2>
          <Link to="/tasks" className="text-xs text-primary hover:underline flex items-center gap-1">View all <ArrowRight className="h-3 w-3" /></Link>
        </div>
        <div className="p-2">
          {recentTasks.map((task) => (
            <div key={task.id} className="flex items-center gap-4 px-3 py-2.5 rounded-lg hover:bg-accent/50 transition-colors cursor-pointer">
              <span className="text-xs font-mono text-muted-foreground w-16">{task.id}</span>
              <span className="text-sm flex-1">{task.name}</span>
              <span className="text-xs text-muted-foreground hidden sm:block">{task.agent}</span>
              <StatusBadge status={task.status} />
              <span className="text-[11px] text-muted-foreground w-14 text-right">{task.time}</span>
            </div>
          ))}
        </div>
      </motion.div>
    </div>
  );
}
