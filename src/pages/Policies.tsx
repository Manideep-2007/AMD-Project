import { useState } from "react";
import { motion } from "framer-motion";
import { Shield, Plus, Clock, CheckCircle, XCircle, AlertTriangle, Loader2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { usePolicies, useCreatePolicy } from "@/hooks/use-api";

const typeIconMap: Record<string, React.ReactNode> = {
  ALLOW: <CheckCircle className="h-3.5 w-3.5" />,
  DENY: <XCircle className="h-3.5 w-3.5" />,
  ESCALATE_TO_HUMAN: <AlertTriangle className="h-3.5 w-3.5" />,
};
const typeStyleMap: Record<string, string> = {
  ALLOW: "text-success border-success/30 bg-success/10",
  DENY: "text-destructive border-destructive/30 bg-destructive/10",
  ESCALATE_TO_HUMAN: "text-warning border-warning/30 bg-warning/10",
};

const fadeUp = { hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0 } };
const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.05 } } };

const TOOL_TYPES = ["GITHUB", "JIRA", "DATABASE", "CLOUD_DEPLOY"] as const;
const ENVIRONMENTS = ["development", "staging", "production"] as const;

const EMPTY_FORM = {
  name: "",
  action: "DENY" as "ALLOW" | "DENY" | "ESCALATE_TO_HUMAN",
  priority: 50,
  toolTypes: [] as string[],
  environments: [] as string[],
  enabled: true,
};

export default function Policies() {
  const { data: policiesData, isLoading, isError } = usePolicies();
  const policies = (policiesData?.data?.items || policiesData?.data || []) as any[];

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const createPolicy = useCreatePolicy();

  function toggleItem(field: "toolTypes" | "environments", value: string) {
    setForm((prev) => ({
      ...prev,
      [field]: prev[field].includes(value)
        ? prev[field].filter((v) => v !== value)
        : [...prev[field], value],
    }));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    createPolicy.mutate(
      {
        name: form.name.trim(),
        action: form.action,
        priority: Number(form.priority),
        toolTypes: form.toolTypes.length ? form.toolTypes : undefined,
        environments: form.environments.length ? form.environments : undefined,
        enabled: form.enabled,
      },
      {
        onSuccess: () => {
          setOpen(false);
          setForm(EMPTY_FORM);
        },
      }
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Policies</h1>
          <p className="text-sm text-muted-foreground mt-1">Define rules governing agent behavior. Default-deny posture.</p>
        </div>
        <Button className="gap-2" onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> New Policy</Button>
      </div>

      {/* Create Policy Dialog */}
      <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) setForm(EMPTY_FORM); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New Policy</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="policy-name">Name</Label>
              <Input
                id="policy-name"
                placeholder="e.g. Block prod DB writes"
                value={form.name}
                onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label>Action</Label>
              <Select value={form.action} onValueChange={(v) => setForm((p) => ({ ...p, action: v as typeof form.action }))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALLOW">ALLOW</SelectItem>
                  <SelectItem value="DENY">DENY</SelectItem>
                  <SelectItem value="ESCALATE_TO_HUMAN">ESCALATE_TO_HUMAN</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="policy-priority">Priority <span className="text-muted-foreground text-xs">(lower = evaluated first)</span></Label>
              <Input
                id="policy-priority"
                type="number"
                min={1}
                max={1000}
                value={form.priority}
                onChange={(e) => setForm((p) => ({ ...p, priority: Number(e.target.value) }))}
              />
            </div>

            <div className="space-y-1.5">
              <Label>Tool Types <span className="text-muted-foreground text-xs">(leave empty for all)</span></Label>
              <div className="flex flex-wrap gap-2">
                {TOOL_TYPES.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => toggleItem("toolTypes", t)}
                    className={`px-2.5 py-1 rounded-md text-xs font-mono border transition-colors ${
                      form.toolTypes.includes(t)
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-muted text-muted-foreground border-border hover:border-primary/50"
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Environments <span className="text-muted-foreground text-xs">(leave empty for all)</span></Label>
              <div className="flex flex-wrap gap-2">
                {ENVIRONMENTS.map((env) => (
                  <button
                    key={env}
                    type="button"
                    onClick={() => toggleItem("environments", env)}
                    className={`px-2.5 py-1 rounded-md text-xs font-mono border transition-colors ${
                      form.environments.includes(env)
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-muted text-muted-foreground border-border hover:border-primary/50"
                    }`}
                  >
                    {env}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <input
                id="policy-enabled"
                type="checkbox"
                title="Enable policy immediately"
                checked={form.enabled}
                onChange={(e) => setForm((p) => ({ ...p, enabled: e.target.checked }))}
                className="h-4 w-4 accent-primary"
              />
              <Label htmlFor="policy-enabled">Enable immediately</Label>
            </div>

            {createPolicy.isError && (
              <p className="text-xs text-destructive">Failed to create policy. Please try again.</p>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => { setOpen(false); setForm(EMPTY_FORM); }}>
                Cancel
              </Button>
              <Button type="submit" disabled={createPolicy.isPending || !form.name.trim()}>
                {createPolicy.isPending && <Loader2 className="h-3 w-3 animate-spin mr-1" />}
                Create Policy
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Summary strip */}
      <div className="flex gap-4 text-xs">
        <span className="px-3 py-1.5 rounded-lg bg-destructive/10 text-destructive font-mono font-medium">
          {policies.filter((p) => (p.action || p.type) === "DENY").length} DENY
        </span>
        <span className="px-3 py-1.5 rounded-lg bg-warning/10 text-warning font-mono font-medium">
          {policies.filter((p) => (p.action || p.type) === "ESCALATE_TO_HUMAN").length} ESCALATE
        </span>
        <span className="px-3 py-1.5 rounded-lg bg-success/10 text-success font-mono font-medium">
          {policies.filter((p) => (p.action || p.type) === "ALLOW").length} ALLOW
        </span>
        <span className="px-3 py-1.5 rounded-lg bg-muted text-muted-foreground font-mono font-medium">
          {policies.filter((p) => p.active === false).length} INACTIVE
        </span>
      </div>

      {isError && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" /> Failed to load policies. Check API connection.
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : policies.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
          <Shield className="h-10 w-10 mb-3 opacity-40" />
          <p className="text-sm font-medium">No policies defined</p>
          <p className="text-xs mt-1">Create your first policy to govern agent behavior.</p>
        </div>
      ) : (
        <motion.div initial="hidden" animate="show" variants={stagger} className="grid gap-3">
          {policies.map((p) => {
            const type = p.action || p.type || "DENY";
            const tool = p.toolType || p.tool || "—";
            const env = p.environment || p.env || "—";
            const evals = p.evaluations ?? p.evaluationCount ?? 0;
            const lastTriggered = p.lastTriggered ?? (p.updatedAt ? new Date(p.updatedAt).toLocaleTimeString() : "—");

            return (
              <motion.div key={p.id} variants={fadeUp} className="rounded-xl border border-border bg-card p-5 hover:bg-accent/30 transition-colors cursor-pointer">
                <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                      <Shield className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="text-sm font-semibold">{p.name}</h3>
                        <Badge variant="outline" className={`text-[10px] font-mono gap-1 ${typeStyleMap[type] || "text-muted-foreground"}`}>
                          {typeIconMap[type] || null} {type}
                        </Badge>
                        {p.active === false && <Badge variant="outline" className="text-[10px] text-muted-foreground">INACTIVE</Badge>}
                      </div>
                      <p className="text-xs text-muted-foreground font-mono mt-0.5">{(p.id || "").slice(0, 16)} · v{p.version ?? 1} · {tool} · {env}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-5 text-xs text-muted-foreground">
                    <span className="font-mono">{Number(evals).toLocaleString()} evals</span>
                    <span className="flex items-center gap-1"><Clock className="h-3 w-3" /> {lastTriggered}</span>
                  </div>
                </div>
              </motion.div>
            );
          })}
        </motion.div>
      )}
    </div>
  );
}
