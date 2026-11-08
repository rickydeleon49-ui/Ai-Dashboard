/**
 * Node-free severity mapping, shared by the orchestrator (server) and the run
 * page (client). Keep this file free of server imports.
 */
import type { ReviewerFinding } from "./schema";

export type SeverityClass = "blocking" | "major" | "minor";

/**
 * The one place that maps reviewer severities (P1/P2/P3 today) to the design's
 * classes (blocking/major/minor/nit). A severity rename touches only this.
 */
export function severityClass(severity: ReviewerFinding["severity"]): SeverityClass {
  switch (severity) {
    case "P1":
      return "blocking";
    case "P2":
      return "major";
    default:
      return "minor";
  }
}
