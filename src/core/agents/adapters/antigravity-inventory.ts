/**
 * Inventory of Antigravity plugins, hook manifests, and MCP servers (AW.3, design §3.2, §16.3 row 2).
 *
 * Scans <home>/.gemini/config/plugins for installed plugins and whether they define hooks,
 * and <home>/.gemini/antigravity-cli/mcp for configured MCP servers without reading secrets.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface AntigravityInventory {
  plugins: { name: string; hasHooks: boolean }[];
  mcpServers: string[];
  errors: string[];
}

const MAX_MANIFEST_SIZE_BYTES = 64 * 1024; // 64 KB

function isNonEmptyHooks(hooks: unknown): boolean {
  if (hooks === null || hooks === undefined) {
    return false;
  }
  if (Array.isArray(hooks)) {
    return hooks.length > 0;
  }
  if (typeof hooks === "object") {
    return Object.keys(hooks as Record<string, unknown>).length > 0;
  }
  if (typeof hooks === "string") {
    return hooks.trim().length > 0;
  }
  return Boolean(hooks);
}

function toErrorCode(err: unknown): string {
  if (err && typeof err === "object") {
    if ("code" in err && typeof (err as { code: unknown }).code === "string") {
      return (err as { code: string }).code;
    }
    if ("name" in err && typeof (err as { name: unknown }).name === "string") {
      return (err as { name: string }).name;
    }
  }
  return "ERR_UNKNOWN";
}

export async function readAntigravityInventory(opts?: {
  home?: string;
}): Promise<AntigravityInventory> {
  const home = opts?.home ?? os.homedir();
  const plugins: { name: string; hasHooks: boolean }[] = [];
  const errors: string[] = [];

  const pluginsDir = path.join(home, ".gemini", "config", "plugins");

  try {
    const entries = await fs.readdir(pluginsDir, { withFileTypes: true });
    const pluginFolders = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));

    for (const pluginName of pluginFolders) {
      const pluginDir = path.join(pluginsDir, pluginName);
      let hasHooks = false;

      // 1. Check for hooks sub-folder
      try {
        const st = await fs.stat(path.join(pluginDir, "hooks"));
        if (st.isDirectory()) {
          hasHooks = true;
        }
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== "ENOENT") {
          errors.push(`${pluginName}/hooks: ${code ?? toErrorCode(err)}`);
        }
      }

      // 2. Check for hooks.json file
      if (!hasHooks) {
        try {
          const st = await fs.stat(path.join(pluginDir, "hooks.json"));
          // Presence alone flags hooks; the file is never read, so its size does not matter.
          if (st.isFile()) hasHooks = true;
        } catch (err: unknown) {
          const code = (err as NodeJS.ErrnoException)?.code;
          if (code !== "ENOENT") {
            errors.push(`${pluginName}/hooks.json: ${code ?? toErrorCode(err)}`);
          }
        }
      }

      // 3. Check plugin.json and manifest.json
      if (!hasHooks) {
        for (const manifestName of ["plugin.json", "manifest.json"]) {
          const manifestPath = path.join(pluginDir, manifestName);
          let st: Awaited<ReturnType<typeof fs.stat>> | undefined;
          try {
            st = await fs.stat(manifestPath);
          } catch (err: unknown) {
            const code = (err as NodeJS.ErrnoException)?.code;
            if (code !== "ENOENT") {
              errors.push(`${pluginName}/${manifestName}: ${code ?? toErrorCode(err)}`);
            }
            continue;
          }

          if (!st.isFile()) {
            continue;
          }

          if (st.size > MAX_MANIFEST_SIZE_BYTES) {
            errors.push(`${pluginName}/${manifestName}: EFBIG`);
            continue;
          }

          let content: string;
          try {
            content = await fs.readFile(manifestPath, "utf8");
          } catch (err: unknown) {
            const code = (err as NodeJS.ErrnoException)?.code;
            errors.push(`${pluginName}/${manifestName}: ${code ?? toErrorCode(err)}`);
            continue;
          }

          try {
            const parsed = JSON.parse(content);
            if (
              parsed &&
              typeof parsed === "object" &&
              !Array.isArray(parsed) &&
              isNonEmptyHooks(parsed.hooks)
            ) {
              hasHooks = true;
              break;
            }
          } catch (err: unknown) {
            const code = toErrorCode(err);
            errors.push(`${pluginName}/${manifestName}: ${code}`);
          }
        }
      }

      plugins.push({ name: pluginName, hasHooks });
    }
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      errors.push(`${path.basename(pluginsDir)}: ${code ?? toErrorCode(err)}`);
    }
  }

  // MCP Servers
  const mcpDir = path.join(home, ".gemini", "antigravity-cli", "mcp");
  const mcpSet = new Set<string>();

  try {
    const mcpEntries = await fs.readdir(mcpDir, { withFileTypes: true });
    for (const entry of mcpEntries) {
      if (entry.isDirectory()) {
        mcpSet.add(entry.name);
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        const baseName = entry.name.slice(0, -".json".length);
        if (baseName.length > 0) {
          mcpSet.add(baseName);
        }
      }
    }
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      errors.push(`${path.basename(mcpDir)}: ${code ?? toErrorCode(err)}`);
    }
  }

  const mcpServers = Array.from(mcpSet).sort((a, b) => a.localeCompare(b));

  return {
    plugins,
    mcpServers,
    errors,
  };
}
