"use client";

import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <EmptyState
      icon={AlertTriangle}
      title="Something went wrong"
      description={error.message || "An unexpected error occurred while rendering this page."}
      action={
        <Button variant="primary" size="lg" onClick={reset}>
          Try again
        </Button>
      }
    />
  );
}
