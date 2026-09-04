import "server-only";

import { APP_REPOSITORY, APP_VERSION, RELEASES_URL } from "@/config/app";
import { getSetting, SETTING_KEYS } from "@/core/settings/service";

/**
 * Checks whether a newer release has been published.
 *
 * Deliberately a *check*, not an installer. Downloading and applying updates
 * automatically (electron-updater) needs the release assets to be fetchable by
 * the running app, and this repository is private — which would mean shipping a
 * GitHub token inside the application so it could authenticate. A credential
 * embedded in a distributed binary is not a secret, so instead the app reports
 * that an update exists and links to it. The browser is already signed in to
 * GitHub, so downloading is one click and no secret leaves the machine.
 *
 * If the repository is ever made public, swapping this for electron-updater is
 * a contained change: the release pipeline that feeds it already exists.
 */

export interface UpdateStatus {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  /** Where to get it. Always safe to show. */
  releasesUrl: string;
  /** Why a check could not complete, when it could not. */
  detail: string;
}

interface ApiRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  html_url: string;
}

/** Compares dotted numeric versions. Returns >0 when `a` is newer than `b`. */
function compareVersions(a: string, b: string): number {
  const parse = (v: string) =>
    v.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);

  const left = parse(a);
  const right = parse(b);

  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export async function checkForUpdate(): Promise<UpdateStatus> {
  const base: UpdateStatus = {
    current: APP_VERSION,
    latest: null,
    updateAvailable: false,
    releasesUrl: RELEASES_URL,
    detail: "",
  };

  // A private repository's releases are not readable anonymously, so the check
  // reuses whichever GitHub credential is already configured.
  const token =
    getSetting(SETTING_KEYS.githubToken) ?? process.env.GITHUB_TOKEN?.trim();

  if (!token) {
    return {
      ...base,
      detail:
        "Add a GitHub token above to check for updates — this repository is private.",
    };
  }

  try {
    const response = await fetch(
      `https://api.github.com/repos/${APP_REPOSITORY.owner}/${APP_REPOSITORY.repo}/releases/latest`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "ai-dashboard",
        },
        cache: "no-store",
      },
    );

    // No releases published yet is a normal state, not a failure.
    if (response.status === 404) {
      return { ...base, detail: "No releases published yet." };
    }

    if (!response.ok) {
      return {
        ...base,
        detail: `Could not check for updates (GitHub returned ${response.status}).`,
      };
    }

    const release = (await response.json()) as ApiRelease;
    const latest = release.tag_name.replace(/^v/, "");
    const updateAvailable = compareVersions(latest, APP_VERSION) > 0;

    return {
      ...base,
      latest,
      updateAvailable,
      releasesUrl: release.html_url || RELEASES_URL,
      detail: updateAvailable
        ? `Version ${latest} is available.`
        : "You are running the latest release.",
    };
  } catch (error) {
    return {
      ...base,
      detail:
        error instanceof Error
          ? `Could not reach GitHub: ${error.message}`
          : "Could not reach GitHub.",
    };
  }
}
