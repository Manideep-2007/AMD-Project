import { motion } from "framer-motion";
import { Settings, Users, Key, Building2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";

const members = [
  { name: "Alex Chen", email: "alex@nexusops.io", role: "Owner" },
  { name: "Sarah Kim", email: "sarah@nexusops.io", role: "Admin" },
  { name: "James Wu", email: "james@nexusops.io", role: "Operator" },
  { name: "Maria Lopez", email: "maria@nexusops.io", role: "Viewer" },
];

const roleColors: Record<string, string> = {
  Owner: "bg-primary/15 text-primary border-primary/30",
  Admin: "bg-warning/15 text-warning border-warning/30",
  Operator: "bg-success/15 text-success border-success/30",
  Viewer: "bg-muted text-muted-foreground border-border",
};

export default function SettingsPage() {
  return (
    <div className="p-6 space-y-8 max-w-3xl">
      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2"><Settings className="h-6 w-6" /> Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">Workspace configuration and access control</p>
      </motion.div>

      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="space-y-4">
        <h2 className="text-lg font-semibold flex items-center gap-2"><Building2 className="h-4 w-4" /> Workspace</h2>
        <div className="rounded-xl border border-border bg-card p-5 space-y-4">
          <div className="space-y-2">
            <Label>Workspace Name</Label>
            <Input defaultValue="NexusOps Production" className="max-w-sm" />
          </div>
          <div className="space-y-2">
            <Label>Workspace ID</Label>
            <p className="text-sm font-mono text-muted-foreground">ws_prod_01HXYZ</p>
          </div>
        </div>
      </motion.div>

      <Separator />

      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }} className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold flex items-center gap-2"><Users className="h-4 w-4" /> Team Members</h2>
          <Button variant="outline" size="sm">Invite</Button>
        </div>
        <div className="rounded-xl border border-border bg-card divide-y divide-border">
          {members.map((m) => (
            <div key={m.email} className="flex items-center justify-between px-5 py-3">
              <div>
                <p className="text-sm font-medium">{m.name}</p>
                <p className="text-xs text-muted-foreground">{m.email}</p>
              </div>
              <Badge variant="outline" className={`text-[10px] font-mono ${roleColors[m.role]}`}>{m.role}</Badge>
            </div>
          ))}
        </div>
      </motion.div>

      <Separator />

      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }} className="space-y-4">
        <h2 className="text-lg font-semibold flex items-center gap-2"><Key className="h-4 w-4" /> API Keys</h2>
        <div className="rounded-xl border border-border bg-card p-5 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Production SDK Key</p>
              <p className="text-xs font-mono text-muted-foreground">nxo_sk_****************************7f3a</p>
            </div>
            <Button variant="outline" size="sm">Regenerate</Button>
          </div>
          <Separator />
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Staging SDK Key</p>
              <p className="text-xs font-mono text-muted-foreground">nxo_sk_****************************9b2c</p>
            </div>
            <Button variant="outline" size="sm">Regenerate</Button>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
