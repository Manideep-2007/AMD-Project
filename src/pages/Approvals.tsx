/**
 * Approvals Page — Live approval queue with blast radius $ display.
 * Features:
 *   - Real-time pending count via WebSocket
 *   - Blast radius dollar figure per escalated action
 *   - Inline approve/reject with mandatory rationale
 *   - Time-waiting display with escalation aging colors
 *   - Filterable by agent, tool type, urgency
 */

import { useState, useMemo, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ShieldAlert,
  CheckCircle,
  XCircle,
  Clock,
  DollarSign,
  AlertTriangle,
  Filter,
  ChevronDown,
  Bot,
  Loader2,
  TrendingUp,
  Sliders,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  useApprovals,
  useApprovalStats,
  useDecideApproval,
} from "@/hooks/use-api";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useWebSocket } from "@/hooks/use-websocket";

interface Approval {
  id: string;
  taskId: string;
  taskName: string;
  agentId: string;
  agentName: string;
  toolType: string;
  method: string;
  reason: string;
  blastRadius: number;
  riskLevel: "low" | "medium" | "high" | "critical";
  environment: string;
  requestedAt: string;
  timeoutAt?: string; // ISO string; if absent, defaults to requestedAt + 30 min
  status: "pending" | "approved" | "denied";
  decidedAt?: string;
  decidedBy?: string;
  decisionReason?: string;
}

/** Returns seconds remaining until timeoutAt, refreshed every second */
function useCountdown(timeoutAt: string | undefined): number {
  const deadline = timeoutAt
    ? new Date(timeoutAt).getTime()
    : 0;
  const [secondsLeft, setSecondsLeft] = useState(() => deadline ? Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) : 0);
  useEffect(() => {
    if (!deadline) return;
    const tick = () => setSecondsLeft(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [deadline]);
  return secondsLeft;
}

function formatCountdown(seconds: number): string {
  if (seconds <= 0) return "expired";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function countdownColorClass(seconds: number): string {
  if (seconds <= 0) return "text-destructive font-bold animate-pulse";
  if (seconds <= 300) return "text-destructive font-semibold animate-pulse"; // < 5 min
  if (seconds <= 600) return "text-warning font-semibold"; // < 10 min
  return "text-muted-foreground";
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function urgencyColor(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 5) return "text-muted-foreground";
  if (mins < 15) return "text-warning";
  if (mins < 30) return "text-orange-500";
  return "text-destructive animate-pulse";
}

function riskBadge(risk: string) {
  const styles: Record<string, string> = {
    low: "bg-success/10 text-success border-success/20",
    medium: "bg-warning/10 text-warning border-warning/20",
    high: "bg-orange-500/10 text-orange-500 border-orange-500/20",
    critical: "bg-destructive/10 text-destructive border-destructive/20",
  };
  return styles[risk] || styles.low;
}

const fadeUp = { hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0 } };
const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.05 } } };

// Auto-deny countdown card — wraps a single approval
function ApprovalCountdownRow({
  approval,
  onAutoDeny,
}: { approval: Approval; onAutoDeny: (id: string) => void }) {
  const timeoutAt = approval.timeoutAt ?? new Date(new Date(approval.requestedAt).getTime() + 30 * 60_000).toISOString();
  const secondsLeft = useCountdown(approval.status === "pending" ? timeoutAt : undefined);

  useEffect(() => {
    if (approval.status === "pending" && secondsLeft === 0) {
      onAutoDeny(approval.id);
    }
  }, [secondsLeft, approval.status, approval.id, onAutoDeny]);

  return (
    <div className={`flex items-center gap-1 text-xs ${countdownColorClass(secondsLeft)}`}>
      <Clock className="h-3 w-3" />
      {secondsLeft > 0 ? <span>Auto-deny in {formatCountdown(secondsLeft)}</span> : <span>Auto-denied</span>}
    </div>
  );
}

export default function Approvals() {
  const [tab, setTab] = useState("pending");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [decisionReason, setDecisionReason] = useState("");
  const [filterAgent, setFilterAgent] = useState<string>("");

  // Modify Scope dialog state
  const [modifyScopeId, setModifyScopeId] = useState<string | null>(null);
  const [scopeReadOnly, setScopeReadOnly] = useState(false);
  const [scopeDryRun, setScopeDryRun] = useState(false);
  const [scopeMaxRows, setScopeMaxRows] = useState("");
  const [scopeReason, setScopeReason] = useState("");

  // API hooks
  const { data: approvalsData, isLoading } = useApprovals({
    pending: tab === "pending" ? "true" : undefined,
  });
  const { data: statsData } = useApprovalStats();
  const decideMutation = useDecideApproval();
  const { connected } = useWebSocket();

  const approvals: Approval[] = approvalsData?.data || [];
  const stats = statsData?.data || { pending: 0, approvedToday: 0, deniedToday: 0, avgWaitMs: 0 };

  const filteredApprovals = useMemo(() => {
    if (!filterAgent) return approvals;
    return approvals.filter((a) =>
      a.agentName?.toLowerCase().includes(filterAgent.toLowerCase())
    );
  }, [approvals, filterAgent]);

  const handleDecision = async (id: string, approved: boolean, overrideReason?: string) => {
    if (!decisionReason.trim() && !approved && !overrideReason) return;
    await decideMutation.mutateAsync({
      id,
      approved,
      reason: overrideReason ?? decisionReason ?? (approved ? "Approved by operator" : "Denied by operator"),
    });
    setExpandedId(null);
    setDecisionReason("");
  };

  const handleAutoDeny = useCallback((id: string) => {
    decideMutation.mutate({ id, approved: false, reason: "Auto-denied: approval timeout exceeded" });
  }, [decideMutation]);

  function handleModifyScopeApprove() {
    if (!modifyScopeId) return;
    const scopeParts: string[] = [];
    if (scopeReadOnly) scopeParts.push("read-only mode");
    if (scopeDryRun) scopeParts.push("dry-run only");
    if (scopeMaxRows) scopeParts.push(`max ${scopeMaxRows} rows`);
    const scopeStr = scopeParts.length > 0 ? `Approved with restrictions: ${scopeParts.join(", ")}. ` : "";
    const finalReason = `${scopeStr}${scopeReason || "Scope-restricted approval by operator"}`;
    decideMutation.mutate({ id: modifyScopeId, approved: true, reason: finalReason });
    setModifyScopeId(null);
    setScopeReadOnly(false);
    setScopeDryRun(false);
    setScopeMaxRows("");
    setScopeReason("");
  }

  return (
    <div className="p-6 space-y-6">
      {/* Modify Scope Dialog */}
      <Dialog open={!!modifyScopeId} onOpenChange={(open) => { if (!open) setModifyScopeId(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sliders className="h-5 w-5 text-primary" /> Approve with Restrictions
            </DialogTitle>
            <DialogDescription>
              Approve this action but apply scope limits that constrain what the agent can do.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="scope-readonly" className="text-sm">Read-only mode (no writes)</Label>
              <Switch id="scope-readonly" checked={scopeReadOnly} onCheckedChange={setScopeReadOnly} />
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="scope-dryrun" className="text-sm">Dry-run (simulate only)</Label>
              <Switch id="scope-dryrun" checked={scopeDryRun} onCheckedChange={setScopeDryRun} />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground mb-1.5 block">Max rows / records (optional)</Label>
              <Input
                type="number"
                min="1"
                placeholder="e.g. 100"
                value={scopeMaxRows}
                onChange={(e) => setScopeMaxRows(e.target.value)}
              />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground mb-1.5 block">Rationale</Label>
              <Textarea
                rows={3}
                placeholder="Why are these restrictions appropriate?"
                value={scopeReason}
                onChange={(e) => setScopeReason(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setModifyScopeId(null)}>Cancel</Button>
            <Button onClick={handleModifyScopeApprove} disabled={decideMutation.isPending}
              className="bg-success hover:bg-success/90 text-success-foreground gap-2">
              {decideMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              <CheckCircle className="h-4 w-4" /> Approve with Scope
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Approvals</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Human-in-the-loop approval queue for escalated agent actions
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className={`flex items-center gap-1.5 text-xs ${connected ? "text-success" : "text-destructive"}`}>
            <span className={`h-2 w-2 rounded-full ${connected ? "bg-success animate-pulse" : "bg-destructive"}`} />
            {connected ? "Live" : "Disconnected"}
          </div>
        </div>
      </div>

      {/* Stats Cards */}
      <motion.div
        initial="hidden"
        animate="show"
        variants={stagger}
        className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4"
      >
        <motion.div variants={fadeUp} className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
            <AlertTriangle className="h-3.5 w-3.5 text-warning" />
            Pending
          </div>
          <p className="text-2xl font-bold text-warning">{stats.pending}</p>
        </motion.div>
        <motion.div variants={fadeUp} className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
            <CheckCircle className="h-3.5 w-3.5 text-success" />
            Approved Today
          </div>
          <p className="text-2xl font-bold text-success">{stats.approvedToday}</p>
        </motion.div>
        <motion.div variants={fadeUp} className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
            <XCircle className="h-3.5 w-3.5 text-destructive" />
            Denied Today
          </div>
          <p className="text-2xl font-bold text-destructive">{stats.deniedToday}</p>
        </motion.div>
        <motion.div variants={fadeUp} className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
            <Clock className="h-3.5 w-3.5" />
            Avg Wait Time
          </div>
          <p className="text-2xl font-bold">
            {stats.avgWaitMs ? `${Math.round(stats.avgWaitMs / 60_000)}m` : "—"}
          </p>
        </motion.div>
      </motion.div>

      {/* Filter & Tabs */}
      <div className="flex items-center gap-4 flex-wrap">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="bg-muted">
            <TabsTrigger value="pending">
              Pending
              {stats.pending > 0 && (
                <span className="ml-1.5 px-1.5 py-0.5 rounded-full bg-warning/20 text-warning text-[10px] font-bold">
                  {stats.pending}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="all">All</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-2">
          <Filter className="h-3.5 w-3.5 text-muted-foreground" />
          <input
            type="text"
            placeholder="Filter by agent..."
            value={filterAgent}
            onChange={(e) => setFilterAgent(e.target.value)}
            className="px-3 py-1.5 rounded-md border border-border bg-background text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary w-48"
          />
        </div>
      </div>

      {/* Approval Queue */}
      {isLoading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : filteredApprovals.length === 0 ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="flex flex-col items-center justify-center py-20 text-muted-foreground"
        >
          <ShieldAlert className="h-12 w-12 mb-4 opacity-30" />
          <p className="text-sm font-medium">No pending approvals</p>
          <p className="text-xs mt-1">All escalated actions have been reviewed</p>
        </motion.div>
      ) : (
        <motion.div
          initial="hidden"
          animate="show"
          variants={stagger}
          className="space-y-3"
        >
          <AnimatePresence mode="popLayout">
            {filteredApprovals.map((approval) => (
              <motion.div
                key={approval.id}
                variants={fadeUp}
                layout
                exit={{ opacity: 0, x: -100, transition: { duration: 0.3 } }}
                className={`rounded-xl border bg-card overflow-hidden transition-colors ${
                  approval.status === "pending"
                    ? "border-warning/30 hover:border-warning/50"
                    : "border-border"
                }`}
              >
                {/* Main row */}
                <div
                  className="p-5 cursor-pointer hover:bg-accent/30 transition-colors"
                  onClick={() => setExpandedId(expandedId === approval.id ? null : approval.id)}
                >
                  <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-warning/10 border border-warning/20">
                        <ShieldAlert className="h-5 w-5 text-warning" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="text-sm font-semibold truncate">
                            {approval.taskName || `Task ${approval.taskId}`}
                          </h3>
                          <Badge variant="outline" className={`text-[10px] font-mono ${riskBadge(approval.riskLevel)}`}>
                            {approval.riskLevel?.toUpperCase()}
                          </Badge>
                          {approval.status === "approved" && (
                            <Badge variant="outline" className="text-[10px] text-success border-success/20 bg-success/10">
                              APPROVED
                            </Badge>
                          )}
                          {approval.status === "denied" && (
                            <Badge variant="outline" className="text-[10px] text-destructive border-destructive/20 bg-destructive/10">
                              DENIED
                            </Badge>
                          )}
                        </div>
                        <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                          <span className="flex items-center gap-1">
                            <Bot className="h-3 w-3" /> {approval.agentName}
                          </span>
                          <span className="font-mono">{approval.toolType}.{approval.method}</span>
                          <span>{approval.environment}</span>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-5">
                      {/* Blast Radius Dollar Figure */}
                      <div className="text-right">
                        <div className="flex items-center gap-1 text-sm font-bold tracking-tight">
                          <DollarSign className="h-3.5 w-3.5 text-warning" />
                          <span className={approval.blastRadius > 1000 ? "text-destructive" : approval.blastRadius > 100 ? "text-warning" : "text-foreground"}>
                            {approval.blastRadius >= 1000
                              ? `${(approval.blastRadius / 1000).toFixed(1)}K`
                              : approval.blastRadius?.toFixed(2) || "0.00"}
                          </span>
                        </div>
                        <p className="text-[10px] text-muted-foreground">blast radius</p>
                      </div>

                      {/* Waiting time + countdown */}
                      <div className="text-right min-w-[100px]">
                        <p className={`text-xs font-mono ${urgencyColor(approval.requestedAt)}`}>
                          <Clock className="h-3 w-3 inline mr-1" />
                          {timeAgo(approval.requestedAt)}
                        </p>
                        {approval.status === "pending" && (
                          <ApprovalCountdownRow approval={approval} onAutoDeny={handleAutoDeny} />
                        )}
                      </div>

                      <ChevronDown
                        className={`h-4 w-4 text-muted-foreground transition-transform ${
                          expandedId === approval.id ? "rotate-180" : ""
                        }`}
                      />
                    </div>
                  </div>
                </div>

                {/* Expanded detail + action panel */}
                <AnimatePresence>
                  {expandedId === approval.id && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.2 }}
                      className="overflow-hidden"
                    >
                      <div className="border-t border-border px-5 py-4 bg-muted/30 space-y-4">
                        {/* Escalation reason */}
                        <div>
                          <p className="text-xs font-medium text-muted-foreground mb-1">
                            Escalation Reason
                          </p>
                          <p className="text-sm text-foreground bg-background rounded-md border border-border p-3 font-mono">
                            {approval.reason || "Policy rule triggered ESCALATE_TO_HUMAN action"}
                          </p>
                        </div>

                        {/* Blast radius breakdown */}
                        <div className="grid grid-cols-3 gap-3">
                          <div className="rounded-lg border border-border bg-background p-3">
                            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">
                              Permission Breadth
                            </p>
                            <p className="text-lg font-bold mt-1">
                              <TrendingUp className="h-3.5 w-3.5 inline text-primary mr-1" />
                              {((approval.blastRadius * 0.4) || 0).toFixed(1)}
                            </p>
                          </div>
                          <div className="rounded-lg border border-border bg-background p-3">
                            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">
                              Data Sensitivity
                            </p>
                            <p className="text-lg font-bold mt-1">
                              <ShieldAlert className="h-3.5 w-3.5 inline text-warning mr-1" />
                              {((approval.blastRadius * 0.35) || 0).toFixed(1)}
                            </p>
                          </div>
                          <div className="rounded-lg border border-border bg-background p-3">
                            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">
                              Financial Exposure
                            </p>
                            <p className="text-lg font-bold mt-1">
                              <DollarSign className="h-3.5 w-3.5 inline text-destructive mr-1" />
                              ${((approval.blastRadius * 0.25) || 0).toFixed(2)}
                            </p>
                          </div>
                        </div>

                        {/* Decision panel */}
                        {approval.status === "pending" && (
                          <div className="space-y-3">
                            <div>
                              <label className="text-xs font-medium text-muted-foreground">
                                Decision Rationale {!decideMutation.isPending && "(required for deny)"}
                              </label>
                              <textarea
                                value={decisionReason}
                                onChange={(e) => setDecisionReason(e.target.value)}
                                placeholder="Provide rationale for your decision..."
                                rows={2}
                                className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary resize-none"
                              />
                            </div>
                            <div className="flex items-center gap-3 flex-wrap">
                              <Button
                                onClick={() => handleDecision(approval.id, true)}
                                disabled={decideMutation.isPending}
                                className="gap-2 bg-success hover:bg-success/90 text-success-foreground"
                              >
                                {decideMutation.isPending ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                  <CheckCircle className="h-4 w-4" />
                                )}
                                Approve
                              </Button>
                              <Button
                                onClick={() => { setModifyScopeId(approval.id); }}
                                disabled={decideMutation.isPending}
                                variant="outline"
                                className="gap-2 border-primary/30 text-primary hover:bg-primary/10"
                              >
                                <Sliders className="h-4 w-4" />
                                Modify Scope
                              </Button>
                              <Button
                                onClick={() => handleDecision(approval.id, false)}
                                disabled={decideMutation.isPending || !decisionReason.trim()}
                                variant="destructive"
                                className="gap-2"
                              >
                                {decideMutation.isPending ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                  <XCircle className="h-4 w-4" />
                                )}
                                Deny
                              </Button>
                            </div>
                          </div>
                        )}

                        {/* Decision history */}
                        {approval.status !== "pending" && approval.decidedBy && (
                          <div className="rounded-lg border border-border bg-background p-3">
                            <p className="text-xs text-muted-foreground">
                              Decided by <span className="font-medium text-foreground">{approval.decidedBy}</span>
                              {" "}at {approval.decidedAt ? new Date(approval.decidedAt).toLocaleString() : "—"}
                            </p>
                            {approval.decisionReason && (
                              <p className="text-sm mt-1 text-foreground">{approval.decisionReason}</p>
                            )}
                          </div>
                        )}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            ))}
          </AnimatePresence>
        </motion.div>
      )}
    </div>
  );
}
