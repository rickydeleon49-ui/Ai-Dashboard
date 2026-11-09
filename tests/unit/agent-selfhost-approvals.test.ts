/**
 * AW5-05: agent runs in self-hosted mode, and fresh sign-in for approval
 * decisions and project policy changes.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { cleanup, migrate } from "../helpers/db";
import { isAgentRunsEnabled } from "../../src/core/agents/availability";
import {
  clearOperatorCache,
  createOperatorRecord,
  writeOperatorFile,
} from "../../src/core/selfhost/operator-store";
import {
  OPERATOR_COOKIE,
  RECENT_SIGN_IN_MS,
  createOperatorSession,
} from "../../src/core/auth/operator";
import { agentRunApprovals, agentRuns, projects } from "../../src/db/schema";

const SELF_HOSTED = { AGENT_HOST_MODE: "self-hosted", HOSTNAME: "127.0.0.1" };

describe("isAgentRunsEnabled: self-hosted", () => {
  it("is true for a valid self-hosted environment, no desktop secret needed", () => {
    assert.equal(isAgentRunsEnabled({ ...SELF_HOSTED }), true);
    assert.equal(
      isAgentRunsEnabled({ ...SELF_HOSTED, HOSTNAME: "localhost" }),
      true,
    );
  });

  it("is false when any forbidden variable is present", () => {
    const forbidden: Array<Record<string, string>> = [
      { AUTH_MODE: "accounts" },
      { DASHBOARD_PASSWORD: "hunter2hunter2" },
      { DATABASE_URL: "postgres://x" },
      { RAILWAY_ENVIRONMENT: "production" },
      { RAILWAY_PROJECT_ID: "abc" },
      { DASHBOARD_LOCAL: "1" },
      { DESKTOP_INTERNAL_SECRET: "secret-xyz" },
    ];
    for (const extra of forbidden) {
      assert.equal(
        isAgentRunsEnabled({ ...SELF_HOSTED, ...extra }),
        false,
        JSON.stringify(Object.keys(extra)),
      );
    }
  });

  it("is false for a missing or unsafe HOSTNAME and a wrong mode value", () => {
    assert.equal(isAgentRunsEnabled({ AGENT_HOST_MODE: "self-hosted" }), false);
    assert.equal(
      isAgentRunsEnabled({ ...SELF_HOSTED, HOSTNAME: "0.0.0.0" }),
      false,
    );
    assert.equal(isAgentRunsEnabled({ ...SELF_HOSTED, HOSTNAME: "" }), false);
    for (const mode of ["Self-Hosted", "self-hosted ", "true", "", "1"]) {
      assert.equal(
        isAgentRunsEnabled({
          AGENT_HOST_MODE: mode,
          HOSTNAME: "127.0.0.1",
          DASHBOARD_LOCAL: "1",
          DESKTOP_INTERNAL_SECRET: "secret-xyz",
        }),
        false,
        JSON.stringify(mode),
      );
    }
  });

  it("leaves desktop and hosted behaviour unchanged", () => {
    const desktop = {
      DASHBOARD_LOCAL: "1",
      DESKTOP_INTERNAL_SECRET: "secret-xyz",
    };
    assert.equal(isAgentRunsEnabled(desktop), true);
    assert.equal(isAgentRunsEnabled({ DASHBOARD_LOCAL: "1" }), false);
    assert.equal(isAgentRunsEnabled({ HOSTNAME: "127.0.0.1" }), false);
    assert.equal(
      isAgentRunsEnabled({ ...desktop, DASHBOARD_PASSWORD: "x" }),
      false,
    );
    assert.equal(
      isAgentRunsEnabled({
        ...desktop,
        AUTH_MODE: "accounts",
        DATABASE_URL: "p://x",
      }),
      false,
    );
  });
});

const env = process.env as Record<string, string | undefined>;
const TOUCHED = [
  "AGENT_HOST_MODE",
  "HOSTNAME",
  "AUTH_MODE",
  "DATABASE_URL",
  "DASHBOARD_PASSWORD",
  "DASHBOARD_LOCAL",
  "DESKTOP_INTERNAL_SECRET",
  "OPERATOR_FILE",
] as const;
const original = Object.fromEntries(TOUCHED.map((k) => [k, env[k]]));

let db: typeof import("../../src/db/client").db;
let approvalRoute: typeof import("../../src/app/api/agent-runs/[id]/approvals/[approvalId]/route");
let policyRoute: typeof import("../../src/app/api/agent-projects/[id]/policy/route");
let dir: string;
let key: string;

const PROJECT = "prj-aw505";
const RUN = "run-aw505";
let n = 0;

before(async () => {
  await migrate();
  ({ db } = await import("../../src/db/client"));
  approvalRoute =
    await import("../../src/app/api/agent-runs/[id]/approvals/[approvalId]/route");
  policyRoute =
    await import("../../src/app/api/agent-projects/[id]/policy/route");

  dir = fs.mkdtempSync(path.join(os.tmpdir(), "aw5-05-"));
  const record = await createOperatorRecord("correct horse battery");
  writeOperatorFile(path.join(dir, "operator.json"), record);
  key = record.sessionKey;

  db.insert(projects)
    .values({ id: PROJECT, name: "AW505", localPath: dir })
    .run();
  db.insert(agentRuns)
    .values({
      id: RUN,
      projectId: PROJECT,
      status: "succeeded",
      stage: "final",
      request: "{}",
    })
    .run();
});

after(async () => {
  fs.rmSync(dir, { recursive: true, force: true });
  await cleanup();
});

beforeEach(() => {
  for (const k of TOUCHED) delete env[k];
  clearOperatorCache();
});

afterEach(() => {
  for (const k of TOUCHED) {
    if (original[k] === undefined) delete env[k];
    else env[k] = original[k];
  }
  clearOperatorCache();
});

function useSelfHosted() {
  env.AGENT_HOST_MODE = "self-hosted";
  env.HOSTNAME = "127.0.0.1";
  env.OPERATOR_FILE = path.join(dir, "operator.json");
  clearOperatorCache();
}

function useDesktop() {
  env.DASHBOARD_LOCAL = "1";
  env.DESKTOP_INTERNAL_SECRET = "secret-for-test";
}

async function cookie(authAgoMs: number): Promise<string> {
  const created = await createOperatorSession(Date.now() - authAgoMs, key);
  assert.ok(created);
  return `${OPERATOR_COOKIE}=${created.value}`;
}

function req(
  url: string,
  method: string,
  body: unknown,
  cookieHeader?: string,
): NextRequest {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (cookieHeader) headers.set("cookie", cookieHeader);
  return new NextRequest(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function addApproval(): string {
  const id = `appr-aw505-${++n}`;
  db.insert(agentRunApprovals)
    .values({ id, runId: RUN, kind: "push", status: "pending", target: "{}" })
    .run();
  return id;
}

const statusOf = (id: string) =>
  db.select().from(agentRunApprovals).where(eq(agentRunApprovals.id, id)).get()
    ?.status;

async function decide(id: string, decision: string, cookieHeader?: string) {
  return approvalRoute.POST(
    req(
      `http://localhost/api/agent-runs/${RUN}/approvals/${id}`,
      "POST",
      { decision },
      cookieHeader,
    ),
    { params: Promise.resolve({ id: RUN, approvalId: id }) },
  );
}

describe("approval decision route", () => {
  it("self-hosted: stale sign-in gets reauth_required and nothing changes", async () => {
    useSelfHosted();
    const id = addApproval();
    for (const decision of ["approve", "reject"]) {
      const res = await decide(
        id,
        decision,
        await cookie(RECENT_SIGN_IN_MS + 60_000),
      );
      assert.equal(res.status, 401);
      assert.deepEqual(await res.json(), { error: "reauth_required" });
      assert.equal(statusOf(id), "pending");
    }
  });

  it("self-hosted: no cookie is refused before any work", async () => {
    useSelfHosted();
    const id = addApproval();
    const res = await decide(id, "approve");
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "reauth_required" });
    assert.equal(statusOf(id), "pending");
  });

  it("self-hosted: fresh sign-in proceeds", async () => {
    useSelfHosted();
    const id = addApproval();
    const res = await decide(id, "approve", await cookie(30_000));
    assert.equal(res.status, 202);
    assert.equal(statusOf(id), "approved");
    const id2 = addApproval();
    const rej = await decide(id2, "reject", await cookie(30_000));
    assert.equal(rej.status, 200);
    assert.equal(statusOf(id2), "rejected");
  });

  it("desktop: needs no operator session", async () => {
    useDesktop();
    const id = addApproval();
    const res = await decide(id, "approve");
    assert.equal(res.status, 202);
    assert.equal(statusOf(id), "approved");
  });

  it("answers 404 when agent runs are disabled", async () => {
    const id = addApproval();
    assert.equal((await decide(id, "approve")).status, 404);
    assert.equal(statusOf(id), "pending");
  });
});

describe("project policy route", () => {
  const url = `http://localhost/api/agent-projects/${PROJECT}/policy`;
  const ctx = { params: Promise.resolve({ id: PROJECT }) };

  async function defaultPolicy(): Promise<unknown> {
    const res = await policyRoute.GET(req(url, "GET", undefined), ctx);
    assert.equal(res.status, 200);
    return (await res.json()).policy;
  }

  it("self-hosted: stale or missing sign-in blocks PUT", async () => {
    useSelfHosted();
    const policy = await defaultPolicy();
    const stale = await policyRoute.PUT(
      req(url, "PUT", policy, await cookie(RECENT_SIGN_IN_MS + 60_000)),
      ctx,
    );
    assert.equal(stale.status, 401);
    assert.deepEqual(await stale.json(), { error: "reauth_required" });
    const none = await policyRoute.PUT(req(url, "PUT", policy), ctx);
    assert.equal(none.status, 401);
  });

  it("self-hosted: fresh sign-in allows PUT", async () => {
    useSelfHosted();
    const policy = await defaultPolicy();
    const res = await policyRoute.PUT(
      req(url, "PUT", policy, await cookie(30_000)),
      ctx,
    );
    assert.equal(res.status, 200);
  });

  it("desktop: PUT needs no operator session", async () => {
    useDesktop();
    const policy = await defaultPolicy();
    const res = await policyRoute.PUT(req(url, "PUT", policy), ctx);
    assert.equal(res.status, 200);
  });
});
