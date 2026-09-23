import { Router, Route, Switch } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { VaultProvider, useVault } from "@/lib/vault";
import { useTheme } from "@/lib/theme";
import { LogoMark } from "@/components/logo";
import AuthPage from "@/pages/auth";
import Home from "@/pages/home";

function Gate() {
  useTheme();
  const v = useVault();
  if (v.status === "booting")
    return (
      <div className="flex h-dvh items-center justify-center text-primary" data-testid="status-booting">
        <LogoMark className="h-10 w-10 animate-pulse" />
      </div>
    );
  if (v.status === "signedOut") return <AuthPage />;
  return (
    <Switch>
      <Route component={Home} />
    </Switch>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <VaultProvider>
          <Router hook={useHashLocation}>
            <Gate />
          </Router>
        </VaultProvider>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
