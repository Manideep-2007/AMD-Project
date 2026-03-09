/**
 * Intelligence Page — Cost intelligence, blast radius analytics, and AI governance insights.
 * Features:
 *   - Cost forecast charts (30/60/90 day projections with confidence bands)
 *   - Workspace blast radius summary — aggregate dollar exposure
 *   - Cost attribution treemap by agent/provider/model
 *   - Anomaly detection feed
 *   - Policy recommendation engine (based on observed patterns)
 */

import { useState } from "react";
import { motion } from "framer-motion";
import {
  TrendingUp,
  TrendingDown,
  Minus,
  DollarSign,
  BarChart3,
  AlertTriangle,
  Brain,
  Zap,
  Target,
  PieChart,
  ArrowUpRight,
  Loader2,
  Activity,
  Shield,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";

import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Cell,
} from "recharts";
import {
  useCostSummary,
  useCostForecast,
  useCostAttribution,
  useCostAnomalies,
  useBudgetSummary,
  useGovernanceRecommendations,
} from "@/hooks/use-api";

const fadeUp = { hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0 } };
const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.06 } } };

const COLORS = [
  "hsl(217, 91%, 60%)",
  "hsl(160, 84%, 39%)",
  "hsl(38, 92%, 50%)",
  "hsl(346, 87%, 43%)",
  "hsl(262, 83%, 58%)",
  "hsl(199, 89%, 48%)",
  "hsl(12, 76%, 61%)",
  "hsl(142, 71%, 45%)",
];

function TrendIcon({ trend }: { trend: string }) {
  switch (trend) {
    case "rising":
      return <TrendingUp className="h-4 w-4 text-destructive" />;
    case "falling":
      return <TrendingDown className="h-4 w-4 text-success" />;
    default:
      return <Minus className="h-4 w-4 text-muted-foreground" />;
  }
}

export default function Intelligence() {
  const [costPeriod, setCostPeriod] = useState("week");
  const [attributionGroup, setAttributionGroup] = useState("agent");

  // API hooks
  const { data: summaryData, isLoading: summaryLoading } = useCostSummary(costPeriod);
  const { data: forecastData, isLoading: forecastLoading } = useCostForecast();
  const { data: attributionData, isLoading: attrLoading } = useCostAttribution({ groupBy: attributionGroup });
  const { data: anomalyData } = useCostAnomalies();
  const { data: budgetData } = useBudgetSummary();
  const { data: recsData, isLoading: recsLoading } = useGovernanceRecommendations();

  const summary = summaryData?.data || {
    totalCost: 0,
    totalTokens: 0,
    totalRequests: 0,
    avgCostPerRequest: 0,
    topAgents: [],
    costByHour: [],
  };

  const forecasts = forecastData?.data?.forecasts || [];
  const attribution = attributionData?.data?.breakdown || [];
  const anomalies = anomalyData?.data?.anomalies || [];
  const budgetSummary = budgetData?.data || {};
  const recommendations: {
    id: string;
    title: string;
    description: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    category: string;
    agentId?: string;
    agentName?: string;
  }[] = recsData?.data?.recommendations || [];

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Intelligence</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Cost forecasting, blast radius analytics, and governance insights
          </p>
        </div>
        <div className="flex gap-1 p-1 rounded-lg bg-muted">
          {["today", "week", "month", "quarter"].map((p) => (
            <button
              key={p}
              onClick={() => setCostPeriod(p)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors capitalize ${
                costPeriod === p
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      {/* Top-level metrics */}
      <motion.div
        initial="hidden"
        animate="show"
        variants={stagger}
        className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4"
      >
        <motion.div variants={fadeUp} className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
            <DollarSign className="h-3.5 w-3.5 text-primary" />
            Total Cost ({costPeriod})
          </div>
          <p className="text-2xl font-bold">${summary.totalCost?.toFixed(2) || "0.00"}</p>
          <p className="text-[10px] text-muted-foreground mt-1">
            {summary.totalRequests} requests · {summary.totalTokens?.toLocaleString()} tokens
          </p>
        </motion.div>

        <motion.div variants={fadeUp} className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
            <Target className="h-3.5 w-3.5 text-warning" />
            Avg Cost / Request
          </div>
          <p className="text-2xl font-bold">${summary.avgCostPerRequest?.toFixed(4) || "0.0000"}</p>
          <p className="text-[10px] text-muted-foreground mt-1">Per tool call</p>
        </motion.div>

        <motion.div variants={fadeUp} className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
            <Activity className="h-3.5 w-3.5 text-destructive" />
            Anomalies Detected
          </div>
          <p className="text-2xl font-bold text-warning">{anomalies.length}</p>
          <p className="text-[10px] text-muted-foreground mt-1">Last 7 days (2σ threshold)</p>
        </motion.div>

        <motion.div variants={fadeUp} className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
            <Shield className="h-3.5 w-3.5 text-success" />
            Budget Utilization
          </div>
          <p className="text-2xl font-bold">
            {budgetSummary.utilizationPercent ? `${budgetSummary.utilizationPercent}%` : "—"}
          </p>
          <p className="text-[10px] text-muted-foreground mt-1">
            {budgetSummary.remaining ? `$${budgetSummary.remaining?.toFixed(2)} remaining` : "No budgets set"}
          </p>
        </motion.div>
      </motion.div>

      {/* Cost Trend Chart */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
        className="rounded-xl border border-border bg-card p-5"
      >
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-sm font-semibold">Cost & Token Trend</h2>
            <p className="text-xs text-muted-foreground">
              {costPeriod === "today" ? "Hourly" : "Daily"} breakdown for selected period
            </p>
          </div>
          <div className="flex gap-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-primary" /> Cost ($)
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-success" /> Tokens (K)
            </span>
          </div>
        </div>
        {summaryLoading ? (
          <div className="flex items-center justify-center h-[220px]">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : summary.costByHour?.length > 0 ? (
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={summary.costByHour}>
              <defs>
                <linearGradient id="gradCostInt" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="hsl(217,91%,60%)" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="hsl(217,91%,60%)" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="gradTokensInt" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="hsl(160,84%,39%)" stopOpacity={0.2} />
                  <stop offset="100%" stopColor="hsl(160,84%,39%)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(230,10%,20%)" />
              <XAxis
                dataKey="hour"
                tick={{ fontSize: 10, fill: "hsl(220,10%,50%)" }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v) => v.slice(-5)}
              />
              <YAxis tick={{ fontSize: 10, fill: "hsl(220,10%,50%)" }} axisLine={false} tickLine={false} />
              <Tooltip
                contentStyle={{
                  backgroundColor: "hsl(230,14%,8%)",
                  border: "1px solid hsl(230,10%,16%)",
                  borderRadius: 8,
                  fontSize: 12,
                }}
                formatter={((value: any, name: any) => [
                  name === "cost" ? `$${(value ?? 0).toFixed(2)}` : `${((value ?? 0) / 1000).toFixed(1)}K`,
                  name === "cost" ? "Cost" : "Tokens",
                ]) as any}
              />
              <Area type="monotone" dataKey="cost" stroke="hsl(217,91%,60%)" fill="url(#gradCostInt)" strokeWidth={2} />
              <Area type="monotone" dataKey="tokens" stroke="hsl(160,84%,39%)" fill="url(#gradTokensInt)" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex items-center justify-center h-[220px] text-muted-foreground text-sm">
            No cost data for selected period
          </div>
        )}
      </motion.div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Cost Forecast */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="rounded-xl border border-border bg-card p-5"
        >
          <div className="flex items-center gap-2 mb-4">
            <Brain className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold">Cost Forecast</h2>
          </div>
          {forecastLoading ? (
            <div className="flex items-center justify-center h-40">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : forecasts.length > 0 ? (
            <div className="space-y-4">
              <div className="flex items-center gap-2 mb-2">
                <TrendIcon trend={forecastData?.data?.trend} />
                <span className="text-xs text-muted-foreground capitalize">
                  {forecastData?.data?.trend || "stable"} trend
                </span>
                <span className="text-xs text-muted-foreground ml-auto">
                  Based on {forecastData?.data?.historicalDays || 0} days of data
                </span>
              </div>
              <div className="grid grid-cols-3 gap-3">
                {forecasts.map((f: any) => (
                  <div key={f.period} className="rounded-lg border border-border bg-muted/30 p-3">
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium">
                      {f.period}
                    </p>
                    <p className="text-lg font-bold mt-1">${f.projectedCost?.toFixed(0) || 0}</p>
                    <div className="text-[10px] text-muted-foreground mt-1 space-y-0.5">
                      <p>
                        Range: ${f.lowerBound?.toFixed(0)} – ${f.upperBound?.toFixed(0)}
                      </p>
                      <p>Confidence: {((f.confidence || 0) * 100).toFixed(0)}%</p>
                      <p>Daily rate: ${f.dailyRate?.toFixed(2)}/day</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-40 text-muted-foreground">
              <BarChart3 className="h-8 w-8 mb-2 opacity-30" />
              <p className="text-sm">Insufficient data for forecasting</p>
              <p className="text-xs mt-1">Need at least 3 days of cost history</p>
            </div>
          )}
        </motion.div>

        {/* Cost Attribution */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.35 }}
          className="rounded-xl border border-border bg-card p-5"
        >
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <PieChart className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold">Cost Attribution</h2>
            </div>
            <div className="flex gap-1 p-0.5 rounded-md bg-muted">
              {["agent", "provider", "model", "tool"].map((g) => (
                <button
                  key={g}
                  onClick={() => setAttributionGroup(g)}
                  className={`px-2 py-1 text-[10px] font-medium rounded capitalize transition-colors ${
                    attributionGroup === g
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground"
                  }`}
                >
                  {g}
                </button>
              ))}
            </div>
          </div>
          {attrLoading ? (
            <div className="flex items-center justify-center h-48">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : attribution.length > 0 ? (
            <div className="space-y-2">
              <ResponsiveContainer width="100%" height={160}>
                <BarChart data={attribution.slice(0, 8)} layout="vertical">
                  <XAxis type="number" tick={{ fontSize: 10, fill: "hsl(220,10%,50%)" }} axisLine={false} tickLine={false} />
                  <YAxis
                    type="category"
                    dataKey="label"
                    width={100}
                    tick={{ fontSize: 10, fill: "hsl(220,10%,50%)" }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "hsl(230,14%,8%)",
                      border: "1px solid hsl(230,10%,16%)",
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                    formatter={((value: any) => [`$${(value ?? 0).toFixed(2)}`, "Cost"]) as any}
                  />
                  <Bar dataKey="cost" radius={[0, 4, 4, 0]}>
                    {attribution.slice(0, 8).map((_: any, i: number) => (
                      <Cell key={i} fill={COLORS[i % COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
              <div className="flex flex-wrap gap-2 pt-2">
                {attribution.slice(0, 5).map((item: any, i: number) => (
                  <div key={item.key} className="flex items-center gap-1.5 text-[10px]">
                    <span
                      ref={(el) => { if (el) el.style.backgroundColor = COLORS[i % COLORS.length]; }}
                      className="h-2 w-2 rounded-full"
                    />
                    <span className="text-muted-foreground">{item.label}</span>
                    <span className="font-mono font-medium">{item.percentage}%</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-48 text-muted-foreground">
              <PieChart className="h-8 w-8 mb-2 opacity-30" />
              <p className="text-sm">No attribution data yet</p>
            </div>
          )}
        </motion.div>
      </div>

      {/* Anomalies Feed — always visible */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.4 }}
        className={`rounded-xl border bg-card p-5 ${anomalies.length > 0 ? 'border-warning/30' : 'border-border'}`}
      >
        <div className="flex items-center gap-2 mb-4">
          <AlertTriangle className={`h-4 w-4 ${anomalies.length > 0 ? 'text-warning' : 'text-muted-foreground'}`} />
          <h2 className="text-sm font-semibold">Cost Anomalies</h2>
          <Badge
            variant="outline"
            className={`text-[10px] ml-auto ${anomalies.length > 0 ? 'text-warning border-warning/30' : 'text-muted-foreground'}`}
          >
            {anomalies.length} detected
          </Badge>
        </div>
        {anomalies.length > 0 ? (
          <div className="space-y-2">
            {anomalies.slice(0, 8).map((anomaly: any, i: number) => (
              <div
                key={i}
                className={`flex items-center justify-between px-3 py-2.5 rounded-lg border ${
                  anomaly.severity === "critical"
                    ? "border-destructive/20 bg-destructive/5"
                    : "border-warning/20 bg-warning/5"
                }`}
              >
                <div className="flex items-center gap-3">
                  <Badge
                    variant="outline"
                    className={`text-[10px] ${
                      anomaly.severity === "critical"
                        ? "text-destructive border-destructive/30"
                        : "text-warning border-warning/30"
                    }`}
                  >
                    {anomaly.severity?.toUpperCase()}
                  </Badge>
                  <span className="text-xs font-mono text-muted-foreground">
                    {anomaly.hour}:00
                  </span>
                </div>
                <div className="flex items-center gap-4 text-xs">
                  <span className="font-mono">
                    <span className="text-muted-foreground">Cost: </span>
                    <span className="text-foreground font-bold">${anomaly.cost}</span>
                  </span>
                  <span className="font-mono">
                    <span className="text-muted-foreground">Expected: </span>
                    <span className="text-foreground">${anomaly.expected}</span>
                  </span>
                  <span className="font-mono">
                    <span className="text-muted-foreground">σ: </span>
                    <span className={anomaly.deviation > 3 ? "text-destructive" : "text-warning"}>
                      {anomaly.deviation}
                    </span>
                  </span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
            <Activity className="h-8 w-8 mb-2 opacity-20" />
            <p className="text-sm">No anomalies detected</p>
            <p className="text-xs mt-1 opacity-60">Cost patterns are within normal range (2σ threshold)</p>
          </div>
        )}
      </motion.div>

      {/* Policy Recommendations — data-driven */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.45 }}
        className="rounded-xl border border-border bg-card p-5"
      >
        <div className="flex items-center gap-2 mb-4">
          <Zap className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold">Governance Recommendations</h2>
          {recommendations.length > 0 && (
            <Badge variant="outline" className="text-[10px] ml-auto">
              {recommendations.length} action{recommendations.length !== 1 ? 's' : ''}
            </Badge>
          )}
        </div>
        {recsLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : recommendations.length > 0 ? (
          <div className="space-y-3">
            {recommendations.map((rec) => (
              <div
                key={rec.id}
                className="flex items-start gap-3 px-4 py-3 rounded-lg border border-border hover:bg-accent/30 transition-colors"
              >
                <div className={`mt-0.5 h-2 w-2 rounded-full shrink-0 ${
                  rec.severity === "critical" ? "bg-destructive" :
                  rec.severity === "high" ? "bg-orange-500" :
                  rec.severity === "medium" ? "bg-warning" : "bg-muted-foreground"
                }`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium">{rec.title}</p>
                    <Badge variant="outline" className="text-[10px] font-mono shrink-0">
                      {rec.category}
                    </Badge>
                    {rec.agentName && (
                      <Badge variant="secondary" className="text-[10px] shrink-0">{rec.agentName}</Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">{rec.description}</p>
                </div>
                <ArrowUpRight className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
            <Shield className="h-8 w-8 mb-2 opacity-20" />
            <p className="text-sm">No recommendations</p>
            <p className="text-xs mt-1 opacity-60">Your governance configuration looks healthy</p>
          </div>
        )}
      </motion.div>
    </div>
  );
}
