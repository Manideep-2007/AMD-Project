import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type StatusType = "running" | "completed" | "failed" | "pending" | "queued" | "escalated" | "healthy" | "degraded" | "stalled";

const statusStyles: Record<StatusType, string> = {
  running: "bg-primary/15 text-primary border-primary/30",
  healthy: "bg-success/15 text-success border-success/30",
  completed: "bg-success/15 text-success border-success/30",
  pending: "bg-muted text-muted-foreground border-border",
  queued: "bg-muted text-muted-foreground border-border",
  failed: "bg-destructive/15 text-destructive border-destructive/30",
  escalated: "bg-warning/15 text-warning border-warning/30",
  degraded: "bg-warning/15 text-warning border-warning/30",
  stalled: "bg-destructive/15 text-destructive border-destructive/30",
};

export function StatusBadge({ status, pulse }: { status: StatusType; pulse?: boolean }) {
  return (
    <Badge variant="outline" className={cn("text-[11px] font-mono uppercase tracking-wider gap-1.5", statusStyles[status])}>
      {(status === "running" || pulse) && (
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-75" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
        </span>
      )}
      {status}
    </Badge>
  );
}
