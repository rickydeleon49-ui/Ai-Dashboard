/**
 * Unit tests for agent role settings (AW2-05):
 * - describeReviewIndependence (none, same-provider, separate-provider, whitespace trimming, case-sensitivity)
 * - buildRoleConfig & buildRunRequest:
 *   - default / nothing chosen matches existing shape
 *   - planner and reviewer inclusion when chosen
 *   - model and effort inclusion only when set
 *   - whitespace trimming on model, effort, provider, checks
 *   - effort outside EFFORT_LEVELS cannot be produced
 *   - every built body parses with runRequestSchema
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EFFORT_LEVELS } from "../../src/core/agents/types";
import { runRequestSchema } from "../../src/core/agents/schema";
import { describeReviewIndependence } from "../../src/components/agents/runs/role-independence";
import {
  buildRunRequest,
  buildRoleConfig,
  isEffortLevel,
} from "../../src/components/agents/runs/build-run-request";

describe("describeReviewIndependence", () => {
  describe("kind: none ('No independent review')", () => {
    it("returns 'none' when reviewer is undefined", () => {
      const res = describeReviewIndependence({
        implementer: { provider: "claude-code" },
      });
      assert.deepEqual(res, {
        kind: "none",
        label: "No independent review",
      });
    });

    it("returns 'none' when reviewer is null", () => {
      const res = describeReviewIndependence({
        implementer: { provider: "claude-code" },
        reviewer: null,
      });
      assert.deepEqual(res, {
        kind: "none",
        label: "No independent review",
      });
    });

    it("returns 'none' when reviewer provider is empty string", () => {
      const res = describeReviewIndependence({
        implementer: { provider: "claude-code" },
        reviewer: { provider: "" },
      });
      assert.deepEqual(res, {
        kind: "none",
        label: "No independent review",
      });
    });

    it("returns 'none' when reviewer provider is whitespace only", () => {
      const res = describeReviewIndependence({
        implementer: { provider: "claude-code" },
        reviewer: { provider: "   \t\n  " },
      });
      assert.deepEqual(res, {
        kind: "none",
        label: "No independent review",
      });
    });
  });

  describe("kind: same-provider ('Same provider, separate session')", () => {
    it("returns 'same-provider' when reviewer equals implementer", () => {
      const res = describeReviewIndependence({
        implementer: { provider: "claude-code" },
        reviewer: { provider: "claude-code" },
      });
      assert.deepEqual(res, {
        kind: "same-provider",
        label: "Same provider, separate session",
      });
    });

    it("returns 'same-provider' when matching after trimming whitespace", () => {
      const res = describeReviewIndependence({
        implementer: { provider: "  claude-code  " },
        reviewer: { provider: "\tclaude-code \n" },
      });
      assert.deepEqual(res, {
        kind: "same-provider",
        label: "Same provider, separate session",
      });
    });

    it("returns 'same-provider' for other providers like fake", () => {
      const res = describeReviewIndependence({
        implementer: { provider: "fake" },
        reviewer: { provider: "fake" },
      });
      assert.deepEqual(res, {
        kind: "same-provider",
        label: "Same provider, separate session",
      });
    });
  });

  describe("kind: separate-provider ('Different provider')", () => {
    it("returns 'separate-provider' when providers differ", () => {
      const res = describeReviewIndependence({
        implementer: { provider: "claude-code" },
        reviewer: { provider: "codex" },
      });
      assert.deepEqual(res, {
        kind: "separate-provider",
        label: "Different provider",
      });
    });

    it("returns 'separate-provider' with whitespace-trimmed different providers", () => {
      const res = describeReviewIndependence({
        implementer: { provider: " claude-code " },
        reviewer: { provider: " fake " },
      });
      assert.deepEqual(res, {
        kind: "separate-provider",
        label: "Different provider",
      });
    });

    it("does not case-fold provider names (exact match after trim)", () => {
      const res = describeReviewIndependence({
        implementer: { provider: "claude-code" },
        reviewer: { provider: "Claude-Code" },
      });
      assert.deepEqual(res, {
        kind: "separate-provider",
        label: "Different provider",
      });
    });
  });
});

describe("isEffortLevel helper", () => {
  it("returns true for each member of EFFORT_LEVELS", () => {
    for (const lvl of EFFORT_LEVELS) {
      assert.equal(isEffortLevel(lvl), true);
    }
  });

  it("returns false for non-effort strings or invalid types", () => {
    assert.equal(isEffortLevel(""), false);
    assert.equal(isEffortLevel("invalid"), false);
    assert.equal(isEffortLevel("HIGH"), false);
    assert.equal(isEffortLevel(null), false);
    assert.equal(isEffortLevel(undefined), false);
    assert.equal(isEffortLevel(123), false);
  });
});

describe("buildRoleConfig", () => {
  it("returns undefined when input is missing or provider is empty", () => {
    assert.equal(buildRoleConfig(undefined), undefined);
    assert.equal(buildRoleConfig(null), undefined);
    assert.equal(buildRoleConfig({ provider: "" }), undefined);
    assert.equal(buildRoleConfig({ provider: "   " }), undefined);
  });

  it("trims provider name", () => {
    const config = buildRoleConfig({ provider: "  claude-code  " });
    assert.deepEqual(config, { provider: "claude-code" });
  });

  it("includes model only when non-empty", () => {
    assert.deepEqual(buildRoleConfig({ provider: "claude-code", model: "" }), {
      provider: "claude-code",
    });
    assert.deepEqual(buildRoleConfig({ provider: "claude-code", model: "   " }), {
      provider: "claude-code",
    });
    assert.deepEqual(
      buildRoleConfig({ provider: "claude-code", model: "claude-3-7-sonnet" }),
      { provider: "claude-code", model: "claude-3-7-sonnet" },
    );
    assert.deepEqual(
      buildRoleConfig({ provider: "claude-code", model: "  claude-3-7-sonnet  " }),
      { provider: "claude-code", model: "claude-3-7-sonnet" },
    );
  });

  it("includes effort only when valid EFFORT_LEVELS member", () => {
    for (const level of EFFORT_LEVELS) {
      assert.deepEqual(
        buildRoleConfig({ provider: "claude-code", effort: level }),
        { provider: "claude-code", effort: level },
      );
    }
  });

  it("cannot produce an effort outside EFFORT_LEVELS", () => {
    const invalidEfforts = ["", "   ", "invalid", "ultra", "super-high", "none-existing", "MAX"];
    for (const invalid of invalidEfforts) {
      const config = buildRoleConfig({ provider: "claude-code", effort: invalid });
      assert.deepEqual(config, { provider: "claude-code" });
      assert.equal("effort" in (config ?? {}), false);
    }
  });
});

describe("buildRunRequest", () => {
  it("produces existing shape when nothing new is chosen (implementer only)", () => {
    const req = buildRunRequest({
      projectId: "proj-1",
      task: "Fix a bug",
      roles: {
        implementer: { provider: "claude-code" },
      },
      checks: "",
    });

    assert.deepEqual(req, {
      projectId: "proj-1",
      task: "Fix a bug",
      roles: {
        implementer: { provider: "claude-code" },
      },
      checks: [],
    });

    // Validates against runRequestSchema
    const parsed = runRequestSchema.parse(req);
    assert.deepEqual(parsed, req);
  });

  it("produces existing shape when optional roles and models/efforts are empty", () => {
    const req = buildRunRequest({
      projectId: "proj-1",
      task: "Fix a bug",
      roles: {
        implementer: { provider: "claude-code", model: "", effort: "" },
        planner: { provider: "", model: "", effort: "" },
        reviewer: { provider: "", model: "", effort: "" },
      },
      checks: "",
    });

    assert.deepEqual(req, {
      projectId: "proj-1",
      task: "Fix a bug",
      roles: {
        implementer: { provider: "claude-code" },
      },
      checks: [],
    });

    const parsed = runRequestSchema.parse(req);
    assert.deepEqual(parsed, req);
  });

  it("includes planner when picked without model/effort (same shape as before)", () => {
    const req = buildRunRequest({
      projectId: "proj-1",
      task: "Plan and fix",
      roles: {
        implementer: { provider: "claude-code" },
        planner: { provider: "fake" },
      },
    });

    assert.deepEqual(req, {
      projectId: "proj-1",
      task: "Plan and fix",
      roles: {
        implementer: { provider: "claude-code" },
        planner: { provider: "fake" },
      },
      checks: [],
    });

    const parsed = runRequestSchema.parse(req);
    assert.deepEqual(parsed, req);
  });

  it("includes reviewer when picked without model/effort (same shape as before)", () => {
    const req = buildRunRequest({
      projectId: "proj-1",
      task: "Review and fix",
      roles: {
        implementer: { provider: "claude-code" },
        reviewer: { provider: "claude-code" },
      },
    });

    assert.deepEqual(req, {
      projectId: "proj-1",
      task: "Review and fix",
      roles: {
        implementer: { provider: "claude-code" },
        reviewer: { provider: "claude-code" },
      },
      checks: [],
    });

    const parsed = runRequestSchema.parse(req);
    assert.deepEqual(parsed, req);
  });

  it("includes model and effort for each role only when set", () => {
    const req = buildRunRequest({
      projectId: "proj-1",
      task: "Full run with model and effort",
      roles: {
        implementer: {
          provider: "claude-code",
          model: "claude-3-7-sonnet-20250219",
          effort: "high",
        },
        planner: {
          provider: "fake",
          model: "default",
          effort: "low",
        },
        reviewer: {
          provider: "claude-code",
          model: "claude-opus-5-5",
          effort: "medium",
        },
      },
      checks: "lint, typecheck",
    });

    assert.deepEqual(req, {
      projectId: "proj-1",
      task: "Full run with model and effort",
      roles: {
        implementer: {
          provider: "claude-code",
          model: "claude-3-7-sonnet-20250219",
          effort: "high",
        },
        planner: {
          provider: "fake",
          model: "default",
          effort: "low",
        },
        reviewer: {
          provider: "claude-code",
          model: "claude-opus-5-5",
          effort: "medium",
        },
      },
      checks: ["lint", "typecheck"],
    });

    const parsed = runRequestSchema.parse(req);
    assert.deepEqual(parsed, req);
  });

  it("accepts checks as an array or a comma/space separated string", () => {
    const reqFromString = buildRunRequest({
      projectId: "p1",
      task: "t1",
      roles: { implementer: { provider: "fake" } },
      checks: "lint, typecheck   test:unit",
    });
    assert.deepEqual(reqFromString.checks, ["lint", "typecheck", "test:unit"]);

    const reqFromArray = buildRunRequest({
      projectId: "p1",
      task: "t1",
      roles: { implementer: { provider: "fake" } },
      checks: ["lint", "typecheck", "test:unit"],
    });
    assert.deepEqual(reqFromArray.checks, ["lint", "typecheck", "test:unit"]);
  });

  it("cannot produce an effort outside EFFORT_LEVELS in any role", () => {
    const invalidAttempts = ["super-high", "turbo", "invalid", "HIGH", "max_effort", ""];
    for (const badEffort of invalidAttempts) {
      const req = buildRunRequest({
        projectId: "proj-1",
        task: "Check effort guarding",
        roles: {
          implementer: { provider: "claude-code", effort: badEffort },
          planner: { provider: "fake", effort: badEffort },
          reviewer: { provider: "claude-code", effort: badEffort },
        },
      });

      assert.equal("effort" in req.roles.implementer, false);
      if (req.roles.planner) {
        assert.equal("effort" in req.roles.planner, false);
      }
      if (req.roles.reviewer) {
        assert.equal("effort" in req.roles.reviewer, false);
      }

      // Must parse cleanly without invalid effort errors
      const parsed = runRequestSchema.parse(req);
      assert.deepEqual(parsed, req);
    }
  });

  it("every built body parses with runRequestSchema across all effort levels", () => {
    for (const level of EFFORT_LEVELS) {
      const req = buildRunRequest({
        projectId: "p-all",
        task: `Testing effort level ${level}`,
        roles: {
          implementer: { provider: "claude-code", effort: level },
          planner: { provider: "fake", effort: level },
          reviewer: { provider: "claude-code", effort: level },
        },
      });
      assert.equal(req.roles.implementer.effort, level);
      assert.equal(req.roles.planner?.effort, level);
      assert.equal(req.roles.reviewer?.effort, level);

      const parsed = runRequestSchema.parse(req);
      assert.deepEqual(parsed, req);
    }
  });
});
