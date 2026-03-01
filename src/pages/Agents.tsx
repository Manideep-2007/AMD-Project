import { motion } from "framer-motion";
import { StatusBadge } from "@/components/StatusBadge";
import { Bot, Plus, Cpu, Zap, DollarSign } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";

const agents = [
  { id: "agt_01", name: "CodeReviewer-v3", status: "running" as const, tasks: 47, tokens: 182400, cost: 34.20, budget: 50, tools: ["GitHub"], uptime: "4h 23m" },
  { id: "agt_02", name: "DeployBot-v1", status: "escalated" as const, tasks: 12, tokens: 56000, cost: 12.80, budget: 30, tools: ["Cloud Deploy", "GitHub"], uptime: "2h 10m" },
  { id: "agt_03", name: "TriageAgent-v2", status: "running" as const, tasks: 89, tokens: 312000, cost: 58.90, budget: 100, tools: ["Jira"], uptime: "6h 45m" },
  { id: "agt_04", name: "DBGuard-v1", status: "failed" as const, tasks: 8, tokens: 24000, cost: 4.50, budget: 20, tools: ["Database"], uptime: "0h 45m" },
  { id: "agt_05", name: "SecScanner-v2", status: "healthy" as const, tasks: 156, tokens: 498000, cost: 91.20, budget: 150, tools: ["GitHub", "Cloud Deploy"], uptime: "12h 30m" },
  { id: "agt_06", name: "DocWriter-v1", status: "running" as const, tasks: 23, tokens: 87000, cost: 16.40, budget: 40, tools: ["GitHub"], uptime: "1h 55m" },
];

const fadeUp = { hidden: { opacity: 0, y: 16 }, show: { opacity: 1, y: 0 } };
const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.06 } } };

export default function Agents() {
  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Agents</h1>
          <p className="text-sm text-muted-foreground mt-1">Manage and monitor autonomous agent instances</p>
        </div>
        <Button className="gap-2">
          <Plus className="h-4 w-4" /> Spawn Agent
        </Button>
      </div>

      <motion.div initial="hidden" animate="show" variants={stagger} className="grid gap-4">
        {agents.map((agent) => (
          <motion.div
            key={agent.id}
            variants={fadeUp}
            className="rounded-xl border border-border bg-card p-5 hover:bg-accent/30 transition-colors cursor-pointer"
          >
            <div className="flex flex-col sm:flex-row sm:items-center gap-4">
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 border border-primary/20">
                  <Bot className="h-5 w-5 text-primary" />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold truncate">{agent.name}</h3>
                    <StatusBadge status={agent.status} pulse={agent.status === "running"} />
                  </div>
                  <p className="text-xs text-muted-foreground font-mono">{agent.id} · {agent.uptime} uptime</p>
                </div>
              </div>

              <div className="flex items-center gap-6 text-xs">
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <Cpu className="h-3.5 w-3.5" />
                  <span className="font-mono">{agent.tasks} tasks</span>
                </div>
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <Zap className="h-3.5 w-3.5" />
                  <span className="font-mono">{(agent.tokens / 1000).toFixed(0)}K tokens</span>
                </div>
                <div className="w-32 hidden lg:block">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-muted-foreground flex items-center gap-1"><DollarSign className="h-3 w-3" />{agent.cost.toFixed(2)}</span>
                    <span className="text-muted-foreground">${agent.budget}</span>
                  </div>
                  <Progress value={(agent.cost / agent.budget) * 100} className="h-1.5" />
                </div>
                <div className="flex gap-1 hidden md:flex">
                  {agent.tools.map(t => (
                    <span key={t} className="px-2 py-0.5 rounded bg-muted text-[10px] font-mono text-muted-foreground">{t}</span>
                  ))}
                </div>
              </div>
            </div>
          </motion.div>
        ))}
      </motion.div>
    </div>
  );
}
