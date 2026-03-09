import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { MetricCard } from "@/components/MetricCard";
import { StatusBadge } from "@/components/StatusBadge";
import {
  Bot, DollarSign, ShieldAlert, Activity, ArrowRight, Loader2, AlertCircle,
  ShieldOff, Zap, Shield
} from "lucide-react";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useAuthStore } from "@/stores/auth-store";
import {
  useDashboardMetrics, useTasks, useAuditEvents, useCostSummary,
  useApprovalStats, useBlastRadiusSummary, useEmergencyStopAll
} from "@/hooks/use-api";
import { useWebSocket } from "@/hooks/use-websocket";

const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.08 } } };
const fadeUp = { hidden: { opacity: 0, y: 16 }, show: { opacity: 1, y: 0, transition: { duration: 0.4 } } };

// Live event feed item shape
interface FeedEvent {
  id: string;
  type: string;
  description: string;
  agentName?: string;
  severity: "info" | "warning" | "error" | "success";
  timestamp: string;
}

function severityColor(s: string) {
  if (s === "error") return "text-destructive";
  if (s === "warning") return "text-warning";
  if (s === "success") return "text-success";
  return "text-muted-foreground";
}

function blastRiskColor(score: number) {
  if (score > 60) return "text-destructive bg-destructive/10 border-destructive/20";
  if (score > 30) return "text-warning bg-warning/10 border-warning/20";
  return "text-success bg-success/10 border-success/20";
}

function blastRiskLabel(score: number) {
  if (score > 60) return "Over-permissioned";
  if (score > 30) return "Moderate";
  return "Well-governed";
}

// Animated protection value counter
function useCountUp(target: number, duration = 1200) {
  const [current, setCurrent] = useState(0);
  useEffect(() => {
    if (target === 0) { setCurrent(0); return; }
    const start = performance.now();
    const raf = (ts: number) => {
      const progress = Math.min((ts - start) / duration, 1);
      const ease = 1 - Math.pow(1 - progress, 3);
      setCurrent(Math.floor(target * ease));
      if (progress < 1) requestAnimationFrame(raf);
      else setCurrent(target);
    };
    requestAnimationFrame(raf);
  }, [target, duration]);
  return current;
}

export default function Dashboard() {
  const { user } = useAuthStore();
  const canEmergencyStop = user?.role === "OWNER" || user?.role === "ADMIN";
  const { toast } = useToast();

  // Emergency Stop state
  const [stopDialogOpen, setStopDialogOpen] = useState(false);
  const [stopConfirmation, setStopConfirmation] = useState("");
  const [stopReason, setStopReason] = useState("");

  // Data hooks
  const { data: metricsData, isLoading: metricsLoading, isError: metricsError } = useDashboardMetrics();
  const { data: tasksData } = useTasks({ limit: 5 });
  const { data: auditData } = useAuditEvents({ limit: 5, eventType: 'POLICY_VIOLATION' });
  const { data: costData, isLoading: costLoading } = useCostSummary('today');
  const { data: approvalData } = useApprovalStats();
  const { data: blastData, isLoading: blastLoading } = useBlastRadiusSummary();
  const emergencyStop = useEmergencyStopAll();

  // Live event feed (WebSocket)
  const [feedEvents, setFeedEvents] = useState<FeedEvent[]>([]);
  const feedRef = useRef<HTMLDivElement>(null);
  const { on } = useWebSocket();

  useEffect(() => {
    const handleEvent = (data: unknown) => {
      try {
        const evt = (data ?? {}) as Record<string, any>;
        const feedEvent: FeedEvent = {
          id: `${Date.now()}-${Math.random()}`,
          type: evt.type ?? evt.eventType ?? "event",
          description: evt.message ?? evt.reason ?? evt.type ?? "Agent activity",
          agentName: evt.agentName ?? evt.agentId?.slice(0, 12),
          severity: (evt.riskLevel === "CRITICAL" || evt.type?.includes("blocked") || evt.type?.includes("terminate")) ? "error"
            : (evt.type?.includes("alert") || evt.type?.includes("anomaly") || evt.type?.includes("escalat")) ? "warning"
            : (evt.type?.includes("complete") || evt.type?.includes("success")) ? "success"
            : "info",
          timestamp: evt.timestamp ?? new Date().toISOString(),
        };
        setFeedEvents((prev) => [feedEvent, ...prev].slice(0, 50));
      } catch {
        // skip malformed events
      }
    };
    // Subscribe to all relevant event types
    const unsubs = [
      on("*", handleEvent),
      on("task.update", handleEvent),
      on("agent.update", handleEvent),
      on("policy.violation", handleEvent),
      on("approval.escalated", handleEvent),
      on("budget.alert", handleEvent),
    ];
    return () => unsubs.forEach((u) => u());
  }, [on]);

  // Metrics
  const metrics = metricsData?.data || {};
  const recentTasks = tasksData?.data || [];
  const violations = auditData?.data || [];
  const costSummary = costData?.data || {};
  const approvalStats = approvalData?.data || {};
  const blast = blastData?.data || {};

  const activeAgents = metrics.activeAgents ?? 0;
  const costToday = costSummary.totalCost ?? metrics.costToday ?? 0;
  const policyViolations = metrics.policyViolations ?? violations.length ?? 0;
  const tasksPerHour = metrics.tasksPerHour ?? 0;
  const protectedValue = blast.totalProtectedValueUsd ?? 0;
  const agentCount = blast.agentCount ?? 0;

  const animatedProtected = useCountUp(Math.round(protectedValue));

  const chartData = costSummary.costByHour?.length > 0
    ? costSummary.costByHour.map((h: any) => ({
        hour: h.hour?.slice(-5) || h.hour,
        cost: Math.round(h.cost * 100) / 100,
        tokens: Math.round((h.tokens || 0) / 1000),
      }))
    : [];

  const isLoading = metricsLoading || costLoading;

  function handleEmergencyStop() {
    if (stopConfirmation !== "STOP ALL AGENTS") {
      toast({ title: "Type 'STOP ALL AGENTS' exactly", variant: "destructive" });
      return;
    }
    if (!stopReason.trim() || stopReason.trim().length < 5) {
      toast({ title: "Reason is required (min 5 characters)", variant: "destructive" });
      return;
    }
    emergencyStop.mutate(
      { confirmation: stopConfirmation, reason: stopReason },
      {
        onSuccess: (res) => {
          toast({
            title: "â›” Emergency Stop Executed",
            description: `${res?.data?.agentsTerminated ?? 0} agents terminated, ${res?.data?.tasksCancelled ?? 0} tasks cancelled.`,
            variant: "destructive",
          });
          setStopDialogOpen(false);
          setStopConfirmation("");
          setStopReason("");
        },
        onError: (err: any) => {
          toast({ title: "Emergency stop failed", description: err.message, variant: "destructive" });
        },
      }
    );
  }

  return (
    <div className="p-6 space-y-6 gradient-mesh min-h-full">
      {/* Top bar: title + Emergency Stop */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground mt-1">Real-time overview of your AI agent operations</p>
        </div>
        {canEmergencyStop && (
          <Button
            variant="destructive"
            size="sm"
            className="gap-2 font-semibold"
            onClick={() => setStopDialogOpen(true)}
          >
            <ShieldOff className="h-4 w-4" />
            Emergency Stop
          </Button>
        )}
      </div>

      {/* Emergency Stop Dialog */}
      <Dialog open={stopDialogOpen} onOpenChange={setStopDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <ShieldOff className="h-5 w-5" /> Emergency Stop
            </DialogTitle>
            <DialogDescription>
              This will immediately terminate all {blast.agentCount ?? "active"} agents and cancel all
              running tasks across your workspace. This action is logged and cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <p className="text-xs text-muted-foreground mb-1">
                Type <span className="font-mono font-bold text-foreground">STOP ALL AGENTS</span> to confirm
              </p>
              <Input
                value={stopConfirmation}
                onChange={(e) => setStopConfirmation(e.target.value)}
                placeholder="STOP ALL AGENTS"
                className="font-mono"
              />
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">Reason (required)</p>
              <Textarea
                value={stopReason}
                onChange={(e) => setStopReason(e.target.value)}
                placeholder="e.g. Security incident detected, suspicious agent behaviour"
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setStopDialogOpen(false)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={handleEmergencyStop}
              disabled={emergencyStop.isPending || stopConfirmation !== "STOP ALL AGENTS"}
            >
              {emergencyStop.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Stop All Agents
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* API Error Banner */}
      {metricsError && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 flex items-center gap-3">
          <AlertCircle className="h-5 w-5 text-destructive" />
          <div>
            <p className="text-sm font-semibold text-destructive">Unable to load dashboard data</p>
            <p className="text-xs text-muted-foreground">The API server may be unavailable.</p>
          </div>
        </div>
      )}

      {/* Blast Radius Headline */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="rounded-xl border border-primary/20 bg-gradient-to-r from-primary/5 to-transparent p-5 flex items-center justify-between"
      >
        <div className="flex items-center gap-4">
          <div className="h-12 w-12 rounded-xl bg-primary/10 flex items-center justify-center">
            <Shield className="h-6 w-6 text-primary" />
          </div>
          <div>
            {blastLoading ? (
              <div className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                <span className="text-sm text-muted-foreground">Calculating blast radius...</span>
              </div>
            ) : (
              <>
                <p className="text-2xl font-bold tracking-tight">
                  NexusOps is protecting{" "}
                  <span className="text-primary">${animatedProtected.toLocaleString()}</span>
                </p>
                <p className="text-sm text-muted-foreground mt-0.5">
                  across{" "}
                  <span className="font-medium text-foreground">{agentCount} active agents</span>
                  {blast.highRiskAgentCount > 0 && (
                    <span className="ml-2 text-warning">
                      Â· {blast.highRiskAgentCount} over-permissioned
                    </span>
                  )}
                </p>
              </>
            )}
          </div>
        </div>
        <div className="text-right hidden sm:block">
          <p className="text-xs text-muted-foreground">Max exposure</p>
          <p className="text-lg font-semibold">${(blast.workspaceMaxDamageUsd ?? 0).toLocaleString()}</p>
          <p className="text-xs text-muted-foreground mt-0.5">governed to ${(blast.workspaceGovernedDamageUsd ?? 0).toLocaleString()}</p>
        </div>
      </motion.div>

      {/* Pending Approvals Banner */}
      {(approvalStats.pending ?? 0) > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="rounded-xl border border-warning/30 bg-warning/5 p-4 flex items-center justify-between"
        >
          <div className="flex items-center gap-3">
            <ShieldAlert className="h-5 w-5 text-warning" />
            <div>
              <p className="text-sm font-semibold text-warning">{approvalStats.pending} Pending Approval{approvalStats.pending > 1 ? 's' : ''}</p>
              <p className="text-xs text-muted-foreground">Escalated agent actions awaiting human review</p>
            </div>
          </div>
          <Link to="/approvals" className="flex items-center gap-1 text-xs font-medium text-warning hover:underline">
            Review Now <ArrowRight className="h-3 w-3" />
          </Link>
        </motion.div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <motion.div initial="hidden" animate="show" variants={stagger}>
          {/* Metric cards */}
          <motion.div variants={fadeUp} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <MetricCard label="Active Agents" value={activeAgents} icon={<Bot className="h-4 w-4" />} variant="primary" change={metrics.agentChange ?? 0} />
            <MetricCard label="Cost Today" value={costToday} prefix="$" decimals={2} icon={<DollarSign className="h-4 w-4" />} variant="warning" change={metrics.costChange ?? 0} />
            <MetricCard label="Policy Violations" value={policyViolations} icon={<ShieldAlert className="h-4 w-4" />} variant="destructive" change={metrics.violationChange ?? 0} />
            <MetricCard label="Tasks / Hour" value={tasksPerHour} icon={<Activity className="h-4 w-4" />} variant="success" change={metrics.taskRateChange ?? 0} />
          </motion.div>
        </motion.div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Cost Chart */}
        <motion.div
          initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }}
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
            {chartData.length > 0 ? (
              <AreaChart data={chartData}>
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
                <Tooltip contentStyle={{ backgroundColor: "hsl(230,14%,8%)", border: "1px solid hsl(230,10%,16%)", borderRadius: 8, fontSize: 12 }} />
                <Area type="monotone" dataKey="cost" stroke="hsl(217,91%,60%)" fill="url(#gradCost)" strokeWidth={2} />
                <Area type="monotone" dataKey="tokens" stroke="hsl(160,84%,39%)" fill="url(#gradTokens)" strokeWidth={2} />
              </AreaChart>
            ) : (
              <AreaChart data={[]}>
                <text x="50%" y="50%" textAnchor="middle" dominantBaseline="middle" fill="hsl(220,10%,50%)" fontSize={12}>
                  No cost data yet â€” data will appear as agents execute tasks
                </text>
              </AreaChart>
            )}
          </ResponsiveContainer>
        </motion.div>

        {/* Live Activity Feed */}
        <motion.div
          initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4 }}
          className="rounded-xl border border-border bg-card p-5 flex flex-col"
        >
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse" />
              Live Activity
            </h2>
            <span className="text-[10px] text-muted-foreground">{feedEvents.length} events</span>
          </div>
          <div ref={feedRef} className="flex-1 overflow-y-auto space-y-2 max-h-[220px] pr-1">
            <AnimatePresence initial={false}>
              {feedEvents.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-10 text-xs text-muted-foreground">
                  <Zap className="h-6 w-6 mb-2 opacity-20" />
                  Waiting for agent activity...
                </div>
              ) : (
                feedEvents.map((ev) => (
                  <motion.div
                    key={ev.id}
                    initial={{ opacity: 0, x: 10 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0 }}
                    className="flex items-start gap-2 text-xs"
                  >
                    <span className={`mt-0.5 shrink-0 ${severityColor(ev.severity)}`}>â—</span>
                    <div className="flex-1 min-w-0">
                      <p className="truncate text-foreground/90">{ev.description}</p>
                      {ev.agentName && <p className="text-muted-foreground">{ev.agentName}</p>}
                    </div>
                    <span className="text-muted-foreground shrink-0">
                      {new Date(ev.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </span>
                  </motion.div>
                ))
              )}
            </AnimatePresence>
          </div>
        </motion.div>
      </div>

      {/* Blast Radius Risk Leaderboard */}
      {(blast.agents?.length ?? 0) > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.45 }}
          className="rounded-xl border border-border bg-card overflow-hidden"
        >
          <div className="flex items-center justify-between p-5 pb-3">
            <div>
              <h2 className="text-sm font-semibold">Agent Risk Rankings</h2>
              <p className="text-xs text-muted-foreground">Sorted by blast radius score</p>
            </div>
            <Link to="/agents" className="text-xs text-primary hover:underline flex items-center gap-1">
              Manage <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left px-5 py-2 font-medium text-muted-foreground">Agent</th>
                  <th className="text-right px-4 py-2 font-medium text-muted-foreground">Risk Score</th>
                  <th className="text-right px-4 py-2 font-medium text-muted-foreground hidden sm:table-cell">Max Exposure</th>
                  <th className="text-right px-4 py-2 font-medium text-muted-foreground hidden md:table-cell">Governed</th>
                  <th className="text-right px-4 py-2 font-medium text-muted-foreground">Status</th>
                </tr>
              </thead>
              <tbody>
                {(blast.agents as any[]).slice(0, 8).map((agent: any) => (
                  <tr key={agent.id} className={`border-b border-border/50 hover:bg-accent/30 transition-colors ${agent.blastRadiusScore > 60 ? "bg-destructive/5" : ""}`}>
                    <td className="px-5 py-2.5">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-foreground">{agent.name}</span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${blastRiskColor(agent.blastRadiusScore)}`}>
                          {blastRiskLabel(agent.blastRadiusScore)}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <span className={`font-mono font-bold ${agent.blastRadiusScore > 60 ? "text-destructive" : agent.blastRadiusScore > 30 ? "text-warning" : "text-success"}`}>
                        {agent.blastRadiusScore}
                      </span>
                      <span className="text-muted-foreground">/100</span>
                    </td>
                    <td className="px-4 py-2.5 text-right hidden sm:table-cell text-muted-foreground">
                      ${(agent.maxDamageUsd ?? 0).toLocaleString()}
                    </td>
                    <td className="px-4 py-2.5 text-right hidden md:table-cell text-success">
                      ${(agent.governedDamageUsd ?? 0).toLocaleString()}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <StatusBadge status={agent.status?.toLowerCase() ?? "idle"} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </motion.div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Recent Violations */}
        <motion.div
          initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.5 }}
          className="rounded-xl border border-border bg-card p-5"
        >
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold">Recent Violations</h2>
            <Link to="/audit" className="text-xs text-primary hover:underline flex items-center gap-1">View all <ArrowRight className="h-3 w-3" /></Link>
          </div>
          <div className="space-y-3">
            {violations.length > 0 ? violations.slice(0, 5).map((v: any, i: number) => (
              <div key={v.id || i} className="p-3 rounded-lg bg-muted/50 border border-border space-y-1">
                <p className="text-xs font-medium text-foreground">{v.eventType || v.type || "Policy Violation"}</p>
                <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                  <span>{v.agentId?.slice(0, 12) || "Unknown"} â†’ {v.toolType || "Tool"}</span>
                  <span>{v.createdAt ? new Date(v.createdAt).toLocaleTimeString() : "â€”"}</span>
                </div>
              </div>
            )) : (
              <div className="text-center py-6 text-xs text-muted-foreground">
                <ShieldAlert className="h-6 w-6 mx-auto mb-2 opacity-30" />
                No recent violations
              </div>
            )}
          </div>
        </motion.div>

        {/* Recent Tasks */}
        <motion.div
          initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.55 }}
          className="lg:col-span-2 rounded-xl border border-border bg-card"
        >
          <div className="flex items-center justify-between p-5 pb-0">
            <h2 className="text-sm font-semibold">Recent Tasks</h2>
            <Link to="/tasks" className="text-xs text-primary hover:underline flex items-center gap-1">View all <ArrowRight className="h-3 w-3" /></Link>
          </div>
          <div className="p-2">
            {recentTasks.length > 0 ? recentTasks.slice(0, 5).map((task: any) => (
              <div key={task.id} className="flex items-center gap-4 px-3 py-2.5 rounded-lg hover:bg-accent/50 transition-colors cursor-pointer">
                <span className="text-xs font-mono text-muted-foreground w-20 truncate">{task.id?.slice(0, 8) || "â€”"}</span>
                <span className="text-sm flex-1 truncate">{task.name || task.description || "Unnamed task"}</span>
                <span className="text-xs text-muted-foreground hidden sm:block truncate max-w-[120px]">{task.agentName || task.agentId?.slice(0, 12) || "â€”"}</span>
                <StatusBadge status={task.status?.toLowerCase() || "pending"} />
                <span className="text-[11px] text-muted-foreground w-14 text-right">
                  {task.createdAt ? new Date(task.createdAt).toLocaleTimeString() : "â€”"}
                </span>
              </div>
            )) : (
              <div className="text-center py-8 text-xs text-muted-foreground">No recent tasks</div>
            )}
          </div>
        </motion.div>
      </div>
    </div>
  );
}
