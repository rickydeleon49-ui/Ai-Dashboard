/**
 * Agent output redaction (AW1-02). Exhaustive on purpose: this is the last
 * line of defence before agent output is stored or shown.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CIRCULAR,
  REDACTED,
  isSecretName,
  redactText,
  redactValue,
} from "../../src/core/agents/redact";

const A = "abcdefghijklmnopqrstuvwxyz0123456789";

function assertRedacts(input: string, secret: string): void {
  const out = redactText(input);
  assert.ok(!out.includes(secret), `secret leaked: ${out}`);
  assert.ok(out.includes(REDACTED), `no marker: ${out}`);
}

describe("redactText: token patterns", () => {
  const cases: Array<[string, string]> = [
    ["anthropic", `sk-ant-api03-${A}_-${A}`],
    ["openai", `sk-${A}ABCDEF`],
    ["openai project", `sk-proj-${A}_${A}`],
    ["github ghp", `ghp_${A}`],
    ["github gho", `gho_${A}`],
    ["github ghu", `ghu_${A}`],
    ["github ghs", `ghs_${A}`],
    ["github ghr", `ghr_${A}`],
    ["github fine-grained", `github_pat_11ABCDEFG0${A}_${A}`],
    ["google api key", `AIza${A}ABCDEFGHI`],
    ["aws access key id", "AKIAIOSFODNN7EXAMPLE"],
    ["aws temp key id", "ASIAIOSFODNN7EXAMPLE"],
    ["slack xoxb", "xoxb-1234567890-abcdefghij"],
    ["slack xoxa", "xoxa-1234567890-abcdefghij"],
    ["slack xoxp", "xoxp-1234567890-abcdefghij"],
    ["slack xoxr", "xoxr-1234567890-abcdefghij"],
  ];
  for (const [label, secret] of cases) {
    it(`redacts ${label}`, () => {
      assertRedacts(`token is ${secret} ok`, secret);
      assert.equal(redactText(`token is ${secret} ok`), `token is ${REDACTED} ok`);
    });
    it(`redacts ${label} at string start and end`, () => {
      assert.equal(redactText(secret), REDACTED);
      assert.equal(redactText(`${secret}\n`), `${REDACTED}\n`);
      assert.equal(redactText(`x ${secret}`), `x ${REDACTED}`);
    });
  }

  it("redacts a Bearer token and keeps the word Bearer", () => {
    const out = redactText(`curl Bearer ${A}.${A}-_~+/=`);
    assert.ok(out.includes("Bearer "));
    assert.ok(!out.includes(A));
    assert.equal(redactText("bearer abcdefghijklmnopqrstuvwxyz"), `bearer ${REDACTED}`);
  });

  it("redacts several secrets on one line", () => {
    const line = `a=ghp_${A} b=sk-${A} c=AKIAIOSFODNN7EXAMPLE d=xoxb-1234567890-abcdefghij`;
    const out = redactText(line);
    assert.ok(!/ghp_|sk-|AKIA|xoxb/.test(out), out);
    assert.equal(out.split(REDACTED).length - 1, 4);
  });

  it("redacts multiple tokens separated by punctuation", () => {
    const out = redactText(`(ghp_${A}),"sk-${A}";AKIAIOSFODNN7EXAMPLE.`);
    assert.equal(out, `(${REDACTED}),"${REDACTED}";${REDACTED}.`);
  });
});

describe("redactText: negatives", () => {
  const untouched = [
    "",
    "just ordinary text with words like task-force and risk-averse",
    "sk",
    "sk-",
    "sk-short",
    "the sk-ant prefix is documented",
    "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
    "commit 4b825dc642cb6eb9a060e54bf8d69288fbee4904 on main",
    "550e8400-e29b-41d4-a716-446655440000",
    "ghp_short",
    "github_pat_",
    "AKIA123",
    "AIza",
    "xoxz-1234567890-abcdefghij",
    "Bearer tokens are explained below",
    "Bearer authentication",
    "max_tokens=1000",
    '{"max_tokens": 4096, "monkey": "banana"}',
    "keyboard=us key-value pairs",
    "https://example.com/path?x=1&y=2",
    "line one\nline two\n  indented",
    "PATH=/usr/bin:/bin",
    "NODE_ENV=production",
  ];
  for (const text of untouched) {
    it(`leaves unchanged: ${JSON.stringify(text.slice(0, 40))}`, () => {
      assert.equal(redactText(text), text);
    });
  }

  it("does not match sk- inside a longer word", () => {
    const t = `task-${A}${A}`;
    assert.equal(redactText(t), t);
  });

  it("does not corrupt non-string input", () => {
    assert.equal(redactText(undefined as unknown as string), undefined);
  });
});

describe("redactText: HTTP headers", () => {
  it("keeps the header name and redacts the value", () => {
    assert.equal(redactText("Authorization: Bearer abc"), `Authorization: ${REDACTED}`);
    assert.equal(redactText("Authorization: Basic dXNlcjpwYXNz"), `Authorization: ${REDACTED}`);
    assert.equal(
      redactText("Proxy-Authorization: Basic dXNlcjpwYXNz"),
      `Proxy-Authorization: ${REDACTED}`,
    );
    assert.equal(redactText("x-api-key: k_12345"), `x-api-key: ${REDACTED}`);
    assert.equal(redactText("X-API-KEY:k_12345"), `X-API-KEY:${REDACTED}`);
    assert.equal(
      redactText("x-dashboard-desktop-secret: s3cr3t"),
      `x-dashboard-desktop-secret: ${REDACTED}`,
    );
    assert.equal(redactText("Cookie: sid=abc; theme=dark"), `Cookie: ${REDACTED}`);
    assert.equal(redactText("Set-Cookie: sid=abc; HttpOnly"), `Set-Cookie: ${REDACTED}`);
    assert.equal(redactText("X-Custom-Token: zzz"), `X-Custom-Token: ${REDACTED}`);
  });

  it("only redacts the header line", () => {
    assert.equal(
      redactText("GET / HTTP/1.1\nAuthorization: Bearer abc\nHost: example.com\n"),
      `GET / HTTP/1.1\nAuthorization: ${REDACTED}\nHost: example.com\n`,
    );
  });

  it("does not eat the closing quote of a curl -H argument", () => {
    assert.equal(
      redactText(`curl -H "Authorization: Bearer abc" https://x.test`),
      `curl -H "Authorization: ${REDACTED}" https://x.test`,
    );
  });

  it("leaves unrelated headers alone", () => {
    const t = "Content-Type: application/json\nAccept: */*\nX-Request-Id: 123";
    assert.equal(redactText(t), t);
  });
});

describe("redactText: env-style and JSON assignments", () => {
  it("redacts NAME=value for secret-looking names", () => {
    const names = [
      "GITHUB_TOKEN",
      "OPENAI_API_KEY",
      "STRIPE_SECRET_KEY",
      "MY_SECRET",
      "DB_PASSWORD",
      "PASSWORD",
      "PASSWORDS_FILE",
      "DASHBOARD_DESKTOP_SECRET",
      "ANTHROPIC_API_KEY",
      "lower_case_token",
      "client.secret",
    ];
    for (const name of names) {
      assert.equal(redactText(`${name}=hunter2`), `${name}=${REDACTED}`, name);
      assert.equal(
        redactText(`export ${name}=hunter2 && run`),
        `export ${name}=${REDACTED} && run`,
        name,
      );
    }
  });

  it("handles quoted values and keeps surrounding text", () => {
    assert.equal(redactText(`A_TOKEN="has spaces" next`), `A_TOKEN="${REDACTED}" next`);
    assert.equal(redactText(`A_TOKEN='has spaces' next`), `A_TOKEN='${REDACTED}' next`);
    assert.equal(redactText("A_TOKEN=abc, B=2"), `A_TOKEN=${REDACTED}, B=2`);
  });

  it("redacts JSON name/value pairs and keeps the JSON valid", () => {
    const json = JSON.stringify({
      user: "ricky",
      apiKey: "abc123",
      access_token: "t0ken",
      clientSecret: "shh",
      password: "p@ss word",
      count: 3,
      nested: { OPENAI_API_KEY: "zzz", ok: true },
    });
    const parsed = JSON.parse(redactText(json));
    assert.equal(parsed.user, "ricky");
    assert.equal(parsed.apiKey, REDACTED);
    assert.equal(parsed.access_token, REDACTED);
    assert.equal(parsed.clientSecret, REDACTED);
    assert.equal(parsed.password, REDACTED);
    assert.equal(parsed.count, 3);
    assert.equal(parsed.nested.OPENAI_API_KEY, REDACTED);
    assert.equal(parsed.nested.ok, true);
  });

  it("handles escaped quotes inside a JSON value", () => {
    const out = redactText(String.raw`{"password": "a\"b", "x": 1}`);
    assert.deepEqual(JSON.parse(out), { password: REDACTED, x: 1 });
  });

  it("quotes the marker for unquoted JSON secret values so JSON stays valid", () => {
    const out = redactText('{"token": 12345, "n": 1}');
    assert.deepEqual(JSON.parse(out), { token: REDACTED, n: 1 });
  });

  it("is idempotent", () => {
    const once = redactText(`API_KEY=abc ghp_${A} Authorization: Bearer q`);
    assert.equal(redactText(once), once);
  });

  it("still finds a secret assignment after a non-secret one on the same line", () => {
    assert.equal(redactText("url:x_TOKEN=abc"), `url:x_TOKEN=${REDACTED}`);
  });

  it("isSecretName splits camelCase and delimiters", () => {
    for (const n of ["apiKey", "API_KEY", "x-api-key", "accessToken", "db_password", "mySecret"]) {
      assert.equal(isSecretName(n), true, n);
    }
    for (const n of ["max_tokens", "monkey", "keyboard", "name", "PATH", "tokenizer"]) {
      assert.equal(isSecretName(n), false, n);
    }
  });
});

describe("redactText: PEM private keys", () => {
  const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\nabcDEF+/==";
  const kinds = [
    "RSA PRIVATE KEY",
    "PRIVATE KEY",
    "EC PRIVATE KEY",
    "OPENSSH PRIVATE KEY",
    "ENCRYPTED PRIVATE KEY",
  ];
  for (const kind of kinds) {
    it(`redacts ${kind} blocks`, () => {
      const pem = `-----BEGIN ${kind}-----\n${body}\n-----END ${kind}-----`;
      assert.equal(redactText(`before\n${pem}\nafter`), `before\n${REDACTED}\nafter`);
    });
  }

  it("redacts an unterminated block to the end of the text", () => {
    const out = redactText(`log\n-----BEGIN PRIVATE KEY-----\n${body}`);
    assert.equal(out, `log\n${REDACTED}`);
  });

  it("redacts two blocks independently", () => {
    const pem = `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
    assert.equal(redactText(`${pem} mid ${pem}`), `${REDACTED} mid ${REDACTED}`);
  });

  it("does not redact public certificates", () => {
    const cert = `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`;
    assert.equal(redactText(cert), cert);
  });
});

describe("redactText: explicit secrets", () => {
  it("redacts every occurrence, including inside other text", () => {
    const out = redactText("pw=correct-horse; again correct-horse!x", {
      secrets: ["correct-horse"],
    });
    assert.ok(!out.includes("correct-horse"));
    assert.equal(out.split(REDACTED).length - 1, 2);
  });

  it("prefers the longest secret first", () => {
    assert.equal(redactText("abcd-efgh", { secrets: ["abcd", "abcd-efgh"] }), REDACTED);
  });

  it("ignores empty and very short secrets and non-strings", () => {
    const text = "a b c abc 123";
    const secrets = ["", "a", "abc", undefined as unknown as string];
    assert.equal(redactText(text, { secrets }), text);
  });

  it("treats regex metacharacters literally", () => {
    const weird = "x.*+?^${}()|[]\\y";
    assert.equal(redactText(weird, { secrets: [weird] }), REDACTED);
    assert.equal(redactText("xaay", { secrets: ["x.*y"] }), "xaay");
  });

  it("applies through redactValue too", () => {
    assert.deepEqual(redactValue({ msg: "pass is hunter22" }, { secrets: ["hunter22"] }), {
      msg: `pass is ${REDACTED}`,
    });
  });
});

describe("redactValue", () => {
  it("walks nested objects and arrays", () => {
    const input = {
      log: [`token ghp_${A}`, { deep: [{ line: `sk-${A}` }] }],
      n: 1,
      b: false,
      nil: null,
      undef: undefined,
    };
    assert.deepEqual(redactValue(input), {
      log: [`token ${REDACTED}`, { deep: [{ line: REDACTED }] }],
      n: 1,
      b: false,
      nil: null,
      undef: undefined,
    });
  });

  it("redacts whole values under secret-named keys, whatever their type", () => {
    const out = redactValue({
      password: "x",
      apiKey: 42,
      token: { a: 1 },
      secret: ["a", "b"],
      auth_token: null,
      max_tokens: 100,
      env: { GITHUB_TOKEN: "abc", PATH: "/bin" },
    });
    assert.deepEqual(out, {
      password: REDACTED,
      apiKey: REDACTED,
      token: REDACTED,
      secret: REDACTED,
      auth_token: null,
      max_tokens: 100,
      env: { GITHUB_TOKEN: REDACTED, PATH: "/bin" },
    });
  });

  it("does not mutate its input", () => {
    const input = { a: { token: "t", list: [`ghp_${A}`] }, s: `sk-${A}` };
    const snapshot = JSON.stringify(input);
    const out = redactValue(input);
    assert.equal(JSON.stringify(input), snapshot);
    assert.notEqual(out, input);
    assert.notEqual(out.a, input.a);
    assert.notEqual(out.a.list, input.a.list);
  });

  it("handles cycles without recursing forever", () => {
    const a: Record<string, unknown> = { name: "a", note: `ghp_${A}` };
    a.self = a;
    const list: unknown[] = [a];
    list.push(list);
    a.list = list;
    const out = redactValue(a) as Record<string, unknown>;
    assert.equal(out.note, REDACTED);
    assert.equal(out.self, CIRCULAR);
    assert.equal((out.list as unknown[])[1], CIRCULAR);
    assert.doesNotThrow(() => JSON.stringify(out));
  });

  it("keeps a shared (non-cyclic) reference redacted in both places", () => {
    const shared = { v: `ghp_${A}` };
    assert.deepEqual(redactValue({ x: shared, y: shared }), {
      x: { v: REDACTED },
      y: { v: REDACTED },
    });
  });

  it("produces JSON-serializable output and keeps structure", () => {
    const input = { a: [1, "two", { three: "AKIAIOSFODNN7EXAMPLE" }], b: "x" };
    assert.deepEqual(JSON.parse(JSON.stringify(redactValue(input))), {
      a: [1, "two", { three: REDACTED }],
      b: "x",
    });
  });

  it("passes primitives and non-plain objects through", () => {
    const d = new Date(0);
    assert.equal(redactValue(5), 5);
    assert.equal(redactValue(null), null);
    assert.equal(redactValue(true), true);
    assert.equal(redactValue(d), d);
    assert.equal(redactValue(`ghp_${A}`), REDACTED);
  });

  it("redacts Error messages", () => {
    const out = redactValue(new Error(`failed with ghp_${A}`)) as { message: string };
    assert.equal(out.message, `failed with ${REDACTED}`);
  });

  it("does not pollute prototypes via __proto__ keys", () => {
    const input = JSON.parse('{"__proto__": {"polluted": "yes"}, "ok": 1}');
    const out = redactValue(input) as Record<string, unknown>;
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.equal(Object.getPrototypeOf(out), Object.prototype);
    assert.equal(out.ok, 1);
  });

  it("stops at a depth limit instead of overflowing the stack", () => {
    let deep: Record<string, unknown> = { leaf: "x" };
    for (let i = 0; i < 5000; i++) deep = { next: deep };
    assert.doesNotThrow(() => redactValue(deep));
  });
});

describe("redactText: size and performance", () => {
  it("handles ~1 MB of mixed content quickly and still redacts", () => {
    const chunk =
      "line of ordinary log output 4b825dc642cb6eb9a060e54bf8d69288fbee4904 key-value x-y-z\n";
    const parts: string[] = [];
    for (let i = 0; i < 12000; i++) {
      parts.push(chunk);
      if (i % 1000 === 0) parts.push(`GITHUB_TOKEN=ghp_${A} Authorization: Bearer ${A}\n`);
    }
    const input = parts.join("");
    assert.ok(input.length > 1_000_000);
    const start = performance.now();
    const out = redactText(input, { secrets: ["hunter2-secret"] });
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 1000, `took ${elapsed}ms`);
    assert.ok(!out.includes("ghp_"));
    assert.equal(out.split(REDACTED).length - 1, 24);
  });

  it("is linear on adversarial inputs", () => {
    const inputs = [
      "x-".repeat(300_000),
      "a".repeat(1_000_000),
      "-----BEGIN PRIVATE KEY-----".repeat(30_000),
      "Bearer ".repeat(100_000),
      "A_TOKEN ".repeat(100_000),
      "sk-".repeat(300_000),
      `"${"a".repeat(500_000)}`,
      "KEY=".repeat(200_000),
      `${" ".repeat(1_000_000)}Authorization`,
    ];
    for (const input of inputs) {
      const start = performance.now();
      redactText(input);
      const elapsed = performance.now() - start;
      assert.ok(elapsed < 1500, `took ${elapsed}ms on ${input.slice(0, 20)}`);
    }
  });

  it("truncates (never passes through) text above maxLength", () => {
    const out = redactText(`${"a ".repeat(50)}ghp_${A} ${"b ".repeat(50)}`, { maxLength: 150 });
    assert.ok(out.startsWith("a ".repeat(50)));
    assert.ok(out.includes("[truncated"));
    assert.ok(!out.includes("ghp_"));
  });

  it("does not leak the head of a token that straddles the cut", () => {
    const text = `${"word ".repeat(20)}ghp_${A.slice(0, 15)}${A.slice(15)} tail`;
    const cutInsideToken = text.indexOf("ghp_") + 19;
    const out = redactText(text, { maxLength: cutInsideToken });
    assert.ok(!out.includes("ghp_"), out);
    assert.ok(out.includes("[truncated"));
    // No whitespace at all near the cut: the whole window is dropped.
    const blob = redactText(`sk-${"x".repeat(5000)}`, { maxLength: 100 });
    assert.ok(!blob.includes("sk-"), blob);
  });

  it("redacts a secret that sits inside the cap", () => {
    const out = redactText(`ghp_${A} ${"b".repeat(1000)}`, { maxLength: 200 });
    assert.ok(out.startsWith(REDACTED));
  });
});

describe("redactText: review fixes (Antigravity)", () => {
  it("redacts URL userinfo passwords but keeps scheme, user and host", () => {
    assert.equal(
      redactText("fatal: unable to access 'https://bot-user:superSecretPassword123@github.com/org/repo.git/': 403"),
      `fatal: unable to access 'https://bot-user:${REDACTED}@github.com/org/repo.git/': 403`,
    );
    assert.equal(
      redactText("git clone ssh://git:pw@host.example:22/x.git"),
      `git clone ssh://git:${REDACTED}@host.example:22/x.git`,
    );
    assert.equal(redactText("postgres://u:p%40ss@db/x"), `postgres://u:${REDACTED}@db/x`);
  });

  it("redacts a token used as the whole URL userinfo", () => {
    assert.equal(
      redactText(`https://ghp_${A}@github.com/o/r.git`),
      `https://${REDACTED}@github.com/o/r.git`,
    );
    assert.equal(
      redactText(`https://x-access-token:ghs_${A}@github.com/o/r`),
      `https://x-access-token:${REDACTED}@github.com/o/r`,
    );
  });

  it("leaves URLs without passwords alone", () => {
    for (const u of [
      "https://github.com/org/repo.git",
      "git@github.com:org/repo.git",
      "ssh://git@github.com/org/repo.git",
      "http://localhost:3000/path?a=b:c@d",
      "see https://example.com:8080/x",
    ]) {
      assert.equal(redactText(u), u, u);
    }
  });

  it("redacts npm tokens", () => {
    const t = "npm_0123456789abcdefghijklmnopqrstuvwxyz";
    assert.equal(redactText(`+ ${t}`), `+ ${REDACTED}`);
    assert.equal(redactText("npm_short"), "npm_short");
    assert.equal(redactText("npm_install_everything_now_please_ok_thanks_x"), "npm_install_everything_now_please_ok_thanks_x");
  });

  it("redacts GitLab tokens and the Private-Token header", () => {
    assert.equal(redactText("glpat-abcdefghijklmnopqrstuvwx"), REDACTED);
    assert.equal(redactText("glpat-short"), "glpat-short");
    assert.equal(
      redactText(`curl -H "Private-Token: glpat-abcdefghijklmnopqrstuvwx" https://gitlab.com/api/v4/projects`),
      `curl -H "Private-Token: ${REDACTED}" https://gitlab.com/api/v4/projects`,
    );
    assert.equal(redactText("PRIVATE-TOKEN: abc"), `PRIVATE-TOKEN: ${REDACTED}`);
  });

  it("keeps bare key and token names redacted (fail closed)", () => {
    assert.equal(redactText("key=abc"), `key=${REDACTED}`);
    assert.equal(redactText("token: abc"), `token: ${REDACTED}`);
    assert.deepEqual(redactValue({ key: "k", token: "t" }), { key: REDACTED, token: REDACTED });
  });

  it("allowlists non-secret compound names, case and separator insensitive", () => {
    const names = [
      "public_key",
      "primary_key",
      "foreign_key",
      "sort_key",
      "partition_key",
      "routing_key",
      "cache_key",
      "key_type",
      "key_length",
      "key_id",
      "token_type",
      "token_count",
      "tokens_used",
      "max_tokens",
      "input_tokens",
      "output_tokens",
    ];
    const camel = (n: string) => n.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
    for (const n of names) {
      for (const variant of [n, n.toUpperCase(), n.replace(/_/g, "-"), n.replace(/_/g, "."), camel(n)]) {
        assert.equal(isSecretName(variant), false, variant);
        assert.equal(redactText(`${variant}=value1`), `${variant}=value1`, variant);
        assert.deepEqual(redactValue({ [variant]: "value1" }), { [variant]: "value1" }, variant);
      }
    }
    assert.equal(isSecretName("private_key"), true);
    assert.equal(isSecretName("access_token"), true);
  });

  it("keeps JSON valid when an assignment sits inside an escaped-quote string", () => {
    const log = JSON.stringify({ msg: 'Config: password: "secret"', n: 1 });
    const out = redactText(log);
    assert.ok(!out.includes("secret"), out);
    const parsed = JSON.parse(out);
    assert.equal(parsed.n, 1);
    assert.ok(parsed.msg.startsWith("Config: password: "));
    assert.ok(parsed.msg.includes(REDACTED));
  });

  it("handles JSON nested inside JSON strings", () => {
    const inner = JSON.stringify({ apiKey: "abc123", ok: true });
    const out = redactText(JSON.stringify({ payload: inner }));
    assert.ok(!out.includes("abc123"), out);
    const parsed = JSON.parse(out);
    assert.deepEqual(JSON.parse(parsed.payload), { apiKey: REDACTED, ok: true });
  });

  it("uses narrower sk- rules", () => {
    assert.equal(redactText("sk-wandering-cubes-container"), "sk-wandering-cubes-container");
    assert.equal(redactText("sk-this-is-a-long-hyphenated-slug-name-here"), "sk-this-is-a-long-hyphenated-slug-name-here");
    assert.equal(redactText(`sk-proj-${A}`), REDACTED);
    assert.equal(redactText(`sk-svcacct-${A}`), REDACTED);
    assert.equal(redactText(`sk-admin-${A}`), REDACTED);
    assert.equal(redactText(`sk-${A}${A}`), REDACTED);
    assert.equal(redactText(`sk-ant-api03-${A}`), REDACTED);
  });

  it("documents maxLength as a scan cap in the result", () => {
    const out = redactText(`${"w ".repeat(100)}`, { maxLength: 20 });
    assert.ok(out.length < 100);
    assert.ok(out.includes("[truncated"));
  });
});

describe("redactValue: Buffer, Map, Set", () => {
  it("turns a Buffer into redacted text", () => {
    const out = redactValue({ stdout: Buffer.from(`key sk-ant-api03-${A} done`) }) as { stdout: unknown };
    assert.equal(out.stdout, `key ${REDACTED} done`);
    assert.doesNotThrow(() => JSON.stringify(out));
  });

  it("turns a Map into a plain object of redacted entries", () => {
    const m = new Map<unknown, unknown>([
      ["log", `ghp_${A}`],
      ["password", "x"],
      [7, "plain"],
    ]);
    assert.deepEqual(redactValue({ m }), {
      m: { log: REDACTED, password: REDACTED, "7": "plain" },
    });
  });

  it("turns a Set into a redacted array", () => {
    assert.deepEqual(redactValue(new Set([`ghp_${A}`, "ok", { token: "t" }])), [
      REDACTED,
      "ok",
      { token: REDACTED },
    ]);
  });

  it("handles cycles through Map and Set", () => {
    const m = new Map<string, unknown>();
    m.set("self", m);
    const s = new Set<unknown>();
    s.add(s);
    assert.deepEqual(redactValue(m), { self: CIRCULAR });
    assert.deepEqual(redactValue(s), [CIRCULAR]);
  });

  it("leaves other non-plain objects (Date) alone", () => {
    const d = new Date(5);
    assert.equal(redactValue({ d }).d, d);
  });
});
