import type { RunOutcome } from "./orchestrator";

export interface PrBodyInput {
  title: string;                 // run title / task title
  taskUrl?: string | null;       // optional link to the task
  implementer: string;           // e.g. "Antigravity (gemini-3.8-flash)"
  reviewer?: string | null;
  outcome: RunOutcome;
  changedFiles: string[];        // worktree-relative paths
  agentSummary?: string | null;  // text written by the agent (untrusted)
  runUrl?: string | null;
}

export function buildPrBody(input: PrBodyInput): string {
  const sections: string[] = [];

  // ## Summary
  const summaryLines: string[] = ["## Summary", ""];
  const titleLine = input.title.trim().split(/\r?\n/)[0]?.trim() || input.title.trim();
  summaryLines.push(titleLine);
  if (input.taskUrl && input.taskUrl.trim().length > 0) {
    summaryLines.push(`Task: ${input.taskUrl.trim()}`);
  }
  sections.push(summaryLines.join("\n"));

  // ## Facts
  const factLines: string[] = ["## Facts", ""];
  factLines.push(`- Status: ${input.outcome.status}`);
  factLines.push(`- Implementer: ${input.implementer.trim()}`);
  if (input.reviewer && input.reviewer.trim().length > 0) {
    factLines.push(`- Reviewer: ${input.reviewer.trim()}`);
  }
  if (input.outcome.facts.reviewVerdict) {
    factLines.push(`- Review verdict: ${input.outcome.facts.reviewVerdict}`);
  }
  const filesCount = input.outcome.facts.diffFiles ?? input.changedFiles.length;
  factLines.push(`- Files changed: ${filesCount}`);
  for (const check of input.outcome.facts.checks) {
    if (check.timedOut) {
      factLines.push(`- ${check.name.trim()}: timed out`);
    } else if (check.exitCode === 0) {
      factLines.push(`- ${check.name.trim()}: passed`);
    } else if (check.exitCode !== null) {
      factLines.push(`- ${check.name.trim()}: failed (exit ${check.exitCode})`);
    } else {
      factLines.push(`- ${check.name.trim()}: failed`);
    }
  }
  if (input.outcome.facts.excludedTouched && input.outcome.facts.excludedTouched.length > 0) {
    factLines.push(`- Excluded paths touched: ${input.outcome.facts.excludedTouched.join(", ")}`);
  }
  if (input.outcome.facts.outOfScope && input.outcome.facts.outOfScope.length > 0) {
    factLines.push(`- Out-of-scope paths: ${input.outcome.facts.outOfScope.join(", ")}`);
  }
  if (input.outcome.rounds !== undefined && input.outcome.rounds !== null) {
    factLines.push(`- Correction rounds: ${input.outcome.rounds.corrections}`);
  }
  sections.push(factLines.join("\n"));

  // ## Files
  const fileLines: string[] = ["## Files"];
  const maxFiles = 50;
  const shownFiles = input.changedFiles.slice(0, maxFiles);
  if (shownFiles.length > 0) {
    fileLines.push("");
    for (const file of shownFiles) {
      fileLines.push(`- \`${file.trim()}\``);
    }
    const more = input.changedFiles.length - shownFiles.length;
    if (more > 0) {
      fileLines.push(`- … and ${more} more`);
    }
  }
  sections.push(fileLines.join("\n"));

  // ## Agent notes
  if (input.agentSummary !== null && input.agentSummary !== undefined) {
    const trimmed = input.agentSummary.trim();
    if (trimmed.length > 0) {
      let text = trimmed;
      if (text.length > 4000) {
        text = text.slice(0, 4000) + "…";
      }
      const noteLines = text.split(/\r?\n/).map((line) => {
        const lineTrimmed = line.trimEnd();
        return lineTrimmed.length > 0 ? `> ${lineTrimmed}` : ">";
      });
      sections.push(["## Agent notes", "", ...noteLines].join("\n"));
    }
  }

  // Final line: Run: <runUrl>
  if (input.runUrl && input.runUrl.trim().length > 0) {
    sections.push(`Run: ${input.runUrl.trim()}`);
  }

  return sections.join("\n\n") + "\n";
}
