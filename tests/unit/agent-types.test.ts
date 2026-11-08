/**
 * Unit tests for agent types, statuses, and Zod runtime validation schemas.
 *
 * Verifies that statuses match §4 exactly, terminal predicates behave correctly,
 * and request/output schemas strictly accept valid inputs while rejecting malformed,
 * oversized, or injected data.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AGENT_ROLES,
  EFFORT_LEVELS,
  EVENT_AGENTS,
  EVENT_KINDS,
  INTENT_KINDS,
  isTerminalStatus,
  RUN_STAGES,
  RUN_STATUSES,
  TERMINAL_STATUSES,
  WORKSPACE_KINDS,
} from "../../src/core/agents/types";
import {
  checkNameSchema,
  plannerOutputSchema,
  reviewerOutputSchema,
  runRequestSchema,
} from "../../src/core/agents/schema";

describe("agent types and constants", () => {
  it("matches §4 run statuses exactly", () => {
    assert.deepEqual(RUN_STATUSES, [
      "queued",
      "preparing",
      "planning",
      "implementing",
      "checking",
      "reviewing",
      "correcting",
      "awaiting_approval",
      "succeeded",
      "failed",
      "stopped",
      "interrupted",
    ]);
  });

  it("defines the exact terminal statuses set and verifies predicate", () => {
    assert.deepEqual(TERMINAL_STATUSES, [
      "succeeded",
      "failed",
      "stopped",
      "interrupted",
    ]);

    for (const status of TERMINAL_STATUSES) {
      assert.equal(isTerminalStatus(status), true, `expected ${status} to be terminal`);
    }

    const nonTerminalStatuses = [
      "queued",
      "preparing",
      "planning",
      "implementing",
      "checking",
      "reviewing",
      "correcting",
      "awaiting_approval",
    ];

    for (const status of nonTerminalStatuses) {
      assert.equal(isTerminalStatus(status), false, `expected ${status} to not be terminal`);
    }

    assert.equal(isTerminalStatus("non_existent"), false);
    assert.equal(isTerminalStatus(""), false);
    assert.equal(isTerminalStatus(null), false);
    assert.equal(isTerminalStatus(undefined), false);
    assert.equal(isTerminalStatus(123), false);
  });

  it("matches §7 run stages exactly", () => {
    assert.deepEqual(RUN_STAGES, [
      "inspect",
      "plan",
      "implement",
      "checks",
      "diff",
      "review",
      "correct",
      "final",
    ]);
  });

  it("matches §4 event agents and closed event kinds", () => {
    assert.deepEqual(EVENT_AGENTS, [
      "planner",
      "implementer",
      "reviewer",
      "checks",
      "advisor",
      "system",
    ]);

    assert.deepEqual(EVENT_KINDS, [
      "stage_started",
      "stage_finished",
      "output",
      "tool_call",
      "tool_result",
      "check_result",
      "diff_summary",
      "diff_patch",
      "review",
      "status_changed",
      "error",
      "warning",
      "plugin_read",
      "monitor_stop",
      "continuation",
    ]);
  });

  it("defines intent kinds, workspace kinds, agent roles, and effort levels", () => {
    assert.deepEqual(INTENT_KINDS, ["start", "stop", "approve", "deny", "resume"]);
    assert.deepEqual(WORKSPACE_KINDS, ["git_worktree", "snapshot_copy"]);
    assert.deepEqual(AGENT_ROLES, ["planner", "implementer", "reviewer"]);
    assert.deepEqual(EFFORT_LEVELS, [
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });
});

describe("runRequestSchema", () => {
  it("accepts a valid minimal request", () => {
    const input = {
      projectId: "proj_123",
      task: "Fix the race condition in auth handler",
      roles: {
        implementer: {
          provider: "claude-code",
        },
      },
    };

    const parsed = runRequestSchema.parse(input);
    assert.equal(parsed.projectId, "proj_123");
    assert.equal(parsed.task, "Fix the race condition in auth handler");
    assert.equal(parsed.roles.implementer.provider, "claude-code");
    assert.deepEqual(parsed.checks, []);
  });

  it("accepts a valid full request with all roles and checks", () => {
    const input = {
      projectId: "proj_456",
      task: "Add desktop availability guard",
      roles: {
        implementer: {
          provider: "antigravity",
          model: "gemini-3.8-flash-high",
          effort: "high",
        },
        planner: {
          provider: "codex",
          model: "gpt-6.1-sol",
          effort: "medium",
        },
        reviewer: {
          provider: "codex",
          model: "gpt-6.1-sol",
          effort: "medium",
        },
      },
      checks: ["typecheck", "lint", "test:unit"],
    };

    const parsed = runRequestSchema.parse(input);
    assert.equal(parsed.roles.implementer.effort, "high");
    assert.equal(parsed.roles.planner?.provider, "codex");
    assert.equal(parsed.roles.reviewer?.provider, "codex");
    assert.deepEqual(parsed.checks, ["typecheck", "lint", "test:unit"]);
  });

  it("rejects Antigravity as planner or reviewer but allows it as implementer", () => {
    for (const role of ["planner", "reviewer"] as const) {
      assert.throws(
        () =>
          runRequestSchema.parse({
            projectId: "proj_1",
            task: "t",
            roles: { implementer: { provider: "claude-code" }, [role]: { provider: "antigravity" } },
          }),
        /Antigravity can only be the implementer/,
        role,
      );
    }
    const ok = runRequestSchema.parse({
      projectId: "proj_1",
      task: "t",
      roles: { implementer: { provider: "antigravity" }, reviewer: { provider: "claude-code" } },
    });
    assert.equal(ok.roles.implementer.provider, "antigravity");
  });

  it("rejects an empty or whitespace-only task", () => {
    assert.throws(
      () =>
        runRequestSchema.parse({
          projectId: "proj_1",
          task: "",
          roles: { implementer: { provider: "claude-code" } },
        }),
      /Task is required/,
    );

    assert.throws(
      () =>
        runRequestSchema.parse({
          projectId: "proj_1",
          task: "   \t\n  ",
          roles: { implementer: { provider: "claude-code" } },
        }),
      /Task is required/,
    );
  });

  it("rejects a task exceeding 20000 characters", () => {
    assert.throws(
      () =>
        runRequestSchema.parse({
          projectId: "proj_1",
          task: "a".repeat(20001),
          roles: { implementer: { provider: "claude-code" } },
        }),
      /cannot exceed 20000 characters/,
    );
  });

  it("rejects unknown keys at top level and in nested objects", () => {
    assert.throws(
      () =>
        runRequestSchema.parse({
          projectId: "proj_1",
          task: "Valid task",
          roles: { implementer: { provider: "claude-code" } },
          extra_key: "forbidden",
        }),
      /unrecognized_keys/i,
    );

    assert.throws(
      () =>
        runRequestSchema.parse({
          projectId: "proj_1",
          task: "Valid task",
          roles: {
            implementer: { provider: "claude-code" },
            unrecognizedRole: { provider: "other" },
          },
        }),
      /unrecognized_keys/i,
    );

    assert.throws(
      () =>
        runRequestSchema.parse({
          projectId: "proj_1",
          task: "Valid task",
          roles: {
            implementer: { provider: "claude-code", injectedArg: "--bypass" },
          },
        }),
      /unrecognized_keys/i,
    );
  });

  it("rejects check names with slashes, spaces, or invalid characters", () => {
    const invalidCheckNames = [
      "npm test",
      "test/unit",
      "tests\\run",
      "check name",
      "lint && test",
      "check;rm",
      "",
    ];

    for (const name of invalidCheckNames) {
      assert.throws(
        () => checkNameSchema.parse(name),
        (err) => err instanceof Error,
        `expected checkNameSchema to reject '${name}'`,
      );

      assert.throws(
        () =>
          runRequestSchema.parse({
            projectId: "proj_1",
            task: "Valid task",
            roles: { implementer: { provider: "claude-code" } },
            checks: [name],
          }),
        (err) => err instanceof Error,
        `expected runRequestSchema to reject check '${name}'`,
      );
    }
  });

  it("rejects more than 20 checks", () => {
    const twentyOneChecks = Array.from({ length: 21 }, (_, i) => `check_${i}`);

    assert.throws(
      () =>
        runRequestSchema.parse({
          projectId: "proj_1",
          task: "Valid task",
          roles: { implementer: { provider: "claude-code" } },
          checks: twentyOneChecks,
        }),
      /At most 20 checks allowed/,
    );
  });
});

describe("plannerOutputSchema", () => {
  it("accepts valid planner output", () => {
    const validPlan = {
      task: "Add availability check",
      scope_paths: ["src/core/agents/availability.ts", "tests/unit/agent-availability.test.ts"],
      acceptance: ["Returns true only for desktop", "Fails closed otherwise"],
      checks: ["typecheck", "lint", "test:unit"],
    };

    const parsed = plannerOutputSchema.parse(validPlan);
    assert.equal(parsed.task, "Add availability check");
    assert.deepEqual(parsed.scope_paths, validPlan.scope_paths);
    assert.deepEqual(parsed.checks, validPlan.checks);
  });

  it("rejects unknown keys in planner output", () => {
    assert.throws(
      () =>
        plannerOutputSchema.parse({
          task: "Valid task",
          scope_paths: [],
          acceptance: [],
          checks: [],
          extra_metadata: 123,
        }),
      /unrecognized_keys/i,
    );
  });

  it("rejects an empty task in planner output", () => {
    assert.throws(
      () =>
        plannerOutputSchema.parse({
          task: "",
          scope_paths: [],
          acceptance: [],
          checks: [],
        }),
      /Task is required/,
    );
  });
});

describe("reviewerOutputSchema", () => {
  it("accepts valid approve verdict with empty findings", () => {
    const output = {
      verdict: "approve",
      findings: [],
    };

    const parsed = reviewerOutputSchema.parse(output);
    assert.equal(parsed.verdict, "approve");
    assert.deepEqual(parsed.findings, []);
  });

  it("accepts valid request_changes verdict with findings", () => {
    const output = {
      verdict: "request_changes",
      findings: [
        {
          severity: "P1",
          path: "src/core/agents/availability.ts",
          line: 42,
          message: "Potential bypass if secret is whitespace only",
          actionable: true,
        },
        {
          severity: "P2",
          message: "Missing test for negative line number",
          actionable: false,
        },
      ],
    };

    const parsed = reviewerOutputSchema.parse(output);
    assert.equal(parsed.verdict, "request_changes");
    assert.equal(parsed.findings.length, 2);
    assert.equal(parsed.findings[0]?.severity, "P1");
    assert.equal(parsed.findings[0]?.line, 42);
    assert.equal(parsed.findings[1]?.path, undefined);
  });

  it("rejects a bad verdict", () => {
    assert.throws(
      () =>
        reviewerOutputSchema.parse({
          verdict: "accepted",
          findings: [],
        }),
      (err) => err instanceof Error,
    );

    assert.throws(
      () =>
        reviewerOutputSchema.parse({
          verdict: "reject",
          findings: [],
        }),
      (err) => err instanceof Error,
    );
  });

  it("rejects line 0, negative lines, or non-integer lines", () => {
    assert.throws(
      () =>
        reviewerOutputSchema.parse({
          verdict: "request_changes",
          findings: [
            {
              severity: "P1",
              line: 0,
              message: "Invalid line 0",
              actionable: true,
            },
          ],
        }),
      /Line must be at least 1/,
    );

    assert.throws(
      () =>
        reviewerOutputSchema.parse({
          verdict: "request_changes",
          findings: [
            {
              severity: "P2",
              line: -5,
              message: "Negative line",
              actionable: true,
            },
          ],
        }),
      /Line must be at least 1/,
    );

    assert.throws(
      () =>
        reviewerOutputSchema.parse({
          verdict: "request_changes",
          findings: [
            {
              severity: "P3",
              line: 3.14,
              message: "Float line",
              actionable: true,
            },
          ],
        }),
      /Line must be an integer/,
    );
  });

  it("rejects unknown keys in reviewer output and findings", () => {
    assert.throws(
      () =>
        reviewerOutputSchema.parse({
          verdict: "approve",
          findings: [],
          notes: "Extra text",
        }),
      /unrecognized_keys/i,
    );

    assert.throws(
      () =>
        reviewerOutputSchema.parse({
          verdict: "request_changes",
          findings: [
            {
              severity: "P1",
              message: "Valid finding",
              actionable: true,
              extraProp: "forbidden",
            },
          ],
        }),
      /unrecognized_keys/i,
    );
  });
});

describe("agent output bounds (untrusted planner and reviewer output)", () => {
  const plan = { task: "t", scope_paths: ["src/a.ts"], acceptance: ["works"], checks: ["lint"] };
  const finding = { severity: "P2", message: "m", actionable: true } as const;

  it("accepts output at the limits", () => {
    assert.ok(plannerOutputSchema.safeParse({ ...plan, scope_paths: Array(200).fill("a"), checks: Array(20).fill("lint") }).success);
    assert.ok(reviewerOutputSchema.safeParse({ verdict: "approve", findings: Array(100).fill(finding) }).success);
  });

  it("rejects planner output past the limits or with unsafe check names", () => {
    assert.equal(plannerOutputSchema.safeParse({ ...plan, scope_paths: Array(201).fill("a") }).success, false);
    assert.equal(plannerOutputSchema.safeParse({ ...plan, acceptance: Array(51).fill("x") }).success, false);
    assert.equal(plannerOutputSchema.safeParse({ ...plan, checks: Array(21).fill("lint") }).success, false);
    assert.equal(plannerOutputSchema.safeParse({ ...plan, checks: ["npm test"] }).success, false);
    assert.equal(plannerOutputSchema.safeParse({ ...plan, checks: ["../x"] }).success, false);
    assert.equal(plannerOutputSchema.safeParse({ ...plan, task: "x".repeat(20001) }).success, false);
  });

  it("rejects reviewer output past the limits", () => {
    assert.equal(reviewerOutputSchema.safeParse({ verdict: "approve", findings: Array(101).fill(finding) }).success, false);
    assert.equal(
      reviewerOutputSchema.safeParse({ verdict: "approve", findings: [{ ...finding, message: "x".repeat(4001) }] }).success,
      false,
    );
  });
});
