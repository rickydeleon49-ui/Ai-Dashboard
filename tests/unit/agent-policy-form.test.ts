import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  argvToText,
  textToArgv,
  isPolicyDirty,
} from "../../src/components/agents/settings/policy-form";
import type { ProjectPolicy } from "../../src/core/agents/policy";

describe("policy-form helpers", () => {
  describe("round trips", () => {
    it("round trips simple argv", () => {
      const argv = ["npm", "run", "test"];
      const text = argvToText(argv);
      assert.equal(text, "npm run test");
      assert.deepStrictEqual(textToArgv(text), argv);
    });

    it("round trips argv with an item containing a space", () => {
      const argv = ["echo", "hello world"];
      const text = argvToText(argv);
      assert.equal(text, 'echo "hello world"');
      assert.deepStrictEqual(textToArgv(text), argv);
    });

    it("round trips argv with multiple items containing spaces", () => {
      const argv = ["git", "commit", "-m", "fix: special bug", "--author", "John Doe"];
      const text = argvToText(argv);
      assert.equal(text, 'git commit -m "fix: special bug" --author "John Doe"');
      assert.deepStrictEqual(textToArgv(text), argv);
    });
  });

  describe("quotes and escaping", () => {
    it("parses double-quoted arguments", () => {
      assert.deepStrictEqual(textToArgv('git commit -m "initial commit"'), [
        "git",
        "commit",
        "-m",
        "initial commit",
      ]);
    });

    it("parses single quoted expression as whole token", () => {
      assert.deepStrictEqual(textToArgv('"single quoted"'), ["single quoted"]);
    });

    it("parses adjacent quoted arguments", () => {
      assert.deepStrictEqual(textToArgv('cmd "first arg" "second arg"'), [
        "cmd",
        "first arg",
        "second arg",
      ]);
    });
  });

  describe("whitespace handling", () => {
    it("handles extra spaces between arguments", () => {
      assert.deepStrictEqual(textToArgv("   npm    run    test   "), [
        "npm",
        "run",
        "test",
      ]);
    });

    it("preserves spaces inside quotes while trimming outer extra spaces", () => {
      assert.deepStrictEqual(
        textToArgv('  echo   "hello   world"   end  '),
        ["echo", "hello   world", "end"],
      );
    });
  });

  describe("empty text handling", () => {
    it("returns empty array for empty string", () => {
      assert.deepStrictEqual(textToArgv(""), []);
    });

    it("returns empty array for whitespace-only string", () => {
      assert.deepStrictEqual(textToArgv("   "), []);
      assert.deepStrictEqual(textToArgv("\t\n  "), []);
    });

    it("returns empty array for empty quotes", () => {
      assert.deepStrictEqual(textToArgv('""'), []);
      assert.deepStrictEqual(textToArgv('  ""   '), []);
    });

    it("drops empty quoted items among tokens", () => {
      assert.deepStrictEqual(textToArgv('foo "" bar'), ["foo", "bar"]);
    });
  });

  describe("isPolicyDirty", () => {
    const base: ProjectPolicy = {
      checks: [
        { name: "test", argv: ["npm", "test"], timeoutSec: 60, required: true },
      ],
      excludedPaths: ["secret/**"],
      dependencyLinks: ["node_modules"],
    };

    it("returns false for identical policies", () => {
      assert.equal(isPolicyDirty(base, structuredClone(base)), false);
    });

    it("returns false for empty identical policies", () => {
      assert.equal(
        isPolicyDirty(
          { checks: [], excludedPaths: [], dependencyLinks: [] },
          { checks: [], excludedPaths: [], dependencyLinks: [] },
        ),
        false,
      );
    });

    it("returns true when check name changes", () => {
      const modified: ProjectPolicy = {
        ...base,
        checks: [{ ...base.checks[0]!, name: "lint" }],
      };
      assert.equal(isPolicyDirty(modified, base), true);
    });

    it("returns true when check argv changes", () => {
      const modified: ProjectPolicy = {
        ...base,
        checks: [{ ...base.checks[0]!, argv: ["npm", "run", "test"] }],
      };
      assert.equal(isPolicyDirty(modified, base), true);
    });

    it("returns true when check timeoutSec changes", () => {
      const modified: ProjectPolicy = {
        ...base,
        checks: [{ ...base.checks[0]!, timeoutSec: 120 }],
      };
      assert.equal(isPolicyDirty(modified, base), true);
    });

    it("returns true when check required changes", () => {
      const modified: ProjectPolicy = {
        ...base,
        checks: [{ ...base.checks[0]!, required: false }],
      };
      assert.equal(isPolicyDirty(modified, base), true);
    });

    it("returns true when check is added or removed", () => {
      const added: ProjectPolicy = {
        ...base,
        checks: [
          ...base.checks,
          { name: "lint", argv: ["npm", "run", "lint"], timeoutSec: 30, required: false },
        ],
      };
      assert.equal(isPolicyDirty(added, base), true);

      const removed: ProjectPolicy = {
        ...base,
        checks: [],
      };
      assert.equal(isPolicyDirty(removed, base), true);
    });

    it("returns true when excludedPaths change", () => {
      const changed: ProjectPolicy = {
        ...base,
        excludedPaths: ["other/**"],
      };
      assert.equal(isPolicyDirty(changed, base), true);

      const added: ProjectPolicy = {
        ...base,
        excludedPaths: ["secret/**", "*.env"],
      };
      assert.equal(isPolicyDirty(added, base), true);
    });

    it("returns true when dependencyLinks change", () => {
      const changed: ProjectPolicy = {
        ...base,
        dependencyLinks: ["vendor"],
      };
      assert.equal(isPolicyDirty(changed, base), true);

      const added: ProjectPolicy = {
        ...base,
        dependencyLinks: ["node_modules", ".cache"],
      };
      assert.equal(isPolicyDirty(added, base), true);
    });
  });
});
