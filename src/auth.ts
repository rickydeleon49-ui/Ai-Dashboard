/**
 * Auth.js configuration — hosted multi-user mode only.
 *
 * Desktop and today's single-shared-password hosted mode never import this
 * module. It exists once `DATABASE_URL` is configured; `proxy.ts` does not
 * yet gate anything on it (that lands in a later step) — this file only
 * wires the library up so it can be exercised directly (`/api/auth/*`)
 * ahead of that.
 *
 * Two providers: GitHub OAuth and email magic links (no passwords to hash,
 * reset or leak). Database sessions, not JWT — signing out actually revokes
 * the session server-side, and a per-request workspace-membership lookup is
 * needed regardless, so a JWT would not save a database round trip anyway.
 */
import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import Nodemailer from "next-auth/providers/nodemailer";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { getPgDb } from "@/db/pg-client";
import { accounts, sessions, users, verificationTokens } from "@/db/schema.pg";

/**
 * Sends the magic-link sign-in email.
 *
 * With EMAIL_SERVER configured, sends for real via nodemailer. Without it —
 * the default for local development and for every automated test — the link
 * is logged rather than mailed. Tests don't rely on this log line: the
 * verification token is already sitting in the `verificationToken` table
 * (Auth.js's adapter writes it there before this function is even called),
 * so a test can read it directly and build the callback URL itself, the same
 * way a real inbox click would.
 */
async function sendVerificationRequest(params: {
  identifier: string;
  url: string;
}): Promise<void> {
  const server = process.env.EMAIL_SERVER?.trim();
  if (!server) {
    console.log(`[auth] magic link for ${params.identifier}: ${params.url}`);
    return;
  }

  const { createTransport } = await import("nodemailer");
  const transport = createTransport(server);
  const from = process.env.EMAIL_FROM?.trim() || "Command Center <no-reply@localhost>";
  const { host } = new URL(params.url);

  const result = await transport.sendMail({
    to: params.identifier,
    from,
    subject: `Sign in to ${host}`,
    text: `Sign in to ${host}\n\n${params.url}\n\n`,
    html: `<p><a href="${params.url}">Sign in to ${host}</a></p>`,
  });

  const failed = [...(result.rejected ?? []), ...(result.pending ?? [])].filter(Boolean);
  if (failed.length) throw new Error(`Verification email could not be sent to ${failed.join(", ")}`);
}

/**
 * Auth.js's "lazy initialization" form — a function returning the config,
 * rather than the config object itself.
 *
 * This matters for more than request access (its usual purpose): `next
 * build` imports every route module, including this one, to collect its
 * page data — for every build, desktop/SQLite ones included, where
 * `DATABASE_URL` is never set. Constructing the adapter eagerly at module
 * scope called `getPgDb()` during that collection step and failed the
 * *entire* production build, every time, regardless of which mode was being
 * built. Deferring construction into this function means it only runs when
 * a request actually reaches `/api/auth/*` — which never happens in
 * desktop/SQLite mode — so the module can be imported freely at build time
 * with no database available at all.
 */
export const { handlers, auth, signIn, signOut } = NextAuth(() => ({
  adapter: DrizzleAdapter(getPgDb(), {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  session: { strategy: "database" },
  // Not on Vercel — Railway (or any self-hosted target) needs the host taken
  // from the request rather than inferred from a platform-specific signal.
  trustHost: true,
  providers: [
    GitHub({
      // GitHub verifies email ownership before exposing it via OAuth, which
      // is what makes this safe to enable for *this* provider specifically —
      // it lets someone who signed up via magic link to some@email later
      // sign in with a GitHub account reporting the same, GitHub-verified
      // email, and land on the same account rather than a second one.
      // Never enable this for a provider that does not itself verify email.
      allowDangerousEmailAccountLinking: true,
    }),
    Nodemailer({
      // Never actually used — sendVerificationRequest is fully overridden
      // below and builds its own transport from EMAIL_SERVER when needed.
      // The provider factory requires a truthy `server` value to construct
      // at all, regardless of whether the default sender is replaced.
      server: process.env.EMAIL_SERVER?.trim() || "smtp://localhost:25",
      sendVerificationRequest,
    }),
  ],
}));
