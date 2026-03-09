/**
 * Security Page — Comprehensive security posture dashboard.
 * Features:
 *   - Audit chain integrity verification with visual status
 *   - Compliance chain verification
 *   - Injection scan interface (paste text, get immediate results)
 *   - Compliance artifacts viewer with hash chains
 *   - Anomaly alert feed
 *   - Security event timeline
 */

import { useState } from "react";
import { motion } from "framer-motion";
import {
  Shield,
  ShieldCheck,
  ShieldAlert,
  ShieldX,
  Lock,
  Unlock,
  Link2,
  FileCheck,
  AlertTriangle,
  Search,
  Loader2,
  CheckCircle,

  Copy,
  Fingerprint,
  FileText,

} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  useSecurityOverview,
  useAuditChainVerification,
  useAuditChainNodes,
  useComplianceArtifacts,
  useScanText,
} from "@/hooks/use-api";

const fadeUp = { hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0 } };
const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.06 } } };

// ─── Chain Node Visualizer ──────────────────────
interface ChainNode {
  id: string;
  chainIndex: number;
  eventType: string;
  action: string;
  entityType: string;
  contentHash: string | null;
  previousHash: string | null;
  createdAt: string;
}

function ChainNodeDisplay({ nodes, valid }: { nodes: ChainNode[]; valid?: boolean }) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  if (!nodes.length) return null;

  function eventColor(eventType: string) {
    if (eventType.includes('violation') || eventType.includes('block')) return 'border-destructive/40 bg-destructive/5 text-destructive';
    if (eventType.includes('escalat') || eventType.includes('approval')) return 'border-warning/40 bg-warning/5 text-warning';
    if (eventType.includes('emergency')) return 'border-destructive/60 bg-destructive/10 text-destructive';
    return 'border-border bg-muted/30 text-muted-foreground';
  }

  return (
    <div className="overflow-x-auto pb-2">
      <div className="flex items-center gap-0 min-w-max py-2">
        {nodes.map((node, i) => (
          <div key={node.id} className="flex items-center">
            {/* Hash link line (not before first node) */}
            {i > 0 && (
              <div className={`h-px w-6 shrink-0 ${valid === false && nodes[i - 1]?.chainIndex === (node.chainIndex - 1) ? 'bg-destructive' : 'bg-border'}`} />
            )}
            {/* Node block */}
            <div
              className={`relative rounded-lg border px-3 py-2 cursor-pointer transition-all min-w-[112px] ${eventColor(node.eventType)} ${hoveredId === node.id ? 'scale-105 shadow-md z-10' : ''}`}
              onMouseEnter={() => setHoveredId(node.id)}
              onMouseLeave={() => setHoveredId(null)}
            >
              <p className="text-[9px] font-mono mb-1 opacity-60">#{node.chainIndex}</p>
              <p className="text-[10px] font-semibold truncate max-w-[88px]">{node.eventType.replace('workspace.', '').replace('agent.', '').replace('task.', '')}</p>
              {node.contentHash && (
                <p className="text-[8px] font-mono opacity-50 mt-1 truncate">{node.contentHash.slice(0, 10)}…</p>
              )}
              {/* Hover tooltip */}
              {hoveredId === node.id && (
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-20 w-52 rounded-lg border border-border bg-popover p-2 shadow-lg text-[10px] space-y-1 pointer-events-none">
                  <p className="font-semibold text-popover-foreground">{node.eventType}</p>
                  <p className="text-muted-foreground">{node.action} • {node.entityType}</p>
                  {node.contentHash && <p className="font-mono text-[9px] break-all text-muted-foreground">{node.contentHash}</p>}
                  <p className="text-muted-foreground">{new Date(node.createdAt).toLocaleString()}</p>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      <p className="text-[9px] text-muted-foreground mt-1">← older &nbsp; newer →</p>
    </div>
  );
}

function HashDisplay({ hash, label }: { hash: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    navigator.clipboard.writeText(hash);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex items-center gap-2 group">
      {label && <span className="text-[10px] text-muted-foreground w-16 shrink-0">{label}</span>}
      <code className="text-[11px] font-mono text-muted-foreground bg-muted rounded px-2 py-1 truncate max-w-[200px]">
        {hash}
      </code>
      <button
        onClick={copy}
        className="opacity-0 group-hover:opacity-100 transition-opacity"
      >
        {copied ? (
          <CheckCircle className="h-3 w-3 text-success" />
        ) : (
          <Copy className="h-3 w-3 text-muted-foreground hover:text-foreground" />
        )}
      </button>
    </div>
  );
}

export default function Security() {
  const [scanText, setScanText] = useState("");
  const [tab, setTab] = useState("overview");

  // API hooks
  const { data: overviewData } = useSecurityOverview();
  const { data: auditChainData, isLoading: chainLoading, refetch: verifyChain } = useAuditChainVerification();
  const { data: chainNodesData } = useAuditChainNodes(15);
  const { data: artifactsData, isLoading: artifactsLoading } = useComplianceArtifacts();
  const scanMutation = useScanText();

  const overview = overviewData?.data || {
    totalEvents: 0,
    policyViolations: 0,
    injectionAttempts: 0,
    chainIntegrity: "unknown",
    complianceScore: 0,
    activeAlerts: 0,
    lastScanAt: null,
  };

  const chainResult = auditChainData?.data || null;
  const chainNodes: ChainNode[] = chainNodesData?.data || [];
  const artifacts = artifactsData?.data || [];

  const handleScan = () => {
    if (!scanText.trim()) return;
    scanMutation.mutate({ text: scanText, strict: true });
  };

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Security</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Cryptographic integrity, injection detection, and compliance evidence
        </p>
      </div>

      {/* Security Posture Cards */}
      <motion.div
        initial="hidden"
        animate="show"
        variants={stagger}
        className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4"
      >
        <motion.div variants={fadeUp} className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 mb-3">
            {overview.chainIntegrity === "valid" ? (
              <ShieldCheck className="h-5 w-5 text-success" />
            ) : overview.chainIntegrity === "broken" ? (
              <ShieldX className="h-5 w-5 text-destructive" />
            ) : (
              <Shield className="h-5 w-5 text-muted-foreground" />
            )}
            <span className="text-xs font-medium text-muted-foreground">Chain Integrity</span>
          </div>
          <p className={`text-lg font-bold ${
            overview.chainIntegrity === "valid" ? "text-success" :
            overview.chainIntegrity === "broken" ? "text-destructive" :
            "text-muted-foreground"
          }`}>
            {overview.chainIntegrity === "valid" ? "Verified" :
             overview.chainIntegrity === "broken" ? "BROKEN" : "Unknown"}
          </p>
          <p className="text-[10px] text-muted-foreground mt-1">SHA-3 hash chain</p>
        </motion.div>

        <motion.div variants={fadeUp} className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 mb-3">
            <ShieldAlert className="h-5 w-5 text-destructive" />
            <span className="text-xs font-medium text-muted-foreground">Policy Violations</span>
          </div>
          <p className="text-lg font-bold text-destructive">{overview.policyViolations}</p>
          <p className="text-[10px] text-muted-foreground mt-1">Last 24 hours</p>
        </motion.div>

        <motion.div variants={fadeUp} className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 mb-3">
            <AlertTriangle className="h-5 w-5 text-warning" />
            <span className="text-xs font-medium text-muted-foreground">Injection Attempts</span>
          </div>
          <p className="text-lg font-bold text-warning">{overview.injectionAttempts}</p>
          <p className="text-[10px] text-muted-foreground mt-1">Blocked at gate</p>
        </motion.div>

        <motion.div variants={fadeUp} className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 mb-3">
            <FileCheck className="h-5 w-5 text-primary" />
            <span className="text-xs font-medium text-muted-foreground">Compliance Score</span>
          </div>
          <p className={`text-lg font-bold ${
            overview.complianceScore >= 90 ? "text-success" :
            overview.complianceScore >= 70 ? "text-warning" : "text-destructive"
          }`}>
            {overview.complianceScore || 0}%
          </p>
          <p className="text-[10px] text-muted-foreground mt-1">
            {overview.complianceScore >= 90 ? "Excellent" :
             overview.complianceScore >= 70 ? "Needs attention" : "Critical"}
          </p>
        </motion.div>
      </motion.div>

      {/* Tabs */}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="bg-muted">
          <TabsTrigger value="overview">Chain Integrity</TabsTrigger>
          <TabsTrigger value="scan">Injection Scanner</TabsTrigger>
          <TabsTrigger value="artifacts">Compliance Artifacts</TabsTrigger>
        </TabsList>

        {/* Chain Integrity Tab */}
        <TabsContent value="overview" className="mt-4 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Audit Event Hash Chain</h2>
            <Button
              variant="outline"
              size="sm"
              onClick={() => verifyChain()}
              disabled={chainLoading}
              className="gap-2"
            >
              {chainLoading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Link2 className="h-3.5 w-3.5" />
              )}
              Verify Chain
            </Button>
          </div>

          {chainResult ? (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="rounded-xl border border-border bg-card p-6 space-y-4"
            >
              <div className="flex items-center gap-3">
                {chainResult.valid ? (
                  <>
                    <div className="h-12 w-12 rounded-full bg-success/10 border border-success/20 flex items-center justify-center">
                      <Lock className="h-6 w-6 text-success" />
                    </div>
                    <div>
                      <p className="text-sm font-bold text-success">Chain Integrity Verified</p>
                      <p className="text-xs text-muted-foreground">
                        All {chainResult.totalEvents} events have valid SHA-3 hash links
                      </p>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="h-12 w-12 rounded-full bg-destructive/10 border border-destructive/20 flex items-center justify-center">
                      <Unlock className="h-6 w-6 text-destructive" />
                    </div>
                    <div>
                      <p className="text-sm font-bold text-destructive">Chain Integrity BROKEN</p>
                      <p className="text-xs text-muted-foreground">
                        {chainResult.brokenAt ? `Break detected at event index ${chainResult.brokenAt}` : "Hash chain has been tampered with"}
                      </p>
                    </div>
                  </>
                )}
              </div>

              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <div className="rounded-lg bg-muted/50 p-3">
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Total Events</p>
                  <p className="text-lg font-bold mt-1">{chainResult.totalEvents || 0}</p>
                </div>
                <div className="rounded-lg bg-muted/50 p-3">
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Verified</p>
                  <p className="text-lg font-bold mt-1 text-success">{chainResult.verified || 0}</p>
                </div>
                <div className="rounded-lg bg-muted/50 p-3">
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Hash Algorithm</p>
                  <p className="text-lg font-bold mt-1 font-mono">SHA3-256</p>
                </div>
                <div className="rounded-lg bg-muted/50 p-3">
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Signature</p>
                  <p className="text-lg font-bold mt-1 font-mono">Ed25519</p>
                </div>
              </div>

              {chainResult.latestHash && (
                <div className="pt-3 border-t border-border">
                  <HashDisplay hash={chainResult.latestHash} label="Latest" />
                </div>
              )}

              {/* Chain node visualizer */}
              {chainNodes.length > 0 && (
                <div className="pt-3 border-t border-border">
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                    Recent Chain Nodes (last {chainNodes.length})
                  </p>
                  <ChainNodeDisplay nodes={chainNodes} valid={chainResult.valid} />
                </div>
              )}
            </motion.div>
          ) : (
            <div className="space-y-4">
              {chainNodes.length > 0 && (
                <div className="rounded-xl border border-border bg-card p-4">
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-3">
                    Recent Chain Nodes (last {chainNodes.length})
                  </p>
                  <ChainNodeDisplay nodes={chainNodes} />
                </div>
              )}
              <div className="rounded-xl border border-border bg-card p-8 flex flex-col items-center justify-center text-muted-foreground">
                <Link2 className="h-8 w-8 mb-3 opacity-30" />
                <p className="text-sm">Click "Verify Chain" to check audit event integrity</p>
              </div>
            </div>
          )}
        </TabsContent>

        {/* Injection Scanner Tab */}
        <TabsContent value="scan" className="mt-4 space-y-4">
          <div className="rounded-xl border border-border bg-card p-6 space-y-4">
            <div className="flex items-center gap-2 mb-2">
              <Search className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold">Prompt Injection Scanner</h2>
            </div>
            <p className="text-xs text-muted-foreground">
              Paste any text to scan for 18 categories of injection attacks including: instruction overrides,
              system prompt extraction, delimiter injection, privilege escalation, encoding evasion,
              data exfiltration, SQL injection, and shell injection patterns.
            </p>

            <textarea
              value={scanText}
              onChange={(e) => setScanText(e.target.value)}
              placeholder="Paste agent input, prompt, or tool call payload to scan..."
              rows={6}
              className="w-full rounded-md border border-border bg-background px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary font-mono resize-none"
            />

            <div className="flex items-center gap-3">
              <Button
                onClick={handleScan}
                disabled={scanMutation.isPending || !scanText.trim()}
                className="gap-2"
              >
                {scanMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Fingerprint className="h-4 w-4" />
                )}
                Scan for Injections
              </Button>
              <Button variant="outline" onClick={() => { setScanText(""); scanMutation.reset(); }}>
                Clear
              </Button>
            </div>

            {/* Scan Results */}
            {scanMutation.data && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="border-t border-border pt-4 space-y-3"
              >
                {scanMutation.data.data?.threats?.length > 0 ? (
                  <>
                    <div className="flex items-center gap-2">
                      <ShieldX className="h-5 w-5 text-destructive" />
                      <p className="text-sm font-bold text-destructive">
                        {scanMutation.data.data.threats.length} Threat(s) Detected
                      </p>
                    </div>
                    <div className="space-y-2">
                      {scanMutation.data.data.threats.map((threat: any, i: number) => (
                        <div
                          key={i}
                          className="rounded-lg border border-destructive/20 bg-destructive/5 p-3"
                        >
                          <div className="flex items-center gap-2 mb-1">
                            <Badge
                              variant="outline"
                              className={`text-[10px] ${
                                threat.severity === "critical"
                                  ? "text-destructive border-destructive/30"
                                  : "text-warning border-warning/30"
                              }`}
                            >
                              {threat.severity?.toUpperCase()}
                            </Badge>
                            <span className="text-xs font-medium">{threat.category || threat.pattern}</span>
                          </div>
                          <p className="text-xs text-muted-foreground">{threat.description || threat.match}</p>
                          {threat.match && (
                            <code className="text-[10px] font-mono text-destructive/80 bg-destructive/10 rounded px-2 py-0.5 mt-1 inline-block">
                              {threat.match}
                            </code>
                          )}
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="h-5 w-5 text-success" />
                    <p className="text-sm font-bold text-success">No Threats Detected</p>
                  </div>
                )}

                <div className="text-[10px] text-muted-foreground">
                  Scanned {scanText.length} characters against 18 injection pattern categories
                </div>
              </motion.div>
            )}
          </div>
        </TabsContent>

        {/* Compliance Artifacts Tab */}
        <TabsContent value="artifacts" className="mt-4 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Compliance Evidence Vault</h2>
            <Badge variant="outline" className="text-[10px] font-mono">
              6-component artifacts
            </Badge>
          </div>

          {artifactsLoading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : (artifacts?.data || artifacts)?.length > 0 ? (
            <div className="space-y-3">
              {((artifacts?.data || artifacts) as any[]).slice(0, 20).map((artifact: any, i: number) => (
                <motion.div
                  key={artifact.id || i}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.03 }}
                  className="rounded-xl border border-border bg-card p-4"
                >
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <FileText className="h-4 w-4 text-primary" />
                      <span className="text-sm font-semibold">
                        {artifact.type || "ComplianceArtifact"}
                      </span>
                      <span className="text-[10px] font-mono text-muted-foreground">
                        {artifact.id?.slice(0, 8) || "—"}
                      </span>
                    </div>
                    <span className="text-[10px] text-muted-foreground">
                      {artifact.createdAt ? new Date(artifact.createdAt).toLocaleString() : "—"}
                    </span>
                  </div>

                  {/* 6-component breakdown */}
                  <div className="grid grid-cols-2 lg:grid-cols-3 gap-2 text-xs">
                    <div className="rounded bg-muted/50 p-2">
                      <span className="text-[10px] text-muted-foreground block">Decision</span>
                      <span className="font-mono">{artifact.decision || artifact.action || "—"}</span>
                    </div>
                    <div className="rounded bg-muted/50 p-2">
                      <span className="text-[10px] text-muted-foreground block">Policy</span>
                      <span className="font-mono">{artifact.policyName || artifact.ruleId || "—"}</span>
                    </div>
                    <div className="rounded bg-muted/50 p-2">
                      <span className="text-[10px] text-muted-foreground block">Agent</span>
                      <span className="font-mono">{artifact.agentId?.slice(0, 12) || "—"}</span>
                    </div>
                    <div className="rounded bg-muted/50 p-2">
                      <span className="text-[10px] text-muted-foreground block">Task</span>
                      <span className="font-mono">{artifact.taskId?.slice(0, 12) || "—"}</span>
                    </div>
                    <div className="rounded bg-muted/50 p-2">
                      <span className="text-[10px] text-muted-foreground block">Blast Radius</span>
                      <span className="font-mono">${artifact.blastRadius?.toFixed(2) || "0.00"}</span>
                    </div>
                    <div className="rounded bg-muted/50 p-2">
                      <span className="text-[10px] text-muted-foreground block">Chain Index</span>
                      <span className="font-mono">#{artifact.chainIndex || 0}</span>
                    </div>
                  </div>

                  {/* Hash chain display */}
                  {(artifact.contentHash || artifact.previousHash) && (
                    <div className="mt-3 pt-3 border-t border-border space-y-1">
                      {artifact.contentHash && (
                        <HashDisplay hash={artifact.contentHash} label="Content" />
                      )}
                      {artifact.previousHash && (
                        <HashDisplay hash={artifact.previousHash} label="Previous" />
                      )}
                    </div>
                  )}
                </motion.div>
              ))}
            </div>
          ) : (
            <div className="rounded-xl border border-border bg-card p-8 flex flex-col items-center justify-center text-muted-foreground">
              <FileCheck className="h-8 w-8 mb-3 opacity-30" />
              <p className="text-sm">No compliance artifacts yet</p>
              <p className="text-xs mt-1">Artifacts are auto-generated for each policy evaluation</p>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
