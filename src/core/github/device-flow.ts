import "server-only";

import { getSetting, SETTING_KEYS } from "@/core/settings/service";

/**
 * GitHub OAuth via the Device Authorization Grant.
 *
 * The usual authorization-code flow does not fit a desktop application. It
 * redirects to a registered callback URL, but this app's server listens on a
 * different random port every launch, so no fixed callback can be registered.
 * It also requires a client secret, which in a distributed installer would not
 * be a secret at all.
 *
 * The device flow needs neither. The application asks GitHub for a short user
 * code, the person approves it in their browser, and the application polls until
 * GitHub hands back an access token. Only the client id is involved, and it is
 * public by design.
 *
 * It also uses classic scopes, so connecting grants `repo` in one step rather
 * than requiring the repository-access and permission choices that fine-grained
 * tokens demand — the exact configuration that is easy to get wrong.
 */

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";

/** Read access to repositories, public and private. */
const SCOPES = "repo";

export interface DeviceFlowStart {
  deviceCode: string;
  /** Short code the person types into GitHub, e.g. "ABCD-1234". */
  userCode: string;
  verificationUri: string;
  /** Seconds to wait between polls, as dictated by GitHub. */
  interval: number;
  expiresIn: number;
}

export type DevicePollResult =
  | { status: "authorized"; accessToken: string }
  | { status: "pending" }
  /** GitHub asked us to back off; the new interval is in seconds. */
  | { status: "slow_down"; interval: number }
  | { status: "expired" }
  | { status: "denied" }
  | { status: "error"; message: string };

/**
 * The OAuth app to authorise against.
 *
 * Settings first, environment second — the same order the access token uses,
 * and for the same reason: an installed desktop application has no terminal in
 * front of it, so anything a person must configure has to be configurable from
 * inside the app. The environment remains for servers and CI.
 *
 * A client id is public by design, so unlike the token it is safe to display.
 */
export function getClientId(): string | null {
  return (
    getSetting(SETTING_KEYS.githubClientId) ??
    process.env.GITHUB_CLIENT_ID?.trim() ??
    null
  );
}

export type ClientIdSource = "settings" | "environment" | "none";

export function getClientIdSource(): ClientIdSource {
  if (getSetting(SETTING_KEYS.githubClientId)) return "settings";
  if (process.env.GITHUB_CLIENT_ID?.trim()) return "environment";
  return "none";
}

export function isDeviceFlowConfigured(): boolean {
  return getClientId() !== null;
}

/** Asks GitHub to begin a device authorization. */
export async function startDeviceFlow(): Promise<DeviceFlowStart> {
  const clientId = getClientId();
  if (!clientId) {
    throw new Error(
      "No GitHub OAuth app configured. Add a Client ID in Settings to enable Connect with GitHub.",
    );
  }

  const response = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, scope: SCOPES }),
    cache: "no-store",
  });

  const body = (await response.json()) as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    interval?: number;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!response.ok || body.error || !body.device_code || !body.user_code) {
    throw new Error(
      body.error_description ??
        body.error ??
        `GitHub refused to start the device flow (${response.status})`,
    );
  }

  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: body.verification_uri ?? "https://github.com/login/device",
    // GitHub's documented default when it does not say otherwise.
    interval: body.interval ?? 5,
    expiresIn: body.expires_in ?? 900,
  };
}

/**
 * Polls once for the access token.
 *
 * Polling is driven from the browser rather than looped here: a request that
 * blocks for the fifteen minutes a device code can live would tie up a
 * connection and give the user no feedback. Each call reports the current state
 * and the caller decides whether to ask again.
 */
export async function pollDeviceFlow(deviceCode: string): Promise<DevicePollResult> {
  const clientId = getClientId();
  if (!clientId) return { status: "error", message: "No GitHub client id configured." };

  const response = await fetch(ACCESS_TOKEN_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
    cache: "no-store",
  });

  const body = (await response.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
    interval?: number;
  };

  if (body.access_token) {
    return { status: "authorized", accessToken: body.access_token };
  }

  // These are the documented states of an in-progress device flow; only the
  // last of them is an actual failure.
  switch (body.error) {
    case "authorization_pending":
      return { status: "pending" };
    case "slow_down":
      return { status: "slow_down", interval: body.interval ?? 10 };
    case "expired_token":
      return { status: "expired" };
    case "access_denied":
      return { status: "denied" };
    default:
      return {
        status: "error",
        message: body.error_description ?? body.error ?? "Authorization failed",
      };
  }
}
