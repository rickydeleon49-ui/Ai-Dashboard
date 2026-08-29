import Link from "next/link";
import { SearchX } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { buttonClasses } from "@/components/ui/button";

export default function NotFound() {
  return (
    <EmptyState
      icon={SearchX}
      title="Not found"
      description="That page or project does not exist — it may have been deleted or the link is out of date."
      action={
        <Link href="/" className={buttonClasses("primary", "lg")}>
          Back to dashboard
        </Link>
      }
    />
  );
}
