/**
 * What an agent may do, and what it must ask about first.
 *
 * Defined now, before any agent can act, because the moment tools exist is the
 * wrong moment to start designing the approval model — everything at that point
 * argues for "just this once". Chat mode never consults this list: it has no
 * tools at all, which is the actual guarantee. This is the vocabulary the
 * workspace already displays and the policy Phase 4 will enforce.
 */
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
