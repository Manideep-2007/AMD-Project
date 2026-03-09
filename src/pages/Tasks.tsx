import { useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { StatusBadge } from "@/components/StatusBadge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Loader2, RefreshCw, AlertCircle, ListTodo, ChevronDown,
  MessageSquare, Brain, BookOpen, ShieldCheck, Play, Lock, CheckCircle2
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTasks, useTask } from "@/hooks/use-api";

const fadeUp = { hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0 } };
const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.04 } } };

// ─── ComplianceArtifact Timeline ─────────────────────────────────────────────

interface TimelineSection {
  id: string;
  icon: React.ReactNode;
  label: string;
  statusColor: string;
  content: React.ReactNode;
}

function ComplianceTimeline({ taskId }: { taskId: string }) {
  const { data, isLoading } = useTask(taskId);
  const [openSection, setOpenSection] = useState<string | null>("intent");
  const task = data?.data ?? data ?? {};

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  function toggle(id: string) {
    setOpenSection((prev) => (prev === id ? null : id));
  }

  const reasoning: string[] = Array.isArray(task.reasoningChain)
    ? task.reasoningChain
    : typeof task.reasoningChain === "string"
    ? task.reasoningChain.split("\n").filter(Boolean)
    : [];

  const policyResults: any[] = Array.isArray(task.policyResults)
    ? task.policyResults
    : [];

  const toolCalls: any[] = Array.isArray(task.toolCalls)
    ? task.toolCalls
    : [];

  const sections: TimelineSection[] = [
    {
      id: "intent",
      icon: <MessageSquare className="h-4 w-4" />,
      label: "User Intent",
      statusColor: "text-primary",
      content: (
        <div className="bg-muted/40 rounded-md p-3 text-sm font-mono whitespace-pre-wrap">
          {task.userPrompt ?? task.description ?? task.input ?? "No user intent recorded."}
        </div>
      ),
    },
    {
      id: "reasoning",
      icon: <Brain className="h-4 w-4" />,
      label: "Reasoning Chain",
      statusColor: "text-purple-400",
      content: reasoning.length > 0 ? (
        <ol className="space-y-2">
          {reasoning.map((step: string, i: number) => (
            <li key={i} className="flex gap-3 text-sm">
              <span className="shrink-0 flex h-5 w-5 items-center justify-center rounded-full bg-purple-500/20 text-purple-400 text-[10px] font-bold mt-0.5">
                {i + 1}
              </span>
              <span className="text-foreground/90">{step}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-sm text-muted-foreground italic">
          No reasoning chain captured — enable chain-of-thought in agent settings.
        </p>
      ),
    },
    {
      id: "context",
      icon: <BookOpen className="h-4 w-4" />,
      label: "Context",
      statusColor: "text-sky-400",
      content: (
        <div className="space-y-2">
          {task.contextSources?.length > 0 ? (
            (task.contextSources as any[]).map((src: any, i: number) => (
              <div key={i} className="rounded-md border border-border bg-background p-2.5 text-xs">
                <p className="font-medium text-foreground mb-1">{src.source ?? `Source ${i + 1}`}</p>
                <p className="text-muted-foreground line-clamp-3">{src.content ?? JSON.stringify(src)}</p>
              </div>
            ))
          ) : (
            <p className="text-sm text-muted-foreground italic">No retrieval context attached to this task.</p>
          )}
        </div>
      ),
    },
    {
      id: "policy",
      icon: <ShieldCheck className="h-4 w-4" />,
      label: "Policy Evaluation",
      statusColor: policyResults.some((r: any) => r.action === "BLOCK") ? "text-destructive" : "text-success",
      content: policyResults.length > 0 ? (
        <div className="space-y-2">
          {policyResults.map((r: any, i: number) => (
            <div key={i} className={`rounded-md border p-2.5 text-xs flex items-start justify-between gap-3 ${
              r.action === "BLOCK" ? "border-destructive/30 bg-destructive/5"
              : r.action === "ESCALATE_TO_HUMAN" ? "border-warning/30 bg-warning/5"
              : "border-success/30 bg-success/5"
            }`}>
              <div>
                <p className="font-medium text-foreground">{r.policyName ?? r.rule ?? `Policy ${i + 1}`}</p>
                {r.reason && <p className="text-muted-foreground mt-0.5">{r.reason}</p>}
              </div>
              <span className={`shrink-0 font-mono text-[10px] px-1.5 py-0.5 rounded font-bold ${
                r.action === "BLOCK" ? "bg-destructive/20 text-destructive"
                : r.action === "ESCALATE_TO_HUMAN" ? "bg-warning/20 text-warning"
                : "bg-success/20 text-success"
              }`}>{r.action ?? "ALLOW"}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground italic">No policy evaluation data recorded.</p>
      ),
    },
    {
      id: "execution",
      icon: <Play className="h-4 w-4" />,
      label: "Execution",
      statusColor: "text-orange-400",
      content: toolCalls.length > 0 ? (
        <div className="space-y-2">
          {toolCalls.map((call: any, i: number) => (
            <div key={i} className="rounded-md border border-border bg-background text-xs overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-muted/30">
                <span className="font-mono font-bold text-foreground">{call.toolType ?? call.tool}.{call.method ?? ""}</span>
                {call.durationMs && <span className="text-muted-foreground">{call.durationMs}ms</span>}
                {call.status && (
                  <span className={`ml-auto font-mono text-[10px] ${call.status === "success" ? "text-success" : "text-destructive"}`}>
                    {call.status.toUpperCase()}
                  </span>
                )}
              </div>
              {call.params && (
                <pre className="px-3 py-2 text-muted-foreground overflow-x-auto max-h-[120px]">
                  {JSON.stringify(call.params, null, 2)}
                </pre>
              )}
              {call.result && (
                <div className="px-3 py-2 border-t border-border">
                  <p className="text-[10px] text-muted-foreground mb-1 uppercase tracking-wider">Result</p>
                  <pre className="text-foreground overflow-x-auto max-h-[80px]">
                    {typeof call.result === "string" ? call.result : JSON.stringify(call.result, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground italic">No execution trace available for this task.</p>
      ),
    },
    {
      id: "integrity",
      icon: <Lock className="h-4 w-4" />,
      label: "Integrity Seal",
      statusColor: task.chainHash ? "text-success" : "text-muted-foreground",
      content: (
        <div className="space-y-3">
          {task.chainHash ? (
            <>
              <div className="flex items-center gap-2 text-success text-sm">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                <span className="font-medium">Chain integrity verified</span>
              </div>
              <div>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Chain Hash (SHA-256)</p>
                <p className="font-mono text-xs bg-muted rounded-md px-3 py-2 break-all text-foreground">
                  {task.chainHash}
                </p>
              </div>
              {task.previousHash && (
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Previous Hash</p>
                  <p className="font-mono text-xs bg-muted rounded-md px-3 py-2 break-all text-muted-foreground">
                    {task.previousHash}
                  </p>
                </div>
              )}
              {task.chainSeq != null && (
                <p className="text-xs text-muted-foreground">Sequence #{task.chainSeq}</p>
              )}
            </>
          ) : (
            <p className="text-sm text-muted-foreground italic">
              No integrity seal — audit log may not be tamper-evident for this task.
            </p>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="border-t border-border bg-muted/20 px-4 py-3">
      <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium mb-3 px-1">
        Compliance Artifact
      </p>
      <div className="space-y-1">
        {sections.map((section, idx) => (
          <div key={section.id} className="rounded-lg border border-border bg-card overflow-hidden">
            <button
              type="button"
              onClick={() => toggle(section.id)}
              className="w-full flex items-center gap-3 px-4 py-3 hover:bg-accent/30 transition-colors text-left"
            >
              <span className="flex items-center gap-2 flex-1 min-w-0">
                <span className={`${section.statusColor}`}>{section.icon}</span>
                <span className="text-xs font-semibold text-foreground">
                  <span className="text-[10px] text-muted-foreground font-normal mr-2">{idx + 1}.</span>
                  {section.label}
                </span>
              </span>
              <ChevronDown
                className={`h-3.5 w-3.5 text-muted-foreground transition-transform shrink-0 ${
                  openSection === section.id ? "rotate-180" : ""
                }`}
              />
            </button>
            <AnimatePresence initial={false}>
              {openSection === section.id && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="overflow-hidden"
                >
                  <div className="px-4 pb-4">{section.content}</div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Task Table ───────────────────────────────────────────────────────────────

function TaskTable({ tasks }: { tasks: any[] }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <motion.div initial="hidden" animate="show" variants={stagger} className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="grid-cols-[80px_1fr_140px_90px_80px_70px_80px] gap-2 px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground border-b border-border hidden lg:grid">
        <span>ID</span><span>Task</span><span>Agent</span><span>Status</span><span>Duration</span><span>Tokens</span><span>Submitted</span>
      </div>
      {tasks.length === 0 && (
        <div className="px-4 py-8 text-center text-sm text-muted-foreground">No tasks match this filter</div>
      )}
      {tasks.map((task) => {
        const tokens = task.tokens ?? (task.inputTokens || 0) + (task.outputTokens || 0);
        const submitted = task.submitted ?? (task.createdAt ? new Date(task.createdAt).toLocaleTimeString() : "—");
        const duration = task.duration ?? (task.durationMs ? `${(task.durationMs / 1000).toFixed(1)}s` : "—");
        const isExpanded = expandedId === task.id;
        return (
          <motion.div key={task.id} variants={fadeUp} className="border-b border-border last:border-0">
            <div
              className={`grid grid-cols-1 lg:grid-cols-[80px_1fr_140px_90px_80px_70px_80px] gap-2 px-4 py-3 items-center cursor-pointer transition-colors ${
                isExpanded ? "bg-accent/40" : "hover:bg-accent/30"
              }`}
              onClick={() => setExpandedId(isExpanded ? null : task.id)}
            >
              <span className="text-xs font-mono text-muted-foreground">{(task.id || "").slice(0, 12)}</span>
              <span className="text-sm font-medium flex items-center gap-2">
                {task.name || task.description || "Untitled task"}
                <ChevronDown className={`h-3.5 w-3.5 text-muted-foreground/50 transition-transform shrink-0 ${isExpanded ? "rotate-180" : ""}`} />
              </span>
              <span className="text-xs text-muted-foreground">{task.agent || task.agentName || "—"}</span>
              <StatusBadge status={(task.status || "unknown").toLowerCase()} />
              <span className="text-xs font-mono text-muted-foreground">{duration}</span>
              <span className="text-xs font-mono text-muted-foreground">{tokens > 0 ? `${(tokens / 1000).toFixed(1)}K` : "—"}</span>
              <span className="text-[11px] text-muted-foreground">{submitted}</span>
            </div>
            <AnimatePresence initial={false}>
              {isExpanded && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="overflow-hidden"
                >
                  <ComplianceTimeline taskId={task.id} />
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        );
      })}
    </motion.div>
  );
}

export default function Tasks() {
  const [tab, setTab] = useState("all");
  const { data: tasksData, isLoading, isError, refetch } = useTasks();
  const allTasks = (tasksData?.data?.items || tasksData?.data || []) as any[];

  const filtered = useMemo(() => {
    if (tab === "all") return allTasks;
    return allTasks.filter((t) => (t.status || "").toLowerCase() === tab);
  }, [allTasks, tab]);

  const counts = useMemo(() => ({
    all: allTasks.length,
    running: allTasks.filter((t) => (t.status || "").toLowerCase() === "running").length,
    escalated: allTasks.filter((t) => (t.status || "").toLowerCase() === "escalated").length,
    failed: allTasks.filter((t) => (t.status || "").toLowerCase() === "failed").length,
  }), [allTasks]);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Tasks</h1>
          <p className="text-sm text-muted-foreground mt-1">Task queue and execution trace</p>
        </div>
        <Button variant="outline" size="sm" className="gap-2" onClick={() => refetch()}>
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </Button>
      </div>

      {isError && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" /> Failed to load tasks. Check API connection.
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : allTasks.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
          <ListTodo className="h-10 w-10 mb-3 opacity-40" />
          <p className="text-sm font-medium">No tasks yet</p>
          <p className="text-xs mt-1">Tasks will appear here when agents start executing work.</p>
        </div>
      ) : (
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="bg-muted">
            <TabsTrigger value="all">All ({counts.all})</TabsTrigger>
            <TabsTrigger value="running">Running ({counts.running})</TabsTrigger>
            <TabsTrigger value="escalated">Escalated ({counts.escalated})</TabsTrigger>
            <TabsTrigger value="failed">Failed ({counts.failed})</TabsTrigger>
          </TabsList>

          <TabsContent value={tab} className="mt-4">
            <TaskTable tasks={filtered} />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
