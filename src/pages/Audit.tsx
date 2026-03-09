import { useState, useMemo } from "react";
import { motion } from "framer-motion";
import { ScrollText, Filter, Loader2, RefreshCw, ChevronLeft, ChevronRight, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAuditEvents } from "@/hooks/use-api";

const typeColors: Record<string, string> = {
  POLICY_VIOLATION: "text-destructive",
  TASK_ESCALATED: "text-warning",
  AGENT_SPAWNED: "text-primary",
  TASK_COMPLETED: "text-success",
  AGENT_KILLED: "text-destructive",
  POLICY_UPDATED: "text-primary",
  TOOL_CALL: "text-muted-foreground",
};

const eventTypes = ["ALL", "POLICY_VIOLATION", "TASK_ESCALATED", "TASK_COMPLETED", "AGENT_SPAWNED", "AGENT_KILLED", "POLICY_UPDATED", "TOOL_CALL"];

const fadeUp = { hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0 } };
const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.03 } } };

export default function Audit() {
  const [page, setPage] = useState(1);
  const [typeFilter, setTypeFilter] = useState("ALL");

  const { data: auditData, isLoading, isError, refetch } = useAuditEvents({
    page,
    limit: 50,
    eventType: typeFilter !== "ALL" ? typeFilter : undefined,
  });

  const events = (auditData?.data?.items || auditData?.data || []) as any[];
  const totalPages = auditData?.totalPages || auditData?.data?.totalPages || 1;

  // Group events by type for counts
  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    events.forEach((e) => { counts[e.type || e.eventType || "UNKNOWN"] = (counts[e.type || e.eventType || "UNKNOWN"] || 0) + 1; });
    return counts;
  }, [events]);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2"><ScrollText className="h-6 w-6" /> Audit Log</h1>
          <p className="text-sm text-muted-foreground mt-1">Immutable event log — every action traced and attributed</p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="w-[180px] h-9 text-xs">
              <Filter className="h-3.5 w-3.5 mr-2" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {eventTypes.map((t) => (
                <SelectItem key={t} value={t} className="text-xs font-mono">
                  {t} {typeCounts[t] ? `(${typeCounts[t]})` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" className="gap-2" onClick={() => refetch()}>
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {isError && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" /> Failed to load audit events. Check API connection.
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : events.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
          <ScrollText className="h-10 w-10 mb-3 opacity-40" />
          <p className="text-sm font-medium">No audit events</p>
          <p className="text-xs mt-1">Events will appear here as agents interact with the system.</p>
        </div>
      ) : (
        <>
          <motion.div initial="hidden" animate="show" variants={stagger} className="rounded-xl border border-border bg-card overflow-hidden">
            <div className="grid-cols-[140px_140px_1fr_80px] gap-2 px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground border-b border-border hidden md:grid">
              <span>Timestamp</span><span>Type</span><span>Detail</span><span>Result</span>
            </div>
            {events.length === 0 && (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">No events match filter</div>
            )}
            {events.map((evt) => {
              const type = evt.type || evt.eventType || "UNKNOWN";
              const ts = evt.timestamp || evt.createdAt;
              const result = evt.result || evt.outcome || "—";
              return (
                <motion.div key={evt.id} variants={fadeUp} className="grid grid-cols-1 md:grid-cols-[140px_140px_1fr_80px] gap-2 px-4 py-3 items-center border-b border-border last:border-0 hover:bg-accent/30 transition-colors cursor-pointer">
                  <span className="text-[11px] font-mono text-muted-foreground">{ts ? new Date(ts).toLocaleTimeString() : "—"}</span>
                  <span className={`text-xs font-mono font-medium ${typeColors[type] || "text-foreground"}`}>{type}</span>
                  <div className="min-w-0">
                    <p className="text-sm truncate">{evt.detail || evt.description || "—"}</p>
                    <p className="text-[11px] text-muted-foreground font-mono">{evt.actor || evt.actorId || "system"} → {evt.action || "—"}</p>
                  </div>
                  <span className={`text-[11px] font-mono font-medium ${result === "DENIED" ? "text-destructive" : result === "ESCALATED" ? "text-warning" : "text-success"}`}>{result}</span>
                </motion.div>
              );
            })}
          </motion.div>

          {/* Pagination */}
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">Page {page} of {totalPages}</p>
            <div className="flex gap-1">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
