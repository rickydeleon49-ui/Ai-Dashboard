/**
 * The approval policy, and Hermes being evaluated against it.
 *
 * The policy was a list nothing consulted; these cover it as the decision it
 * now is. The one that matters most is the last group: a blocked "Run a
 * command" has to stop Agent mode before it looks for the executable, because
 * an agent that is refused only at the point of acting has already decided to
 * act.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { cleanup, migrate } from "../helpers/db";

let approvals: typeof import("../../src/core/ai/approvals");
let hermes: typeof import("../../src/core/ai/hermes-provider");
let settings: typeof import("../../src/core/ai/settings");

before(async () => {
  await migrate();
  approvals = await import("../../src/core/ai/approvals");
  hermes = await import("../../src/core/ai/hermes-provider");
  settings = await import("../../src/core/ai/settings");
});

after(() => cleanup());

describe("the action vocabulary", () => {
  it("has a spec for every action, and no orphan specs", () => {
    const specs = approvals.AGENT_ACTION_SPECS.map((spec) => spec.action).sort();
    assert.deepEqual(specs, [...approvals.AGENT_ACTIONS].sort());
  });

  it("defaults to reading only", () => {
    const automatic = approvals.AGENT_ACTION_SPECS.filter(
      (spec) => spec.defaultPolicy === "auto",
    ).map((spec) => spec.action);
    assert.deepEqual(automatic, ["read_file"]);
    assert.equal(approvals.DEFAULT_APPROVAL_POLICIES.git_push, "never");
  });
});

describe("evaluateAction", () => {
  it("allows an automatic action without asking", () => {
    const decision = approvals.evaluateAction("read_file");
    assert.equal(decision.allowed, true);
    assert.equal(decision.requiresApproval, false);
  });

  it("allows an ask action but requires approval", () => {
    const decision = approvals.evaluateAction("modify_file");
    assert.equal(decision.allowed, true);
    assert.equal(decision.requiresApproval, true);
  });

  it("refuses a blocked action outright", () => {
    const decision = approvals.evaluateAction("git_push");
    assert.equal(decision.allowed, false);
    assert.equal(decision.requiresApproval, false);
    assert.match(decision.reason, /blocked/i);
  });

  it("honours an override over the default", () => {
    const policies = approvals.resolveApprovalPolicies({ git_push: "ask" });
    assert.equal(approvals.evaluateAction("git_push", policies).allowed, true);
    // Untouched actions keep their defaults.
    assert.equal(policies.read_file, "auto");
  });
});

describe("stored policies", () => {
  it("round-trips a change and drops a value it does not recognise", () => {
    const updated = settings.updateApprovalPolicies({
      run_command: "never",
      // @ts-expect-error deliberately not a policy this build knows
      delete_file: "sometimes",
    });

    assert.equal(updated.run_command, "never");
    assert.equal(updated.delete_file, approvals.DEFAULT_APPROVAL_POLICIES.delete_file);
    assert.equal(settings.getApprovalPolicies().run_command, "never");
  });

  it("forgets an override set back to its default", () => {
    settings.updateApprovalPolicies({ git_commit: "never" });
    assert.equal(settings.getApprovalPolicies().git_commit, "never");

    settings.updateApprovalPolicies({
      git_commit: approvals.DEFAULT_APPROVAL_POLICIES.git_commit,
    });
    assert.equal(
      settings.getApprovalPolicies().git_commit,
      approvals.DEFAULT_APPROVAL_POLICIES.git_commit,
    );
  });

  it("parses a hand-edited body, keeping only what it understands", () => {
    const parsed = approvals.approvalPoliciesSchema.safeParse({
      read_file: "never",
      not_an_action: "auto",
      run_command: "banana",
    });

    assert.ok(parsed.success);
    assert.deepEqual(parsed.data, { read_file: "never" });
  });
});

describe("Hermes against the policy", () => {
  const blocked = approvals.resolveApprovalPolicies({ run_command: "never" });

  it("reports itself off when running commands is blocked", async () => {
    const provider = new hermes.HermesAgentProvider("", blocked);
    const status = await provider.status();

    assert.equal(status.state, "disabled");
    assert.match(status.detail, /blocked/i);
    // The executable is not even looked for: the policy answered first.
    assert.equal(status.endpoint, null);
  });

  it("refuses a request with the policy's reason, not a missing-feature one", async () => {
    const provider = new hermes.HermesAgentProvider("", blocked);
    const events = [];
    for await (const event of provider.chat({
      model: "any",
      messages: [],
      contextSize: null,
      keepAlive: null,
      reasoningEffort: null,
    })) {
      events.push(event);
    }

    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, "error");
    assert.equal(events[0]?.type === "error" && events[0].code, "not_configured");
  });

  it("still refuses honestly when the policy would allow it", async () => {
    const provider = new hermes.HermesAgentProvider(
      "",
      approvals.resolveApprovalPolicies({ run_command: "auto" }),
    );

    const events = [];
    for await (const event of provider.chat({
      model: "any",
      messages: [],
      contextSize: null,
      keepAlive: null,
      reasoningEffort: null,
    })) {
      events.push(event);
    }

    assert.equal(events[0]?.type === "error" && events[0].code, "unsupported");
  });

  it("rejects a relative configured path before touching the filesystem", () => {
    const located = hermes.locateHermes("./hermes");
    assert.equal(located.found, false);
    assert.match(located.problem ?? "", /absolute/);
  });
});
