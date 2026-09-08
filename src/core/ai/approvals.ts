/**
 * What an agent may do, and what it must ask about first.
 *
 * Defined before any agent can act, because the moment tools exist is the wrong
 * moment to start designing the approval model — everything at that point argues
 * for "just this once". Chat mode never consults this list: it has no tools at
 * all, which is the actual guarantee.
 *
 * This file is the vocabulary *and* the decision. `evaluateAction` is the one
 * function every would-be agent action goes through, so "what is allowed" has a
 * single answer that can be tested, rather than a rule restated at each call
 * site. It stays free of database and Node imports so the settings page, the
 * workspace and the provider can all import it.
 */
import { z } from "zod";

export const AGENT_ACTIONS = [
  "read_file",
  "modify_file",
  "create_file",
  "delete_file",
  "run_command",
  "install_dependency",
  "git_commit",
  "git_push",
] as const;
export type AgentAction = (typeof AGENT_ACTIONS)[number];

/**
 *   auto     may happen without interrupting, and is logged
 *   ask      pauses for an explicit yes, every time
 *   never    refused outright until the user changes the policy
 */
export type ApprovalPolicy = "auto" | "ask" | "never";

export interface AgentActionSpec {
  action: AgentAction;
  label: string;
  /** One line the user reads when deciding. */
  description: string;
  /** Whether the effect leaves this machine or cannot be undone. */
  destructive: boolean;
  defaultPolicy: ApprovalPolicy;
}

/**
 * The default policy.
 *
 * Reading inside a project the user chose is the only thing that happens
 * without asking. Everything that writes, executes or leaves the machine is
 * `ask`, and pushing is `never` until deliberately enabled — an agent that can
 * push can publish, and publishing is not undoable.
 */
export const AGENT_ACTION_SPECS: readonly AgentActionSpec[] = [
  {
    action: "read_file",
    label: "Read a file",
    description: "Read a file inside the selected project folder.",
    destructive: false,
    defaultPolicy: "auto",
  },
  {
    action: "modify_file",
    label: "Modify a file",
    description: "Change an existing file in the project.",
    destructive: true,
    defaultPolicy: "ask",
  },
  {
    action: "create_file",
    label: "Create a file",
    description: "Add a new file to the project.",
    destructive: false,
    defaultPolicy: "ask",
  },
  {
    action: "delete_file",
    label: "Delete a file",
    description: "Remove a file from the project.",
    destructive: true,
    defaultPolicy: "ask",
  },
  {
    action: "run_command",
    label: "Run a command",
    description: "Run a command in the project folder, such as a test suite.",
    destructive: true,
    defaultPolicy: "ask",
  },
  {
    action: "install_dependency",
    label: "Install a dependency",
    description: "Add a package, which runs that package's install scripts.",
    destructive: true,
    defaultPolicy: "ask",
  },
  {
    action: "git_commit",
    label: "Commit",
    description: "Record a commit in the project's repository.",
    destructive: true,
    defaultPolicy: "ask",
  },
  {
    action: "git_push",
    label: "Push",
    description: "Publish commits to the remote repository.",
    destructive: true,
    defaultPolicy: "never",
  },
];

/** The policy in force for every action. */
export type ApprovalPolicies = Record<AgentAction, ApprovalPolicy>;

export function specFor(action: AgentAction): AgentActionSpec {
  // The list is exhaustive over AgentAction by construction, and the test suite
  // asserts it, so this cannot be undefined at runtime.
  return AGENT_ACTION_SPECS.find((spec) => spec.action === action)!;
}

export const DEFAULT_APPROVAL_POLICIES: ApprovalPolicies = Object.fromEntries(
  AGENT_ACTION_SPECS.map((spec) => [spec.action, spec.defaultPolicy]),
) as ApprovalPolicies;

/**
 * Accepts a partial, possibly hand-edited set of overrides.
 *
 * Unknown actions and unknown policies are dropped rather than rejected: these
 * are read on every request that could act, and one stale row left behind by an
 * older version must not be able to fail the whole evaluation — failing it
 * would either block everything or, far worse, be worked around by a caller.
 */
export const approvalPoliciesSchema = z
  .record(z.string(), z.string())
  .transform((raw): Partial<ApprovalPolicies> => {
    const out: Partial<ApprovalPolicies> = {};
    for (const [action, policy] of Object.entries(raw)) {
      if (!isAgentAction(action)) continue;
      if (policy !== "auto" && policy !== "ask" && policy !== "never") continue;
      out[action] = policy;
    }
    return out;
  });

export function isAgentAction(value: string): value is AgentAction {
  return (AGENT_ACTIONS as readonly string[]).includes(value);
}

export function isApprovalPolicy(value: string): value is ApprovalPolicy {
  return value === "auto" || value === "ask" || value === "never";
}

/** The defaults with the user's overrides applied on top. */
export function resolveApprovalPolicies(
  overrides: Partial<ApprovalPolicies> = {},
): ApprovalPolicies {
  return { ...DEFAULT_APPROVAL_POLICIES, ...overrides };
}

/**
 * What happens when an agent asks to do one thing.
 *
 *   allowed           whether it may happen at all, now or after a prompt
 *   requiresApproval  whether the user has to say yes first
 *   reason            one sentence, written for the person, not the log
 */
export interface ApprovalDecision {
  action: AgentAction;
  policy: ApprovalPolicy;
  allowed: boolean;
  requiresApproval: boolean;
  reason: string;
}

export function evaluateAction(
  action: AgentAction,
  policies: ApprovalPolicies = DEFAULT_APPROVAL_POLICIES,
): ApprovalDecision {
  const spec = specFor(action);
  const policy = policies[action] ?? spec.defaultPolicy;

  if (policy === "never") {
    return {
      action,
      policy,
      allowed: false,
      requiresApproval: false,
      reason: `"${spec.label}" is blocked. Change it in Settings → Local AI if you want it offered.`,
    };
  }

  if (policy === "ask") {
    return {
      action,
      policy,
      allowed: true,
      requiresApproval: true,
      reason: `"${spec.label}" needs your approval each time.`,
    };
  }

  return {
    action,
    policy,
    allowed: true,
    requiresApproval: false,
    reason: `"${spec.label}" runs without interrupting, and is logged.`,
  };
}

/** A short label for the policy, matching what the workspace shows. */
export function policyLabel(policy: ApprovalPolicy): string {
  return policy === "auto" ? "Automatic" : policy === "ask" ? "Asks first" : "Blocked";
}
