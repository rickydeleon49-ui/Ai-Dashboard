import { NotebookPen } from "lucide-react";
import { PhasePage } from "@/components/ui/phase-page";

export const metadata = { title: "Notes" };

export default function NotesPage() {
  return (
    <div className="min-w-0">
      <PhasePage
        icon={NotebookPen}
        title="Notes"
        phase={3}
        description="Standalone notes, and notes attached to a project."
        foundation="The notes table exists and every project already carries its own notes field, editable from the project detail page today."
        features={[
          { title: "Quick capture", detail: "Jot a note without leaving what you were doing." },
          { title: "Project linking", detail: "Attach a note to any project in the library." },
          { title: "Pinned notes", detail: "Keep the important ones at the top." },
          { title: "Full-text search", detail: "Notes join the unified search index." },
        ]}
        action={{ label: "Add a project note", href: "/projects" }}
      />
    </div>
  );
}
