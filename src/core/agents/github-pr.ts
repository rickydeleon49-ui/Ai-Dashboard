/**
 * Opens a DRAFT pull request through the existing GitHub connection (AW4-08).
 *
 * The call sits behind an injectable function so tests (and the approvals core)
 * never touch the network. The app never merges a pull request: this is the
 * only GitHub write the agent workflow makes, and it always sends `draft: true`.
 */

export interface DraftPrInput {
  owner: string;
  repo: string;
  /** The pushed run branch. */
  head: string;
  base: string;
  title: string;
  body: string;
}

export interface DraftPrResult {
  url: string;
  number: number;
}

export type CreateDraftPr = (input: DraftPrInput) => Promise<DraftPrResult>;

export interface GitHubDraftPrDeps {
  /** The token for the active connection, or null when there is none (or only the demo provider). */
  getToken: () => Promise<string | null>;
  fetchFn?: typeof fetch;
  apiBase?: string;
}

const SEGMENT = /^[A-Za-z0-9._-]+$/;

export function createGitHubDraftPr(deps: GitHubDraftPrDeps): CreateDraftPr {
  const fetchFn = deps.fetchFn ?? fetch;
  const apiBase = deps.apiBase ?? "https://api.github.com";
  return async (input) => {
    if (!SEGMENT.test(input.owner) || !SEGMENT.test(input.repo)) {
      throw new Error("Refusing to open a pull request: the repository name is not valid");
    }
    const token = await deps.getToken();
    if (!token) throw new Error("GitHub is not connected: add a token in Settings before opening a draft pull request");
    const response = await fetchFn(`${apiBase}/repos/${input.owner}/${input.repo}/pulls`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "ai-dashboard",
      },
      body: JSON.stringify({
        title: input.title,
        head: input.head,
        base: input.base,
        body: input.body,
        draft: true,
        maintainer_can_modify: false,
      }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`GitHub API ${response.status} while opening the draft pull request: ${text.slice(0, 200)}`);
    }
    const json = (await response.json()) as { html_url?: unknown; number?: unknown };
    if (typeof json.html_url !== "string" || typeof json.number !== "number") {
      throw new Error("GitHub returned an unexpected response for the draft pull request");
    }
    return { url: json.html_url, number: json.number };
  };
}

/** The token saved in Settings, else GITHUB_TOKEN; loaded lazily so importing this file opens no database. */
async function defaultGetToken(): Promise<string | null> {
  const settings = await import("@/core/settings/service");
  const stored = settings.getSetting(settings.SETTING_KEYS.githubToken);
  const token = stored || process.env.GITHUB_TOKEN?.trim() || "";
  return token || null;
}

export const defaultCreateDraftPr: CreateDraftPr = createGitHubDraftPr({ getToken: defaultGetToken });
