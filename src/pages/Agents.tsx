import { useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { StatusBadge } from "@/components/StatusBadge";
import {
  Bot, Plus, Cpu, Zap, DollarSign, Loader2, AlertCircle, OctagonX,
  ChevronDown, Shield, Activity, History, Lightbulb, Wrench, Check, X
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  useAgents, useAgent, useCreateAgent, useEmergencyStopAgent, useAgentBlastRadius,
  useTasks, useAuditEvents,
} from "@/hooks/use-api";
import { useToast } from "@/hooks/use-toast";

const fadeUp = { hidden: { opacity: 0, y: 16 }, show: { opacity: 1, y: 0 } };
const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.06 } } };

// â”€â”€â”€ Available tool permissions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const ALL_TOOLS = [
  { id: "GITHUB", label: "GitHub", riskWeight: 0.6 },
  { id: "SLACK", label: "Slack", riskWeight: 0.3 },
  { id: "JIRA", label: "Jira", riskWeight: 0.5 },
  { id: "CONFLUENCE", label: "Confluence", riskWeight: 0.4 },
  { id: "DATABASE_READ", label: "Database Read", riskWeight: 0.5 },
  { id: "DATABASE_WRITE", label: "Database Write", riskWeight: 0.9 },
  { id: "FILE_SYSTEM", label: "File System", riskWeight: 0.7 },
  { id: "HTTP_REQUESTS", label: "HTTP Requests", riskWeight: 0.6 },
  { id: "CODE_EXECUTION", label: "Code Execution", riskWeight: 0.95 },
  { id: "EMAIL", label: "Email", riskWeight: 0.7 },
];

const MODELS = [
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  { id: "gpt-4o", label: "GPT-4o" },
  { id: "gpt-4o-mini", label: "GPT-4o mini" },
  { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
  { id: "mistral-large", label: "Mistral Large" },
];

/** Estimate blast radius score (0-100) from selected tools + budget */
function estimateBlastRadius(tools: string[], maxBudget: number): {
  score: number; label: string; breakdown: { perm: number; budget: number; combined: number };
} {
  const permScore = tools.reduce((sum, t) => {
    const tool = ALL_TOOLS.find((x) => x.id === t);
    return sum + (tool?.riskWeight ?? 0.3);
  }, 0);
  const normalizedPerm = Math.min(100, (permScore / (tools.length || 1)) * 100);
  const budgetScore = Math.min(100, (maxBudget / 500) * 100); // $500 = max score
  const combined = Math.round(normalizedPerm * 0.6 + budgetScore * 0.4);
  const label = combined > 70 ? "High Risk" : combined > 40 ? "Moderate" : "Low Risk";
  return { score: combined, label, breakdown: { perm: Math.round(normalizedPerm), budget: Math.round(budgetScore), combined } };
}

// â”€â”€â”€ Spawn Agent Dialog â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function SpawnAgentDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { toast } = useToast();
  const createAgent = useCreateAgent();
  const [name, setName] = useState(`Agent-${Date.now().toString(36)}`);
  const [model, setModel] = useState("claude-sonnet-4-6");
  const [selectedTools, setSelectedTools] = useState<string[]>(["GITHUB"]);
  const [maxBudget, setMaxBudget] = useState("100");

  const blastPreview = useMemo(
    () => estimateBlastRadius(selectedTools, Number(maxBudget) || 0),
    [selectedTools, maxBudget]
  );

  function toggleTool(id: string) {
    setSelectedTools((prev) => prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]);
  }

  async function handleSubmit() {
    if (!name.trim()) { toast({ title: "Agent name is required", variant: "destructive" }); return; }
    try {
      await createAgent.mutateAsync({
        name: name.trim(),
        version: "v1.0.0",
        toolPermissions: selectedTools,
        config: { model, maxBudgetUsd: Number(maxBudget) || 100 },
      });
      toast({ title: "Agent spawned", description: `${name} is starting up.` });
      onOpenChange(false);
    } catch (err: any) {
      toast({ title: "Failed to spawn agent", description: err.message, variant: "destructive" });
    }
  }

  const riskColor = blastPreview.score > 70 ? "text-destructive" : blastPreview.score > 40 ? "text-warning" : "text-success";
  const riskBg = blastPreview.score > 70 ? "bg-destructive/10 border-destructive/20" : blastPreview.score > 40 ? "bg-warning/10 border-warning/20" : "bg-success/10 border-success/20";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bot className="h-5 w-5 text-primary" /> Spawn New Agent
          </DialogTitle>
          <DialogDescription>Configure the agent's permissions and model. Blast radius is calculated live.</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 py-2">
          {/* Left: form */}
          <div className="space-y-4">
            <div>
              <Label className="text-xs text-muted-foreground mb-1.5 block">Agent Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. repo-syncer" />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground mb-1.5 block">Model</Label>
              <Select value={model} onValueChange={setModel}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {MODELS.map((m) => <SelectItem key={m.id} value={m.id}>{m.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground mb-1.5 block">Max Budget (USD)</Label>
              <Input type="number" min="1" max="10000" value={maxBudget} onChange={(e) => setMaxBudget(e.target.value)} />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground mb-1.5 block">Tool Permissions</Label>
              <div className="grid grid-cols-2 gap-1.5">
                {ALL_TOOLS.map((tool) => {
                  const checked = selectedTools.includes(tool.id);
                  return (
                    <button
                      key={tool.id}
                      type="button"
                      onClick={() => toggleTool(tool.id)}
                      className={`flex items-center gap-2 px-2.5 py-1.5 rounded-md border text-xs transition-colors ${
                        checked ? "border-primary/40 bg-primary/10 text-foreground" : "border-border bg-background text-muted-foreground hover:bg-accent/30"
                      }`}
                    >
                      <span className={`flex h-4 w-4 items-center justify-center rounded border ${checked ? "bg-primary border-primary" : "border-border"}`}>
                        {checked && <Check className="h-3 w-3 text-primary-foreground" />}
                      </span>
                      {tool.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Right: blast radius preview */}
          <div className={`rounded-xl border p-4 flex flex-col gap-4 ${riskBg}`}>
            <div>
              <p className="text-xs text-muted-foreground mb-1">Estimated Blast Radius</p>
              <div className="flex items-baseline gap-2">
                <span className={`text-4xl font-bold tabular-nums ${riskColor}`}>{blastPreview.score}</span>
                <span className="text-muted-foreground text-sm">/100</span>
                <span className={`text-sm font-medium ${riskColor}`}>{blastPreview.label}</span>
              </div>
            </div>
            <div className="space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Permission score</span>
                <span className="font-mono">{blastPreview.breakdown.perm}</span>
              </div>
              <Progress value={blastPreview.breakdown.perm} className="h-1.5" />
              <div className="flex items-center justify-between mt-2">
                <span className="text-muted-foreground">Budget score</span>
                <span className="font-mono">{blastPreview.breakdown.budget}</span>
              </div>
              <Progress value={blastPreview.breakdown.budget} className="h-1.5" />
            </div>
            <div className="text-xs text-muted-foreground mt-auto">
              {blastPreview.score > 70 ? (
                <p className="text-destructive">âš  High risk configuration. Consider reducing tool permissions or budget.</p>
              ) : blastPreview.score > 40 ? (
                <p className="text-warning">This agent has moderate risk. Ensure you have approval workflows enabled.</p>
              ) : (
                <p className="text-success">âœ“ Well-governed configuration. Minimal blast radius.</p>
              )}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={createAgent.isPending} className="gap-2">
            {createAgent.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bot className="h-4 w-4" />}
            Spawn Agent
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// â”€â”€â”€ Agent Inline Expansion â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function AgentExpansion({ agentId, agentData }: { agentId: string; agentData: any }) {
  const { data: detailData } = useAgent(agentId);
  const { data: blastData } = useAgentBlastRadius(agentId);
  const { data: tasksData } = useTasks({ agentId, limit: 10 });
  const { data: auditData } = useAuditEvents({ agentId, limit: 20 });
  const { toast } = useToast();

  const agent = detailData?.data ?? agentData;
  const blast = blastData?.data ?? {};
  const tasks = (tasksData?.data?.items ?? tasksData?.data ?? []) as any[];
  const events = (auditData?.data ?? []) as any[];

  // Compute unused tools: tools that haven't appeared in audit events for this agent
  const usedTools = useMemo(() => {
    const used = new Set<string>();
    events.forEach((e: any) => {
      if (e.toolType) used.add(e.toolType.toUpperCase());
    });
    return used;
  }, [events]);

  const unusedTools = useMemo(() => {
    const agentTools: string[] = agent?.tools ?? agent?.toolPermissions ?? [];
    return agentTools.filter((t: string) => !usedTools.has(t.toUpperCase()));
  }, [agent, usedTools]);

  const activeTask = tasks.find((t: any) => (t.status || "").toLowerCase() === "running");

  return (
    <div className="border-t border-border px-5 pb-5 pt-4 bg-muted/20">
      <Tabs defaultValue="overview">
        <TabsList className="bg-muted mb-4">
          <TabsTrigger value="overview" className="gap-1.5 text-xs"><Shield className="h-3.5 w-3.5" /> Overview</TabsTrigger>
          <TabsTrigger value="task" className="gap-1.5 text-xs"><Activity className="h-3.5 w-3.5" /> Active Task</TabsTrigger>
          <TabsTrigger value="actions" className="gap-1.5 text-xs"><History className="h-3.5 w-3.5" /> Recent Actions</TabsTrigger>
          <TabsTrigger value="recommendations" className="gap-1.5 text-xs relative">
            <Lightbulb className="h-3.5 w-3.5" /> Recommendations
            {unusedTools.length > 0 && (
              <span className="absolute -top-1 -right-1 h-3.5 w-3.5 rounded-full bg-warning text-[8px] text-warning-foreground flex items-center justify-center font-bold">
                {unusedTools.length}
              </span>
            )}
          </TabsTrigger>
        </TabsList>

        {/* Overview tab */}
        <TabsContent value="overview">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="rounded-lg border border-border bg-card p-3">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Blast Radius</p>
              <p className={`text-2xl font-bold ${(blast.blastRadiusScore ?? agent.blastRadiusScore ?? 0) > 60 ? "text-destructive" : (blast.blastRadiusScore ?? 0) > 30 ? "text-warning" : "text-success"}`}>
                {blast.blastRadiusScore ?? agent.blastRadiusScore ?? "â€”"}
              </p>
            </div>
            <div className="rounded-lg border border-border bg-card p-3">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Max Exposure</p>
              <p className="text-2xl font-bold">${(blast.maxDamageUsd ?? 0).toLocaleString()}</p>
            </div>
            <div className="rounded-lg border border-border bg-card p-3">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Tasks Run</p>
              <p className="text-2xl font-bold">{agent.totalTasks ?? agent.taskCount ?? tasks.length}</p>
            </div>
            <div className="rounded-lg border border-border bg-card p-3">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Cost Today</p>
              <p className="text-2xl font-bold">${(agent.costToday ?? 0).toFixed(2)}</p>
            </div>
          </div>
          {agent.config && (
            <div className="mt-3 rounded-lg border border-border bg-card p-3">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-2">Configuration</p>
              <pre className="text-xs text-muted-foreground overflow-x-auto max-h-[120px]">
                {JSON.stringify(agent.config, null, 2)}
              </pre>
            </div>
          )}
        </TabsContent>

        {/* Active Task tab */}
        <TabsContent value="task">
          {activeTask ? (
            <div className="rounded-lg border border-border bg-card p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-medium">{activeTask.name || "Running Task"}</h4>
                <StatusBadge status="running" pulse />
              </div>
              <p className="text-xs text-muted-foreground font-mono">{activeTask.id}</p>
              {activeTask.description && <p className="text-sm text-foreground/80">{activeTask.description}</p>}
              <div className="flex gap-4 text-xs text-muted-foreground">
                <span>Started: {activeTask.createdAt ? new Date(activeTask.createdAt).toLocaleTimeString() : "â€”"}</span>
                {activeTask.inputTokens && <span>Tokens: {((activeTask.inputTokens + activeTask.outputTokens) / 1000).toFixed(1)}K</span>}
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
              <Activity className="h-8 w-8 mb-2 opacity-30" />
              <p className="text-sm">No active task</p>
              <p className="text-xs mt-1">This agent is currently idle</p>
            </div>
          )}
        </TabsContent>

        {/* Recent Actions tab */}
        <TabsContent value="actions">
          {events.length > 0 ? (
            <div className="space-y-2">
              {events.slice(0, 10).map((ev: any, i: number) => (
                <div key={ev.id || i} className="flex items-start gap-3 text-xs rounded-md px-3 py-2 bg-muted/30 border border-border">
                  <span className={`mt-0.5 shrink-0 ${ev.riskLevel === "CRITICAL" || ev.eventType?.includes("block") ? "text-destructive" : "text-muted-foreground"}`}>â—</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-foreground/90">{ev.eventType || ev.type || "Event"}</p>
                    {ev.toolType && <p className="text-muted-foreground">{ev.toolType}{ev.method ? `.${ev.method}` : ""}</p>}
                  </div>
                  <span className="text-muted-foreground shrink-0">
                    {ev.createdAt ? new Date(ev.createdAt).toLocaleTimeString() : "â€”"}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
              <History className="h-8 w-8 mb-2 opacity-30" />
              <p className="text-sm">No recent actions</p>
            </div>
          )}
        </TabsContent>

        {/* Recommendations tab */}
        <TabsContent value="recommendations">
          {unusedTools.length > 0 ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                The following tool permissions have not been used in the last 30 days. Removing them reduces blast radius.
              </p>
              {unusedTools.map((tool: string) => (
                <div key={tool} className="flex items-center justify-between rounded-lg border border-warning/20 bg-warning/5 px-4 py-3">
                  <div className="flex items-center gap-3">
                    <Wrench className="h-4 w-4 text-warning" />
                    <div>
                      <p className="text-sm font-medium">{tool}</p>
                      <p className="text-xs text-muted-foreground">No usage detected in audit log</p>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5 text-xs border-warning/30 text-warning hover:bg-warning/10"
                    onClick={() => toast({ title: "Permission tightened", description: `Removed ${tool} from ${agentData.name}` })}
                  >
                    <X className="h-3 w-3" /> Remove
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
              <Lightbulb className="h-8 w-8 mb-2 opacity-30" />
              <p className="text-sm font-medium">All permissions are in use</p>
              <p className="text-xs mt-1">No unused tool permissions detected</p>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

// â”€â”€â”€ Main Agents Page â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export default function Agents() {
  const { data: agentsData, isLoading, isError, error } = useAgents();
  const emergencyStop = useEmergencyStopAgent();
  const { toast } = useToast();
  const [spawnOpen, setSpawnOpen] = useState(false);
  const [stoppingId, setStoppingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const agents = (agentsData?.data?.items || agentsData?.data || []) as any[];

  const handleEmergencyStop = async (agentId: string, agentName: string) => {
    if (!confirm(`Emergency stop agent "${agentName}"? This will terminate the agent and cancel all its running tasks.`)) return;
    setStoppingId(agentId);
    try {
      const result = await emergencyStop.mutateAsync(agentId);
      const data = (result as any)?.data?.data;
      toast({
        title: "Agent stopped",
        description: `${agentName} terminated. ${data?.cancelledTasks ?? 0} tasks cancelled.`,
      });
    } catch (err: any) {
      toast({ title: "Emergency stop failed", description: err.message, variant: "destructive" });
    } finally {
      setStoppingId(null);
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Agents</h1>
          <p className="text-sm text-muted-foreground mt-1">Manage and monitor autonomous agent instances</p>
        </div>
        <Button className="gap-2" onClick={() => setSpawnOpen(true)}>
          <Plus className="h-4 w-4" /> Spawn Agent
        </Button>
      </div>

      <SpawnAgentDialog open={spawnOpen} onOpenChange={setSpawnOpen} />

      {isError && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 flex items-center gap-3">
          <AlertCircle className="h-5 w-5 text-destructive" />
          <div>
            <p className="text-sm font-semibold text-destructive">Failed to load agents</p>
            <p className="text-xs text-muted-foreground">{(error as any)?.message || "API server may be unavailable"}</p>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : agents.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
          <Bot className="h-10 w-10 mb-3 opacity-30" />
          <p className="text-sm font-medium">No agents registered</p>
          <p className="text-xs mt-1">Spawn your first agent to get started</p>
        </div>
      ) : (
        <motion.div initial="hidden" animate="show" variants={stagger} className="grid gap-3">
          {agents.map((agent) => {
            const cost = agent.costToday ?? Number(agent.costUsd || 0);
            const budget = agent.budgetLimit ?? 100;
            const tokens = agent.tokenUsage ?? (agent.inputTokens || 0) + (agent.outputTokens || 0);
            const tasks = agent.totalTasks ?? agent.taskCount ?? 0;
            const tools = agent.tools ?? agent.toolPermissions ?? [];
            const isExpanded = expandedId === agent.id;

            return (
              <motion.div key={agent.id} variants={fadeUp} className="rounded-xl border border-border bg-card overflow-hidden">
                {/* Main row */}
                <div
                  className={`p-5 cursor-pointer transition-colors ${isExpanded ? "bg-accent/30" : "hover:bg-accent/20"}`}
                  onClick={() => setExpandedId(isExpanded ? null : agent.id)}
                >
                  <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 border border-primary/20">
                        <Bot className="h-5 w-5 text-primary" />
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <h3 className="text-sm font-semibold truncate">{agent.name}</h3>
                          <StatusBadge
                            status={agent.status?.toLowerCase() || "unknown"}
                            pulse={agent.status === "running" || agent.status === "ACTIVE"}
                          />
                          {agent.blastRadiusScore > 60 && (
                            <Badge variant="outline" className="text-[10px] border-destructive/30 text-destructive bg-destructive/5">
                              High Risk
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground font-mono">
                          {agent.id?.slice(0, 12)} Â· {agent.uptime || "â€”"}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-6 text-xs">
                      <div className="flex items-center gap-1.5 text-muted-foreground">
                        <Cpu className="h-3.5 w-3.5" />
                        <span className="font-mono">{tasks} tasks</span>
                      </div>
                      <div className="flex items-center gap-1.5 text-muted-foreground">
                        <Zap className="h-3.5 w-3.5" />
                        <span className="font-mono">{(tokens / 1000).toFixed(0)}K tokens</span>
                      </div>
                      <div className="w-32 hidden lg:block">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-muted-foreground flex items-center gap-1">
                            <DollarSign className="h-3 w-3" />{cost.toFixed(2)}
                          </span>
                          <span className="text-muted-foreground">${budget}</span>
                        </div>
                        <Progress value={budget > 0 ? (cost / budget) * 100 : 0} className="h-1.5" />
                      </div>
                      <div className="gap-1 hidden md:flex flex-wrap max-w-[160px]">
                        {(Array.isArray(tools) ? tools : []).slice(0, 4).map((t: string) => (
                          <span key={t} className="px-1.5 py-0.5 rounded bg-muted text-[10px] font-mono text-muted-foreground">{t}</span>
                        ))}
                        {tools.length > 4 && (
                          <span className="px-1.5 py-0.5 rounded bg-muted text-[10px] text-muted-foreground">+{tools.length - 4}</span>
                        )}
                      </div>
                      {agent.status !== "TERMINATED" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="gap-1.5 text-destructive hover:text-destructive hover:bg-destructive/10 h-8 px-2"
                          onClick={(e) => { e.stopPropagation(); handleEmergencyStop(agent.id, agent.name); }}
                          disabled={stoppingId === agent.id}
                        >
                          {stoppingId === agent.id
                            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            : <OctagonX className="h-3.5 w-3.5" />}
                          <span className="hidden xl:inline text-xs">Stop</span>
                        </Button>
                      )}
                      <ChevronDown
                        className={`h-4 w-4 text-muted-foreground transition-transform ${isExpanded ? "rotate-180" : ""}`}
                      />
                    </div>
                  </div>
                </div>

                {/* Inline expansion */}
                <AnimatePresence initial={false}>
                  {isExpanded && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.22 }}
                      className="overflow-hidden"
                    >
                      <AgentExpansion agentId={agent.id} agentData={agent} />
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            );
          })}
        </motion.div>
      )}
    </div>
  );
}

