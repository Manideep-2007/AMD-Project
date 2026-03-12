import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate, Outlet } from "react-router-dom";
import { ThemeProvider } from "next-themes";
import Layout from "@/components/Layout";
import { CommandPalette } from "@/components/CommandPalette";
import { useWebSocket } from "@/hooks/use-websocket";
import { useAuthStore } from "@/stores/auth-store";
import Dashboard from "@/pages/Dashboard";
import Agents from "@/pages/Agents";
import Tasks from "@/pages/Tasks";
import Policies from "@/pages/Policies";
import Tools from "@/pages/Tools";
import Audit from "@/pages/Audit";
import SettingsPage from "@/pages/Settings";
import Approvals from "@/pages/Approvals";
import Security from "@/pages/Security";
import Intelligence from "@/pages/Intelligence";
import Onboarding from "@/pages/Onboarding";
import Login from "@/pages/Login";
import NotFound from "@/pages/NotFound";
import ECC from "@/pages/ECC";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 2,
      refetchOnWindowFocus: true,
    },
  },
});

/** Route guard — redirects unauthenticated users to /login */
// Only bypass auth in Vite dev mode (import.meta.env.DEV is false in production builds).
const DEV_BYPASS_AUTH = import.meta.env.DEV === true;

// Seed a dev session so the UI is usable without a running API during local development.
// This block is tree-shaken out of production builds by Vite because DEV_BYPASS_AUTH
// becomes the constant `false` at build time.
if (DEV_BYPASS_AUTH) {
  const DEV_USER = {
    id: 'dev-user-01',
    email: 'dev@nexusops.local',
    name: 'Dev User',
    role: 'OWNER',
    workspaceId: 'dev-workspace-01',
    workspaceName: 'NexusOps Dev',
  };
  // Write directly to localStorage so Zustand's persist middleware rehydrates our values.
  const persistedAuth = JSON.parse(localStorage.getItem('nexusops-auth') || '{}');
  const alreadySeeded = persistedAuth?.state?.accessToken === 'dev-bypass-token';
  if (!alreadySeeded) {
    localStorage.setItem('nexusops-auth', JSON.stringify({
      state: {
        user: DEV_USER,
        accessToken: 'dev-bypass-token',
        isAuthenticated: true,
        isLoading: false,
      },
      version: 0,
    }));
  }
  useAuthStore.setState({
    user: DEV_USER,
    accessToken: 'dev-bypass-token',
    isAuthenticated: true,
    isLoading: false,
  });
}

function RequireAuth() {
  const { isAuthenticated } = useAuthStore();
  if (!DEV_BYPASS_AUTH && !isAuthenticated) return <Navigate to="/login" replace />;
  return <Outlet />;
}

/** WebSocket connector — runs inside QueryClientProvider + auth context */
function WebSocketConnector({ children }: { children: React.ReactNode }) {
  useWebSocket();
  return <>{children}</>;
}

/** Layout wrapper that renders Outlet as children */
function LayoutWrapper() {
  return (
    <Layout>
      <Outlet />
    </Layout>
  );
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <BrowserRouter>
          <WebSocketConnector>
            <CommandPalette />
            <Routes>
              {/* Public route */}
              <Route path="/login" element={DEV_BYPASS_AUTH ? <Navigate to="/" replace /> : <Login />} />

              {/* Protected routes */}
              <Route element={<RequireAuth />}>
                <Route element={<LayoutWrapper />}>
                  <Route path="/" element={<Dashboard />} />
                  <Route path="/agents" element={<Agents />} />
                  <Route path="/tasks" element={<Tasks />} />
                  <Route path="/policies" element={<Policies />} />
                  <Route path="/tools" element={<Tools />} />
                  <Route path="/audit" element={<Audit />} />
                  <Route path="/approvals" element={<Approvals />} />
                  <Route path="/security" element={<Security />} />
                  <Route path="/intelligence" element={<Intelligence />} />
                  <Route path="/ecc" element={<ECC />} />
                  <Route path="/settings" element={<SettingsPage />} />
                  <Route path="/onboarding" element={<Onboarding />} />
                </Route>
              </Route>

              <Route path="*" element={<NotFound />} />
            </Routes>
          </WebSocketConnector>
        </BrowserRouter>
      </TooltipProvider>
    </ThemeProvider>
  </QueryClientProvider>
);

export default App;
