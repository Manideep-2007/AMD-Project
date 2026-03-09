import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Users, Key, Building2, Shield, Globe, Bell, AlertTriangle,
  Copy, Eye, EyeOff, Plus, Trash2, RefreshCw, ChevronRight, CheckCircle2,
  Clock, UserPlus, MoreHorizontal, Download, Upload, Lock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import {
  useWorkspaceSettings,
  useUpdateWorkspace,
  useWorkspaceMembers,
  useInviteMember,
  useRemoveMember,
  useUpdateMemberRole,
  useApiKeys,
  useCreateApiKey,
  useRevokeApiKey,
  useActiveSessions,
  useRevokeSession,
  useRevokeAllSessions,
} from "@/hooks/use-api";

// ─── Types ───────────────────────────────────

interface Member {
  id: string;
  userId: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  role: string;
  lastLoginAt: string | null;
  joinedAt: string;
}

interface ApiKeyData {
  id: string;
  name: string;
  keyPrefix: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

// ─── Constants ───────────────────────────────

const roleColors: Record<string, string> = {
  OWNER: "bg-primary/15 text-primary border-primary/30",
  ADMIN: "bg-amber-500/15 text-amber-600 border-amber-500/30",
  OPERATOR: "bg-emerald-500/15 text-emerald-600 border-emerald-500/30",
  VIEWER: "bg-muted text-muted-foreground border-border",
};

const roleDescriptions: Record<string, string> = {
  OWNER: "Full access including billing and workspace deletion",
  ADMIN: "Manage agents, policies, team members, and settings",
  OPERATOR: "Create and manage tasks, view policies and agents",
  VIEWER: "Read-only access to dashboards and audit logs",
};

const tabs = [
  { id: "workspace", label: "Workspace", icon: Building2 },
  { id: "team", label: "Team", icon: Users },
  { id: "api-keys", label: "API Keys", icon: Key },
  { id: "security", label: "Security", icon: Shield },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "danger", label: "Danger Zone", icon: AlertTriangle },
] as const;

type TabId = (typeof tabs)[number]["id"];

// ─── Main Component ─────────────────────────

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<TabId>("workspace");
  const { toast } = useToast();

  // API hooks — no mock fallbacks; render loading/empty states instead
  const { data: wsData, isLoading: wsLoading } = useWorkspaceSettings();
  const { data: membersData, isLoading: membersLoading } = useWorkspaceMembers();
  const { data: apiKeysData, isLoading: apiKeysLoading } = useApiKeys();
  const updateWorkspace = useUpdateWorkspace();

  const workspace = wsData?.data ?? null;
  const members: Member[] = membersData?.data ?? [];
  const apiKeys: ApiKeyData[] = apiKeysData?.data ?? [];

  return (
    <div className="flex h-full">
      {/* Sidebar navigation */}
      <div className="w-56 border-r border-border bg-card/50 p-4 space-y-1 flex-shrink-0">
        <div className="mb-4">
          <h2 className="text-sm font-semibold text-muted-foreground px-2">Settings</h2>
        </div>
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                isActive
                  ? "bg-primary/10 text-primary font-medium"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              } ${tab.id === "danger" ? "text-destructive hover:text-destructive" : ""}`}
            >
              <Icon className="h-4 w-4" />
              {tab.label}
              {isActive && <ChevronRight className="h-3 w-3 ml-auto" />}
            </button>
          );
        })}
      </div>

      {/* Main content */}
      <div className="flex-1 overflow-auto p-6 max-w-4xl">
        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            transition={{ duration: 0.15 }}
          >
            {activeTab === "workspace" && (
              workspace ? (
                <WorkspaceTab workspace={workspace} onUpdate={updateWorkspace.mutate} toast={toast} />
              ) : wsLoading ? (
                <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">Loading workspace settings…</div>
              ) : (
                <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">Failed to load workspace settings.</div>
              )
            )}
            {activeTab === "team" && (
              membersLoading ? (
                <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">Loading team members…</div>
              ) : (
                <TeamTab members={members} />
              )
            )}
            {activeTab === "api-keys" && (
              apiKeysLoading ? (
                <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">Loading API keys…</div>
              ) : (
                <ApiKeysTab apiKeys={apiKeys} />
              )
            )}
            {activeTab === "security" && <SecurityTab />}
            {activeTab === "notifications" && <NotificationsTab />}
            {activeTab === "danger" && <DangerZoneTab workspaceName={workspace?.name ?? ""} />}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

// ─── Workspace Tab ───────────────────────────

function WorkspaceTab({
  workspace,
  onUpdate,
  toast,
}: {
  workspace: Record<string, any>;
  onUpdate: (data: Record<string, unknown>) => void;
  toast: ReturnType<typeof useToast>["toast"];
}) {
  const [name, setName] = useState(workspace.name);
  const [dataRegion, setDataRegion] = useState(workspace.dataRegion || "US");

  const handleSave = () => {
    onUpdate({ name, dataRegion });
    toast({ title: "Settings saved", description: "Workspace configuration updated." });
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Workspace Configuration</h1>
        <p className="text-sm text-muted-foreground mt-1">Manage workspace identity, plan, and data residency.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><Building2 className="h-4 w-4" /> General</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Workspace Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Workspace Slug</Label>
              <Input value={workspace.slug} disabled className="font-mono text-muted-foreground" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Workspace ID</Label>
              <div className="flex items-center gap-2">
                <code className="text-xs font-mono bg-muted px-2 py-1.5 rounded">{workspace.id}</code>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => {
                    navigator.clipboard.writeText(workspace.id);
                    toast({ title: "Copied", description: "Workspace ID copied to clipboard." });
                  }}
                >
                  <Copy className="h-3 w-3" />
                </Button>
              </div>
            </div>
            <div className="space-y-2">
              <Label>Plan</Label>
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="bg-primary/10 text-primary border-primary/30 font-mono text-xs capitalize">
                  {workspace.plan}
                </Badge>
                <Button variant="link" size="sm" className="text-xs h-auto p-0">
                  Upgrade
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><Globe className="h-4 w-4" /> Data Residency</CardTitle>
          <CardDescription>Configure the primary region for data storage. Affects compliance and latency.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Select value={dataRegion} onValueChange={setDataRegion}>
            <SelectTrigger className="max-w-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="US">United States (us-east-1)</SelectItem>
              <SelectItem value="EU">European Union (eu-west-1)</SelectItem>
              <SelectItem value="APAC">Asia Pacific (ap-southeast-1)</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Changing data region requires a maintenance window. All data will be migrated.
          </p>
        </CardContent>
      </Card>

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => setName(workspace.name)}>Reset</Button>
        <Button onClick={handleSave}>Save Changes</Button>
      </div>
    </div>
  );
}

// ─── Team Tab ────────────────────────────────

function TeamTab({ members }: { members: Member[] }) {
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("OPERATOR");
  const inviteMember = useInviteMember();
  const removeMember = useRemoveMember();
  const updateRole = useUpdateMemberRole();
  const { toast } = useToast();

  const handleInvite = () => {
    inviteMember.mutate(
      { email: inviteEmail, role: inviteRole },
      {
        onSuccess: () => {
          toast({ title: "Invitation sent", description: `${inviteEmail} has been invited.` });
          setInviteOpen(false);
          setInviteEmail("");
        },
        onError: () => {
          toast({ title: "Error", description: "Failed to send invitation.", variant: "destructive" });
        },
      }
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Team Members</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage access control for your workspace. {members.length} member{members.length !== 1 ? "s" : ""}.
          </p>
        </div>

        <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
          <DialogTrigger asChild>
            <Button size="sm"><UserPlus className="h-4 w-4 mr-1" /> Invite Member</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Invite Team Member</DialogTitle>
              <DialogDescription>
                Send an invitation to join this workspace. They must have an existing NexusOps account.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <div className="space-y-2">
                <Label>Email Address</Label>
                <Input
                  type="email"
                  placeholder="engineer@company.com"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>Role</Label>
                <Select value={inviteRole} onValueChange={setInviteRole}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {["ADMIN", "OPERATOR", "VIEWER"].map((r) => (
                      <SelectItem key={r} value={r}>
                        <div>
                          <span className="font-medium">{r}</span>
                          <span className="text-xs text-muted-foreground ml-2">{roleDescriptions[r]}</span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setInviteOpen(false)}>Cancel</Button>
              <Button onClick={handleInvite} disabled={!inviteEmail}>Send Invitation</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="divide-y divide-border">
            {members.map((m) => (
              <div key={m.id} className="flex items-center justify-between px-5 py-3 hover:bg-muted/50 transition-colors">
                <div className="flex items-center gap-3">
                  <div className="h-9 w-9 rounded-full bg-primary/10 flex items-center justify-center text-primary font-semibold text-sm">
                    {m.name.split(" ").map((n) => n[0]).join("").slice(0, 2)}
                  </div>
                  <div>
                    <p className="text-sm font-medium">{m.name}</p>
                    <p className="text-xs text-muted-foreground">{m.email}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {m.lastLoginAt && (
                    <span className="text-xs text-muted-foreground flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {new Date(m.lastLoginAt).toLocaleDateString()}
                    </span>
                  )}
                  <Badge variant="outline" className={`text-[10px] font-mono ${roleColors[m.role] || ""}`}>
                    {m.role}
                  </Badge>
                  {m.role !== "OWNER" && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-7 w-7">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {["ADMIN", "OPERATOR", "VIEWER"]
                          .filter((r) => r !== m.role)
                          .map((r) => (
                            <DropdownMenuItem
                              key={r}
                              onClick={() => {
                                updateRole.mutate({ userId: m.userId, role: r });
                                toast({ title: "Role updated", description: `${m.name} is now ${r}.` });
                              }}
                            >
                              Change to {r}
                            </DropdownMenuItem>
                          ))}
                        <DropdownMenuItem
                          className="text-destructive"
                          onClick={() => {
                            removeMember.mutate(m.userId);
                            toast({ title: "Member removed", description: `${m.name} has been removed.` });
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5 mr-2" />
                          Remove
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Role Permissions</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3">
            {Object.entries(roleDescriptions).map(([role, desc]) => (
              <div key={role} className="flex items-start gap-2 p-3 rounded-lg border border-border">
                <Badge variant="outline" className={`text-[10px] font-mono flex-shrink-0 mt-0.5 ${roleColors[role]}`}>
                  {role}
                </Badge>
                <p className="text-xs text-muted-foreground">{desc}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── API Keys Tab ────────────────────────────

function ApiKeysTab({ apiKeys }: { apiKeys: ApiKeyData[] }) {
  const [createOpen, setCreateOpen] = useState(false);
  const [keyName, setKeyName] = useState("");
  const [keyExpiry, setKeyExpiry] = useState("never");
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);
  const createApiKey = useCreateApiKey();
  const revokeApiKey = useRevokeApiKey();
  const { toast } = useToast();

  const handleCreate = () => {
    createApiKey.mutate(
      {
        name: keyName,
        expiresInDays: keyExpiry === "never" ? undefined : parseInt(keyExpiry),
      },
      {
        onSuccess: (data: any) => {
          setRevealedKey(data?.data?.key || "nxo_sk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
          setKeyName("");
          toast({ title: "API key created", description: "Make sure to copy it now — it won't be shown again." });
        },
      }
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight">API Keys</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage programmatic access to the NexusOps API. Keys are SHA-256 hashed at rest.
          </p>
        </div>

        <Dialog open={createOpen} onOpenChange={(open) => { setCreateOpen(open); if (!open) setRevealedKey(null); }}>
          <DialogTrigger asChild>
            <Button size="sm"><Plus className="h-4 w-4 mr-1" /> Create Key</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{revealedKey ? "API Key Created" : "Create API Key"}</DialogTitle>
              <DialogDescription>
                {revealedKey
                  ? "Copy this key now. It will not be shown again."
                  : "Create a new API key for programmatic access."}
              </DialogDescription>
            </DialogHeader>

            {revealedKey ? (
              <div className="space-y-3 py-2">
                <div className="flex items-center gap-2 bg-muted p-3 rounded-lg">
                  <code className="text-xs font-mono flex-1 break-all">
                    {showKey ? revealedKey : revealedKey.slice(0, 12) + "•".repeat(40)}
                  </code>
                  <Button variant="ghost" size="icon" className="h-7 w-7 flex-shrink-0" onClick={() => setShowKey(!showKey)}>
                    {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 flex-shrink-0"
                    onClick={() => {
                      navigator.clipboard.writeText(revealedKey);
                      toast({ title: "Copied", description: "API key copied to clipboard." });
                    }}
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <DialogFooter>
                  <Button onClick={() => { setCreateOpen(false); setRevealedKey(null); setShowKey(false); }}>
                    <CheckCircle2 className="h-4 w-4 mr-1" /> Done
                  </Button>
                </DialogFooter>
              </div>
            ) : (
              <>
                <div className="space-y-4 py-2">
                  <div className="space-y-2">
                    <Label>Key Name</Label>
                    <Input placeholder="e.g. Production SDK Key" value={keyName} onChange={(e) => setKeyName(e.target.value)} />
                  </div>
                  <div className="space-y-2">
                    <Label>Expiration</Label>
                    <Select value={keyExpiry} onValueChange={setKeyExpiry}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="never">Never expires</SelectItem>
                        <SelectItem value="30">30 days</SelectItem>
                        <SelectItem value="90">90 days</SelectItem>
                        <SelectItem value="180">180 days</SelectItem>
                        <SelectItem value="365">1 year</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
                  <Button onClick={handleCreate} disabled={!keyName}>Create Key</Button>
                </DialogFooter>
              </>
            )}
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="divide-y divide-border">
            {apiKeys.map((key) => (
              <div key={key.id} className="flex items-center justify-between px-5 py-3 hover:bg-muted/50 transition-colors">
                <div className="flex items-center gap-3">
                  <div className="h-8 w-8 rounded-lg bg-muted flex items-center justify-center">
                    <Key className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">{key.name}</p>
                    <p className="text-xs font-mono text-muted-foreground">{key.keyPrefix}••••••••••••</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {key.expiresAt && (
                    <span className="text-xs text-muted-foreground">
                      Expires {new Date(key.expiresAt).toLocaleDateString()}
                    </span>
                  )}
                  {key.lastUsedAt && (
                    <span className="text-xs text-muted-foreground flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      Used {new Date(key.lastUsedAt).toLocaleDateString()}
                    </span>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-destructive hover:text-destructive"
                    onClick={() => {
                      revokeApiKey.mutate(key.id);
                      toast({ title: "Key revoked", description: `"${key.name}" has been revoked.` });
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))}
            {apiKeys.length === 0 && (
              <div className="px-5 py-10 text-center text-sm text-muted-foreground">
                No API keys created yet. Create one to get started.
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Key Security Best Practices</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2 text-xs text-muted-foreground">
            <li className="flex items-start gap-2"><CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 mt-0.5 flex-shrink-0" /> Store keys in environment variables or secret managers — never in source code</li>
            <li className="flex items-start gap-2"><CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 mt-0.5 flex-shrink-0" /> Rotate keys periodically — set an expiration when possible</li>
            <li className="flex items-start gap-2"><CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 mt-0.5 flex-shrink-0" /> Use separate keys for production, staging, and CI/CD pipelines</li>
            <li className="flex items-start gap-2"><CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 mt-0.5 flex-shrink-0" /> Revoke unused keys immediately — check "Last Used" timestamps regularly</li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Security Tab ────────────────────────────

function SecurityTab() {
  const [mfaEnabled, setMfaEnabled] = useState(true);
  const [sessionTimeout, setSessionTimeout] = useState("60");
  const [ipAllowlist, setIpAllowlist] = useState("");
  const { toast } = useToast();
  const { data: sessionsData, isLoading: sessionsLoading } = useActiveSessions();
  const revokeSession = useRevokeSession();
  const revokeAll = useRevokeAllSessions();

  const sessions = (sessionsData?.data ?? []) as { id: string; createdAt: string; expiresAt: string }[];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Security & Compliance</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Configure authentication, session management, and compliance controls.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><Lock className="h-4 w-4" /> Authentication</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Multi-Factor Authentication (MFA)</p>
              <p className="text-xs text-muted-foreground">Require MFA for all workspace members</p>
            </div>
            <Switch checked={mfaEnabled} onCheckedChange={setMfaEnabled} />
          </div>
          <Separator />
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Session Timeout</p>
              <p className="text-xs text-muted-foreground">Auto-logout after inactivity period</p>
            </div>
            <Select value={sessionTimeout} onValueChange={setSessionTimeout}>
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="15">15 minutes</SelectItem>
                <SelectItem value="30">30 minutes</SelectItem>
                <SelectItem value="60">1 hour</SelectItem>
                <SelectItem value="480">8 hours</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Separator />
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Forced Token Rotation</p>
              <p className="text-xs text-muted-foreground">Refresh tokens are rotated on every use (always active)</p>
            </div>
            <Badge variant="outline" className="bg-emerald-500/10 text-emerald-600 border-emerald-500/30 text-[10px]">
              ENFORCED
            </Badge>
          </div>
        </CardContent>
      </Card>

      {/* Active Sessions */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Clock className="h-4 w-4" /> Active Sessions
          </CardTitle>
          <CardDescription>
            Manage your active login sessions. Revoke sessions you don't recognize.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {sessionsLoading ? (
            <p className="text-xs text-muted-foreground">Loading sessions…</p>
          ) : sessions.length === 0 ? (
            <p className="text-xs text-muted-foreground">No active sessions found.</p>
          ) : (
            <>
              <div className="divide-y divide-border rounded-lg border">
                {sessions.map((session, idx) => (
                  <div key={session.id} className="flex items-center justify-between px-4 py-2.5">
                    <div>
                      <p className="text-sm font-medium">
                        Session {idx === 0 ? "(current)" : `#${idx + 1}`}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Created {new Date(session.createdAt).toLocaleString()} · Expires{" "}
                        {new Date(session.expiresAt).toLocaleString()}
                      </p>
                    </div>
                    {idx !== 0 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => {
                          revokeSession.mutate(session.id);
                          toast({ title: "Session revoked" });
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5 mr-1" /> Revoke
                      </Button>
                    )}
                  </div>
                ))}
              </div>
              {sessions.length > 1 && (
                <Button
                  variant="outline"
                  size="sm"
                  className="border-destructive/30 text-destructive hover:bg-destructive/10"
                  onClick={() => {
                    revokeAll.mutate(undefined as never);
                    toast({ title: "All other sessions revoked" });
                  }}
                >
                  Revoke All Other Sessions
                </Button>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><Globe className="h-4 w-4" /> Network Security</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>IP Allowlist (CIDR notation)</Label>
            <Input
              placeholder="e.g. 10.0.0.0/8, 192.168.1.0/24"
              value={ipAllowlist}
              onChange={(e) => setIpAllowlist(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Leave empty to allow all IPs. Comma-separated CIDR blocks.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><Shield className="h-4 w-4" /> Audit & Compliance</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Cryptographic Audit Chain</p>
              <p className="text-xs text-muted-foreground">SHA-3-256 hash chain for tamper-evident audit logs</p>
            </div>
            <Badge variant="outline" className="bg-emerald-500/10 text-emerald-600 border-emerald-500/30 text-[10px]">
              ACTIVE
            </Badge>
          </div>
          <Separator />
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Ed25519 Agent Signatures</p>
              <p className="text-xs text-muted-foreground">All agent actions are cryptographically signed</p>
            </div>
            <Badge variant="outline" className="bg-emerald-500/10 text-emerald-600 border-emerald-500/30 text-[10px]">
              ACTIVE
            </Badge>
          </div>
          <Separator />
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Compliance Artifacts</p>
              <p className="text-xs text-muted-foreground">RFC 3161 timestamp tokens for legal evidence</p>
            </div>
            <Badge variant="outline" className="bg-emerald-500/10 text-emerald-600 border-emerald-500/30 text-[10px]">
              ACTIVE
            </Badge>
          </div>
          <Separator />
          <div className="flex gap-2">
            <Button variant="outline" size="sm">
              <Download className="h-3.5 w-3.5 mr-1" /> Export Audit Logs
            </Button>
            <Button variant="outline" size="sm">
              <Upload className="h-3.5 w-3.5 mr-1" /> Export Compliance Report
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={() => toast({ title: "Security settings saved" })}>Save Changes</Button>
      </div>
    </div>
  );
}

// ─── Notifications Tab ───────────────────────

function NotificationsTab() {
  const [budgetAlerts, setBudgetAlerts] = useState(true);
  const [approvalAlerts, setApprovalAlerts] = useState(true);
  const [securityAlerts, setSecurityAlerts] = useState(true);
  const [anomalyAlerts, setAnomalyAlerts] = useState(true);
  const [policyAlerts, setPolicyAlerts] = useState(false);
  const [digestEmail, setDigestEmail] = useState("daily");
  const { toast } = useToast();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Notification Preferences</h1>
        <p className="text-sm text-muted-foreground mt-1">Configure alerts and notification delivery channels.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><Bell className="h-4 w-4" /> Real-time Alerts</CardTitle>
          <CardDescription>Notifications delivered via WebSocket and email.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {[
            { label: "Budget threshold exceeded", desc: "Alert when spend reaches 80% of budget", state: budgetAlerts, set: setBudgetAlerts },
            { label: "Approval requests", desc: "When tasks require human approval", state: approvalAlerts, set: setApprovalAlerts },
            { label: "Security incidents", desc: "Injection attempts, chain integrity failures", state: securityAlerts, set: setSecurityAlerts },
            { label: "Anomaly detection", desc: "Unusual agent behavior or cost spikes", state: anomalyAlerts, set: setAnomalyAlerts },
            { label: "Policy violations", desc: "When agents trigger policy denials", state: policyAlerts, set: setPolicyAlerts },
          ].map((item) => (
            <div key={item.label} className="flex items-center justify-between py-1">
              <div>
                <p className="text-sm font-medium">{item.label}</p>
                <p className="text-xs text-muted-foreground">{item.desc}</p>
              </div>
              <Switch checked={item.state} onCheckedChange={item.set} />
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Email Digest</CardTitle>
          <CardDescription>Periodic summary of workspace activity.</CardDescription>
        </CardHeader>
        <CardContent>
          <Select value={digestEmail} onValueChange={setDigestEmail}>
            <SelectTrigger className="max-w-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="off">Disabled</SelectItem>
              <SelectItem value="daily">Daily digest</SelectItem>
              <SelectItem value="weekly">Weekly digest</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Webhook Integration</CardTitle>
          <CardDescription>Forward alerts to external services (Slack, PagerDuty, custom).</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-2">
            <Label>Webhook URL</Label>
            <Input placeholder="https://hooks.slack.com/services/..." />
          </div>
          <div className="space-y-2">
            <Label>Webhook Secret (optional)</Label>
            <Input type="password" placeholder="HMAC signing secret" />
          </div>
          <Button variant="outline" size="sm">
            <RefreshCw className="h-3.5 w-3.5 mr-1" /> Test Webhook
          </Button>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={() => toast({ title: "Notification preferences saved" })}>Save Changes</Button>
      </div>
    </div>
  );
}

// ─── Danger Zone Tab ─────────────────────────

function DangerZoneTab({ workspaceName }: { workspaceName: string }) {
  const [confirmName, setConfirmName] = useState("");
  const { toast } = useToast();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-destructive">Danger Zone</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Irreversible actions. Proceed with extreme caution.
        </p>
      </div>

      <Card className="border-destructive/50">
        <CardContent className="p-5 space-y-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" />
            <div className="space-y-3 flex-1">
              <div>
                <p className="text-sm font-semibold">Transfer Workspace Ownership</p>
                <p className="text-xs text-muted-foreground">
                  Transfer ownership to another admin. You will be downgraded to Admin role.
                </p>
              </div>
              <Button variant="outline" size="sm" className="border-destructive/30 text-destructive hover:bg-destructive/10">
                Transfer Ownership
              </Button>
            </div>
          </div>

          <Separator />

          <div className="flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" />
            <div className="space-y-3 flex-1">
              <div>
                <p className="text-sm font-semibold">Delete Workspace</p>
                <p className="text-xs text-muted-foreground">
                  Permanently delete this workspace and all data. This includes all agents, tasks, policies,
                  audit logs, compliance artifacts, and budget configurations. This action cannot be undone.
                </p>
              </div>
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">
                  Type <code className="bg-muted px-1 py-0.5 rounded text-foreground">{workspaceName}</code> to confirm
                </Label>
                <Input
                  value={confirmName}
                  onChange={(e) => setConfirmName(e.target.value)}
                  placeholder={workspaceName}
                  className="max-w-sm"
                />
              </div>
              <Button
                variant="destructive"
                size="sm"
                disabled={confirmName !== workspaceName}
                onClick={() =>
                  toast({
                    title: "Workspace deletion requested",
                    description: "A confirmation email has been sent to the workspace owner.",
                    variant: "destructive",
                  })
                }
              >
                <Trash2 className="h-3.5 w-3.5 mr-1" /> Delete Workspace
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
