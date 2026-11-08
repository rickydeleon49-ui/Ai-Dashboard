/**
 * Agent adapter interfaces and types for the Agent Workflow Control Center (§3, §8).
 *
 * Source of truth: docs/design/AW-agent-workflow-control-center.md
 */
import type { EffortLevel, EventKind } from "../types";

export interface ProbeResult {
  installed: boolean;
  version?: string;
  authenticated: boolean | "unknown";
  executable?: string;
  tried?: string[];
  error?: string;
}

export interface InvocationRequest {
  workspacePath: string;
  prompt: string;
  model?: string;
  effort?: EffortLevel | string;
  checkCommands: string[][];
  excludedPaths: string[];
  grantDir: string;
  resumeSessionId?: string;
}

export interface Invocation {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdin: string;
  grantFile?: string;
}

export interface NormalizedEvent {
  agent: "implementer";
  kind: EventKind;
  payload: unknown;
}

export interface AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  /** True when buildInvocation honours resumeSessionId and the session survives the process (default false). */
  readonly supportsResume?: boolean;
  probe(deps?: unknown): Promise<ProbeResult>;
  buildInvocation(req: InvocationRequest): Invocation;
  parseLine(obj: unknown): NormalizedEvent[];
}
