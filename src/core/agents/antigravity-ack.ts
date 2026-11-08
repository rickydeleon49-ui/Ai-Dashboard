/**
 * Validation for Antigravity plugin and MCP server acknowledgement (AW.3, design §3.2, §16.3 row 5).
 *
 * Antigravity loads its plugins, hooks, and MCP servers into every run.
 * The owner must review and acknowledge them before an Antigravity run starts.
 * If plugins or MCP servers change after acknowledgement, a fresh review is required.
 */
import type { AntigravityInventory } from "./adapters/antigravity-inventory";

export function checkAntigravityAcknowledgement(
  request: {
    roles: { implementer: { provider: string } };
    antigravityAcknowledgement?: { plugins: string[]; mcpServers: string[] };
  },
  inventory: AntigravityInventory,
): { ok: true } | { ok: false; error: string } {
  if (request.roles.implementer.provider !== "antigravity") {
    return { ok: true };
  }

  if (inventory.plugins.length === 0 && inventory.mcpServers.length === 0) {
    return { ok: true };
  }

  if (!request.antigravityAcknowledgement) {
    return {
      ok: false,
      error:
        "Antigravity loads plugins or MCP servers on this computer; acknowledge them before starting the run.",
    };
  }

  const sortStrings = (items: readonly string[]): string[] =>
    [...items].sort(); // code-point order: exact, locale-independent

  const ackPlugins = sortStrings(request.antigravityAcknowledgement.plugins);
  const invPlugins = sortStrings(inventory.plugins.map((p) => p.name));

  const ackMcp = sortStrings(request.antigravityAcknowledgement.mcpServers);
  const invMcp = sortStrings(inventory.mcpServers);

  const pluginsMatch =
    ackPlugins.length === invPlugins.length &&
    ackPlugins.every((name, index) => name === invPlugins[index]);

  const mcpMatch =
    ackMcp.length === invMcp.length &&
    ackMcp.every((name, index) => name === invMcp[index]);

  if (!pluginsMatch || !mcpMatch) {
    return {
      ok: false,
      error:
        "The Antigravity plugins or MCP servers changed since you acknowledged them; review and acknowledge again.",
    };
  }

  return { ok: true };
}
