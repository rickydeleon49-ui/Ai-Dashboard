/**
 * Identity of this application.
 *
 * The repository is where update checks look for newer releases. Kept as config
 * rather than hard-coded in the update service so a fork only edits one line.
 */
export const APP_REPOSITORY = {
  owner: "rickydeleon49-ui",
  repo: "Ai-Dashboard",
} as const;

/** Inlined by next.config.ts at build time; "0.0.0" in an unbuilt checkout. */
export const APP_VERSION = process.env.APP_VERSION ?? "0.0.0";

export const RELEASES_URL = `https://github.com/${APP_REPOSITORY.owner}/${APP_REPOSITORY.repo}/releases`;
