/**
 * Tests for authentication sign-in delivery hardening:
 * - Production must fail closed when email provider is not configured.
 * - Never log complete magic-link URL or token in production.
 * - Development-only console delivery requires explicit opt-in (AUTH_LOG_MAGIC_LINK=true).
 * - Console delivery is rejected in production even with opt-in.
 * - Configured SMTP uses nodemailer transport.
 */
import assert from "node:assert/strict";
import { afterEach, before, beforeEach, describe, it } from "node:test";
import React from "react";

if (typeof (React as { createContext?: unknown }).createContext !== "function") {
  (React as { createContext?: unknown }).createContext = () => ({
    Provider: ({ children }: { children: unknown }) => children,
    Consumer: ({ children }: { children: (val: unknown) => unknown }) => children(null),
  });
}

let sendVerificationRequest: (typeof import("../../src/auth"))["sendVerificationRequest"];

before(async () => {
  ({ sendVerificationRequest } = await import("../../src/auth"));
});

const SNAPSHOT_KEYS = [
  "NODE_ENV",
  "EMAIL_SERVER",
  "EMAIL_FROM",
  "AUTH_LOG_MAGIC_LINK",
] as const;

const env = process.env as Record<string, string | undefined>;
let envSnapshot: Record<string, string | undefined>;

beforeEach(() => {
  envSnapshot = {};
  for (const k of SNAPSHOT_KEYS) {
    envSnapshot[k] = env[k];
  }
});

afterEach(() => {
  for (const k of SNAPSHOT_KEYS) {
    if (envSnapshot[k] === undefined) {
      delete env[k];
    } else {
      env[k] = envSnapshot[k];
    }
  }
});

async function captureConsole(fn: () => Promise<void>): Promise<string[]> {
  const logs: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.warn = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.log = origLog;
    console.error = origError;
    console.warn = origWarn;
  }
  return logs;
}

describe("auth sign-in delivery hardening", () => {
  it("fails closed in production without EMAIL_SERVER and never logs tokens", async () => {
    env.NODE_ENV = "production";
    delete env.EMAIL_SERVER;
    delete env.AUTH_LOG_MAGIC_LINK;

    const token = "secret-magic-token-998877";
    const magicUrl = `http://localhost/api/auth/callback/nodemailer?token=${token}&email=test%40example.com`;

    const logs = await captureConsole(async () => {
      await assert.rejects(
        async () => {
          await sendVerificationRequest({
            identifier: "test@example.com",
            url: magicUrl,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, /EMAIL_SERVER is not configured/);
          return true;
        },
      );
    });

    assert.equal(logs.length, 0, "no logs should be emitted in production failure");
  });

  it("rejects console delivery opt-in in production and fails closed", async () => {
    env.NODE_ENV = "production";
    delete env.EMAIL_SERVER;
    env.AUTH_LOG_MAGIC_LINK = "true";

    const token = "secret-token-do-not-leak";
    const magicUrl = `http://localhost/api/auth/callback/nodemailer?token=${token}`;

    const logs = await captureConsole(async () => {
      await assert.rejects(
        async () => {
          await sendVerificationRequest({
            identifier: "prod-optin@example.com",
            url: magicUrl,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, /EMAIL_SERVER is not configured/);
          return true;
        },
      );
    });

    assert.equal(logs.length, 0, "production must never log magic link even if AUTH_LOG_MAGIC_LINK is true");
  });

  it("fails closed in development when opt-in is absent (disabled by default)", async () => {
    env.NODE_ENV = "development";
    delete env.EMAIL_SERVER;
    delete env.AUTH_LOG_MAGIC_LINK;

    const logs = await captureConsole(async () => {
      await assert.rejects(
        async () => {
          await sendVerificationRequest({
            identifier: "dev-no-optin@example.com",
            url: "http://localhost/api/auth/callback/nodemailer?token=dev-token",
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, /Set AUTH_LOG_MAGIC_LINK=true/);
          return true;
        },
      );
    });

    assert.equal(logs.length, 0, "no logs should be emitted in dev without explicit opt-in");
  });

  it("allows console delivery in development with explicit opt-in", async () => {
    env.NODE_ENV = "development";
    delete env.EMAIL_SERVER;
    env.AUTH_LOG_MAGIC_LINK = "true";

    const magicUrl = "http://localhost/api/auth/callback/nodemailer?token=dev-token-opted-in";
    const logs = await captureConsole(async () => {
      await sendVerificationRequest({
        identifier: "dev-optin@example.com",
        url: magicUrl,
      });
    });

    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /\[auth\] magic link for dev-optin@example\.com/);
    assert.ok(logs[0]!.includes(magicUrl));
  });

  it("uses nodemailer when EMAIL_SERVER is configured", async () => {
    env.NODE_ENV = "production";
    env.EMAIL_SERVER = "smtp://smtp.example.com:587";
    env.EMAIL_FROM = "Test Sender <sender@example.com>";

    const nodemailer = await import("nodemailer");
    const dummyTransport = nodemailer.createTransport("smtp://localhost:1234");
    const MailClass = dummyTransport.constructor as unknown as {
      prototype: { sendMail: (options: unknown) => Promise<unknown> };
    };

    const origSendMail = MailClass.prototype.sendMail;
    let sendMailCalledWith: unknown = null;

    MailClass.prototype.sendMail = async function (options: unknown) {
      sendMailCalledWith = options;
      return { messageId: "mock-mail-id-123" };
    };

    try {
      await sendVerificationRequest({
        identifier: "smtp-user@example.com",
        url: "http://localhost/api/auth/callback/nodemailer?token=smtp-token",
      });

      assert.deepEqual(sendMailCalledWith, {
        to: "smtp-user@example.com",
        from: "Test Sender <sender@example.com>",
        subject: "Sign in to localhost",
        text: "Sign in to localhost\n\nhttp://localhost/api/auth/callback/nodemailer?token=smtp-token\n\n",
        html: '<p><a href="http://localhost/api/auth/callback/nodemailer?token=smtp-token">Sign in to localhost</a></p>',
      });
    } finally {
      MailClass.prototype.sendMail = origSendMail;
    }
  });
});
