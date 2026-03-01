import { motion } from "framer-motion";
import { useCountUp } from "@/hooks/use-count-up";
import { cn } from "@/lib/utils";

interface MetricCardProps {
  label: string;
  value: number;
  prefix?: string;
  suffix?: string;
  decimals?: number;
  change?: number;
  icon: React.ReactNode;
  variant?: "default" | "primary" | "success" | "warning" | "destructive";
}

const variantStyles = {
  default: "border-border",
  primary: "border-primary/20 glow-blue",
  success: "border-success/20 glow-emerald",
  warning: "border-warning/20 glow-amber",
  destructive: "border-destructive/20",
};

export function MetricCard({ label, value, prefix = "", suffix = "", decimals = 0, change, icon, variant = "default" }: MetricCardProps) {
  const animatedValue = useCountUp(value, 1200, decimals);

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className={cn(
        "rounded-xl border bg-card p-5 transition-all hover:bg-accent/50",
        variantStyles[variant]
      )}
    >
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</span>
        <div className="text-muted-foreground">{icon}</div>
      </div>
      <div className="flex items-end gap-2">
        <span className="text-3xl font-bold font-mono tracking-tight text-foreground">
          {prefix}{animatedValue.toLocaleString()}{suffix}
        </span>
        {change !== undefined && (
          <span className={cn("text-xs font-mono mb-1", change >= 0 ? "text-success" : "text-destructive")}>
            {change >= 0 ? "+" : ""}{change}%
          </span>
        )}
      </div>
    </motion.div>
  );
}
