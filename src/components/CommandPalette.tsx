/**
 * CommandPalette — cmdk-powered command palette for NexusOps.
 * Features:
 *   - Ctrl+K / Cmd+K to open
 *   - Agent search & navigation
 *   - Page navigation
 *   - Quick-approve pending escalations
 *   - Emergency stop (kill all running agents)
 *   - Policy quick-create
 *   - Theme toggle
 */

import { useState, useEffect, useCallback } from "react";
import { Command } from "cmdk";
import { useNavigate } from "react-router-dom";
import { useTheme } from "next-themes";
import {
  LayoutDashboard,
  Bot,
  ListTodo,
  Shield,
  Wrench,
  ScrollText,
  Settings,
  ShieldAlert,
  Lock,
  Brain,
  Search,
  Sun,
  Moon,
  AlertOctagon,
  CheckCircle,
  Zap,
  LogOut,
  Plus,
} from "lucide-react";
import { useAuthStore } from "@/stores/auth-store";
import { useAgents, useEmergencyStopAgent } from "@/hooks/use-api";

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { theme, setTheme } = useTheme();
  const { logout } = useAuthStore();
  const { data: agentsData } = useAgents();
  const emergencyStopAll = useEmergencyStopAgent();
  const activeAgents = ((agentsData?.data?.items || agentsData?.data || []) as any[]).filter(
    (a: any) => a.status !== 'TERMINATED'
  );

  // Toggle with Ctrl+K / Cmd+K
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
      if (e.key === "Escape") {
        setOpen(false);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  const runCommand = useCallback(
    (command: () => void) => {
      setOpen(false);
      command();
    },
    []
  );

  return (
    <>
      {/* Trigger button (for non-keyboard users) */}
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-md border border-border bg-muted/50 text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
      >
        <Search className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">Search...</span>
        <kbd className="hidden sm:inline-flex h-5 items-center gap-0.5 rounded border border-border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground">
          ⌘K
        </kbd>
      </button>

      {/* Command palette dialog */}
      {open && (
        <div className="fixed inset-0 z-50">
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-black/50 backdrop-blur-sm"
            onClick={() => setOpen(false)}
          />

          {/* Command dialog */}
          <div className="fixed left-1/2 top-[20%] z-50 w-full max-w-lg -translate-x-1/2">
            <Command
              className="rounded-xl border border-border bg-card shadow-2xl overflow-hidden"
              label="NexusOps Command Palette"
            >
              <Command.Input
                placeholder="Type a command or search..."
                className="w-full border-b border-border bg-transparent px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground outline-none"
              />

              <Command.List className="max-h-[300px] overflow-y-auto p-2">
                <Command.Empty className="py-6 text-center text-sm text-muted-foreground">
                  No results found.
                </Command.Empty>

                {/* Navigation */}
                <Command.Group heading="Navigation" className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground px-2 py-1.5">
                  {[
                    { icon: LayoutDashboard, label: "Dashboard", to: "/" },
                    { icon: Bot, label: "Agents", to: "/agents" },
                    { icon: ListTodo, label: "Tasks", to: "/tasks" },
                    { icon: Shield, label: "Policies", to: "/policies" },
                    { icon: Wrench, label: "Tools", to: "/tools" },
                    { icon: ScrollText, label: "Audit Log", to: "/audit" },
                    { icon: ShieldAlert, label: "Approvals", to: "/approvals" },
                    { icon: Lock, label: "Security", to: "/security" },
                    { icon: Brain, label: "Intelligence", to: "/intelligence" },
                    { icon: Settings, label: "Settings", to: "/settings" },
                  ].map((item) => (
                    <Command.Item
                      key={item.to}
                      value={`Navigate to ${item.label}`}
                      onSelect={() => runCommand(() => navigate(item.to))}
                      className="flex items-center gap-3 px-3 py-2.5 rounded-md text-sm cursor-pointer transition-colors text-foreground data-[selected=true]:bg-accent"
                    >
                      <item.icon className="h-4 w-4 text-muted-foreground" />
                      {item.label}
                    </Command.Item>
                  ))}
                </Command.Group>

                {/* Quick Actions */}
                <Command.Group heading="Quick Actions" className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground px-2 py-1.5">
                  <Command.Item
                    value="Spawn new agent"
                    onSelect={() => runCommand(() => navigate("/agents?action=spawn"))}
                    className="flex items-center gap-3 px-3 py-2.5 rounded-md text-sm cursor-pointer transition-colors text-foreground data-[selected=true]:bg-accent"
                  >
                    <Plus className="h-4 w-4 text-success" />
                    Spawn New Agent
                  </Command.Item>
                  <Command.Item
                    value="Create policy rule"
                    onSelect={() => runCommand(() => navigate("/policies?action=create"))}
                    className="flex items-center gap-3 px-3 py-2.5 rounded-md text-sm cursor-pointer transition-colors text-foreground data-[selected=true]:bg-accent"
                  >
                    <Shield className="h-4 w-4 text-primary" />
                    Create Policy Rule
                  </Command.Item>
                  <Command.Item
                    value="Review pending approvals"
                    onSelect={() => runCommand(() => navigate("/approvals"))}
                    className="flex items-center gap-3 px-3 py-2.5 rounded-md text-sm cursor-pointer transition-colors text-foreground data-[selected=true]:bg-accent"
                  >
                    <CheckCircle className="h-4 w-4 text-warning" />
                    Review Pending Approvals
                  </Command.Item>
                  <Command.Item
                    value="Verify audit chain"
                    onSelect={() => runCommand(() => navigate("/security"))}
                    className="flex items-center gap-3 px-3 py-2.5 rounded-md text-sm cursor-pointer transition-colors text-foreground data-[selected=true]:bg-accent"
                  >
                    <Lock className="h-4 w-4 text-primary" />
                    Verify Audit Chain
                  </Command.Item>
                </Command.Group>

                {/* Emergency */}
                <Command.Group heading="Emergency" className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground px-2 py-1.5">
                  <Command.Item
                    value="Emergency stop all agents"
                    onSelect={() =>
                      runCommand(async () => {
                        if (!confirm(`⚠️ EMERGENCY STOP: This will terminate ${activeAgents.length} active agent(s) and cancel all their tasks. Continue?`)) return;
                        for (const agent of activeAgents) {
                          try {
                            await emergencyStopAll.mutateAsync(agent.id);
                          } catch { /* continue stopping others */ }
                        }
                        navigate("/agents");
                      })
                    }
                    className="flex items-center gap-3 px-3 py-2.5 rounded-md text-sm cursor-pointer transition-colors text-destructive data-[selected=true]:bg-destructive/10"
                  >
                    <AlertOctagon className="h-4 w-4" />
                    Emergency Stop All Agents ({activeAgents.length} active)
                  </Command.Item>
                </Command.Group>

                {/* Preferences */}
                <Command.Group heading="Preferences" className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground px-2 py-1.5">
                  <Command.Item
                    value="Toggle dark light theme"
                    onSelect={() =>
                      runCommand(() => setTheme(theme === "dark" ? "light" : "dark"))
                    }
                    className="flex items-center gap-3 px-3 py-2.5 rounded-md text-sm cursor-pointer transition-colors text-foreground data-[selected=true]:bg-accent"
                  >
                    {theme === "dark" ? (
                      <Sun className="h-4 w-4 text-warning" />
                    ) : (
                      <Moon className="h-4 w-4 text-primary" />
                    )}
                    Toggle Theme
                  </Command.Item>
                  <Command.Item
                    value="Sign out logout"
                    onSelect={() => runCommand(() => { logout(); navigate("/login"); })}
                    className="flex items-center gap-3 px-3 py-2.5 rounded-md text-sm cursor-pointer transition-colors text-foreground data-[selected=true]:bg-accent"
                  >
                    <LogOut className="h-4 w-4 text-muted-foreground" />
                    Sign Out
                  </Command.Item>
                </Command.Group>
              </Command.List>

              {/* Footer hint */}
              <div className="flex items-center justify-between border-t border-border px-4 py-2 text-[10px] text-muted-foreground">
                <div className="flex items-center gap-3">
                  <span>↑↓ Navigate</span>
                  <span>↵ Select</span>
                  <span>Esc Close</span>
                </div>
                <div className="flex items-center gap-1">
                  <Zap className="h-3 w-3" />
                  NexusOps
                </div>
              </div>
            </Command>
          </div>
        </div>
      )}
    </>
  );
}
