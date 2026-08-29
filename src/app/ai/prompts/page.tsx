import { Bot } from "lucide-react";
import { PhasePage } from "@/components/ui/phase-page";

export const metadata = { title: "Prompts" };

export default function PromptsPage() {
  return (
    <PhasePage
      icon={Bot}
      title="Prompt Library"
      phase={4}
      description="A searchable home for the prompts you keep rewriting."
      foundation="The prompts table (title, body, model, category, favorite) is already migrated, so this section is UI work rather than a schema change."
      features={[
        { title: "Saved prompts", detail: "Store, tag and search prompts by category." },
        { title: "Per-model variants", detail: "Keep model-specific versions side by side." },
        { title: "Favorites", detail: "Pin the handful you use every day." },
        { title: "Copy and run", detail: "One click to copy, or send to an assistant." },
      ]}
    />
  );
}
