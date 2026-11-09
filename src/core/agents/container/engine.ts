/**
 * Container engine probe (AW.6 groundwork).
 *
 * Probes Docker and Podman using their CLI binaries without spawning a shell or
 * running `.cmd` shims. The probe checks if an engine is installed and if its
 * daemon/server is responding to `version --format {{.Server.Version}}`.
 */
import { execFile as cpExecFile } from "node:child_process";
import { resolveExecutable } from "../resolve-executable";

export type ContainerEngine = {
  kind: "docker" | "podman";
  file: string;
  prefixArgs: string[];
  version: string;
};

export type EngineProbe =
  | { status: "ready"; engine: ContainerEngine }
  | { status: "not-installed" }
  | { status: "not-running"; kind: "docker" | "podman"; detail: string };

export type ContainerExecFile = (
  file: string,
  args: string[],
  opts?: { timeout?: number },
) => Promise<{ stdout: string }>;

export interface ProbeContainerEngineDeps {
  resolve?: typeof resolveExecutable;
  execFile?: (
    file: string,
    args: string[],
    opts?: { timeout?: number },
  ) => Promise<{ stdout: string }>;
  prefer?: "docker" | "podman";
}

const defaultExecFile: ContainerExecFile = (file, args, opts = {}) =>
  new Promise((resolve, reject) => {
    cpExecFile(
      file,
      args,
      { shell: false, windowsHide: true, timeout: opts.timeout ?? 15000 },
      (error, stdout, stderr) => {
        if (error) {
          if (stderr && !(error as { stderr?: string }).stderr) {
            (error as { stderr?: string }).stderr = stderr;
          }
          reject(error);
        } else {
          resolve({ stdout: stdout ?? "" });
        }
      },
    );
  });

function extractDetail(err: unknown): string {
  if (!err) return "unknown error";

  let raw = "";
  if (
    typeof err === "object" &&
    err !== null &&
    "stderr" in err &&
    typeof (err as { stderr?: unknown }).stderr === "string" &&
    (err as { stderr: string }).stderr.trim()
  ) {
    raw = (err as { stderr: string }).stderr;
  } else if (err instanceof Error) {
    raw = err.message;
  } else if (typeof err === "string") {
    raw = err;
  } else if (
    typeof err === "object" &&
    err !== null &&
    "message" in err &&
    typeof (err as { message: unknown }).message === "string"
  ) {
    raw = (err as { message: string }).message;
  } else {
    raw = String(err);
  }

  const lines = raw
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter(Boolean);
  const firstLine = lines[0] ?? "unknown error";

  return firstLine.slice(0, 200);
}

export async function probeContainerEngine(
  deps?: ProbeContainerEngineDeps,
): Promise<EngineProbe> {
  const resolve = deps?.resolve ?? resolveExecutable;
  const exec = deps?.execFile ?? defaultExecFile;
  const prefer = deps?.prefer ?? "docker";

  const kinds: ("docker" | "podman")[] =
    prefer === "podman" ? ["podman", "docker"] : ["docker", "podman"];

  let firstNotRunning: { kind: "docker" | "podman"; detail: string } | null =
    null;

  for (const kind of kinds) {
    const res = resolve(kind);
    if (!res.ok) {
      continue;
    }
    if (/\.(?:cmd|bat)$/i.test(res.file)) {
      continue;
    }

    try {
      const { stdout } = await exec(
        res.file,
        [...res.prefixArgs, "version", "--format", "{{.Server.Version}}"],
        { timeout: 15000 },
      );
      const trimmed = (stdout ?? "").trim();
      if (trimmed) {
        return {
          status: "ready",
          engine: {
            kind,
            file: res.file,
            prefixArgs: res.prefixArgs,
            version: trimmed,
          },
        };
      }
      if (!firstNotRunning) {
        firstNotRunning = {
          kind,
          detail: "empty version output",
        };
      }
    } catch (err: unknown) {
      if (!firstNotRunning) {
        firstNotRunning = {
          kind,
          detail: extractDetail(err),
        };
      }
    }
  }

  if (firstNotRunning) {
    return {
      status: "not-running",
      kind: firstNotRunning.kind,
      detail: firstNotRunning.detail,
    };
  }

  return { status: "not-installed" };
}
