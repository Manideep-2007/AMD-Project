import { motion } from "framer-motion";
import {
  CheckCircle2,
  Circle,
  Rocket,
  AlertCircle,
  Loader2,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { useOnboardingChecklist } from "@/hooks/use-api";

interface OnboardingStep {
  id: string;
  title: string;
  description: string;
  completed: boolean;
}

export default function Onboarding() {
  const { data, isLoading, isError } = useOnboardingChecklist();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isError || !data?.data) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3 text-muted-foreground">
        <AlertCircle className="h-10 w-10" />
        <p className="text-sm">Failed to load onboarding checklist.</p>
      </div>
    );
  }

  const { steps, completedCount, totalSteps, overallProgress } = data.data as {
    steps: OnboardingStep[];
    completedCount: number;
    totalSteps: number;
    overallProgress: number;
  };

  const allDone = completedCount === totalSteps;

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Rocket className="h-6 w-6 text-primary" />
          Getting Started
        </h1>
        <p className="text-sm text-muted-foreground">
          Complete these steps to set up your NexusOps workspace.
        </p>
      </div>

      {/* Progress bar */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            {allDone ? "All set! Your workspace is fully configured." : `${completedCount} of ${totalSteps} steps completed`}
          </CardTitle>
          <CardDescription>{overallProgress}% complete</CardDescription>
        </CardHeader>
        <CardContent>
          <Progress value={overallProgress} className="h-2" />
        </CardContent>
      </Card>

      {/* Step list */}
      <div className="space-y-3">
        {steps.map((step, i) => (
          <motion.div
            key={step.id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.05 }}
          >
            <Card className={step.completed ? "border-emerald-500/30 bg-emerald-500/5" : ""}>
              <CardContent className="flex items-start gap-3 p-4">
                {step.completed ? (
                  <CheckCircle2 className="h-5 w-5 text-emerald-500 mt-0.5 flex-shrink-0" />
                ) : (
                  <Circle className="h-5 w-5 text-muted-foreground mt-0.5 flex-shrink-0" />
                )}
                <div>
                  <p className={`text-sm font-medium ${step.completed ? "line-through text-muted-foreground" : ""}`}>
                    {step.title}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">{step.description}</p>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
