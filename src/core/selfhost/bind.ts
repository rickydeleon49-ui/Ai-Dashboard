/**
 * Bind-address policy for self-hosted mode (AW.5). Pure: no I/O, no DNS.
 *
 * Loopback is always allowed. With allowLan, private (RFC1918) and Tailscale
 * addresses are allowed too. Wildcards, empty values, other hostnames and
 * public addresses are always refused.
 */

export type BindCheck = { ok: true } | { ok: false; error: string };

function parseIPv4(text: string): number[] | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/** Expand an IPv6 literal to 8 16-bit groups, or null when malformed. */
function parseIPv6(text: string): number[] | null {
  let s = text;
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  if (!s.includes(":")) return null;

  // Trailing dotted IPv4 (e.g. ::ffff:10.0.0.1) becomes two hex groups.
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIPv4(tail);
    if (!v4) return null;
    const hi = (((v4[0] ?? 0) << 8) | (v4[1] ?? 0)).toString(16);
    const lo = (((v4[2] ?? 0) << 8) | (v4[3] ?? 0)).toString(16);
    s = `${s.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = s.split("::");
  if (halves.length > 2) return null;
  const toGroups = (h: string): number[] | null => {
    if (h === "") return [];
    const groups: number[] = [];
    for (const g of h.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      groups.push(parseInt(g, 16));
    }
    return groups;
  };
  const head = toGroups(halves[0] ?? "");
  if (!head) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const rest = toGroups(halves[1] ?? "");
  if (!rest) return null;
  const missing = 8 - head.length - rest.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...rest];
}

function isLan4(o: number[]): boolean {
  const b = o[1] ?? 0;
  if (o[0] === 10) return true;
  if (o[0] === 172 && b >= 16 && b <= 31) return true;
  if (o[0] === 192 && b === 168) return true;
  // Tailscale CGNAT 100.64.0.0/10
  if (o[0] === 100 && b >= 64 && b <= 127) return true;
  return false;
}

export function validateBindAddress(host: string, opts: { allowLan: boolean }): BindCheck {
  const raw = typeof host === "string" ? host.trim() : "";
  if (!raw) return { ok: false, error: "Bind address is empty." };
  const h = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;

  if (h.toLowerCase() === "localhost") return { ok: true };

  const refuse = (): BindCheck => ({
    ok: false,
    error: `Bind address ${raw} is not allowed. Use 127.0.0.1, ::1 or localhost${
      opts.allowLan ? ", or a private or Tailscale address" : " (LAN binding is not enabled)"
    }.`,
  });
  const wildcard = (): BindCheck => ({
    ok: false,
    error: `Binding to ${raw} exposes the dashboard on every interface.`,
  });
  const checkV4 = (o: number[]): BindCheck => {
    if (o.every((n) => n === 0)) return wildcard();
    if (o[0] === 127) return { ok: true };
    return opts.allowLan && isLan4(o) ? { ok: true } : refuse();
  };

  const v4 = parseIPv4(h);
  if (v4) return checkV4(v4);

  const v6 = parseIPv6(h);
  if (v6) {
    if (v6.every((g) => g === 0)) return wildcard();
    // ::1
    if (v6.slice(0, 7).every((g) => g === 0) && v6[7] === 1) return { ok: true };
    // IPv4-mapped ::ffff:a.b.c.d
    if (v6.slice(0, 5).every((g) => g === 0) && v6[5] === 0xffff) {
      const x = v6[6] ?? 0;
      const y = v6[7] ?? 0;
      return checkV4([x >> 8, x & 255, y >> 8, y & 255]);
    }
    // Tailscale fd7a:115c:a1e0::/48
    if (v6[0] === 0xfd7a && v6[1] === 0x115c && v6[2] === 0xa1e0) {
      return opts.allowLan ? { ok: true } : refuse();
    }
    return refuse();
  }

  return {
    ok: false,
    error: `Bind address ${raw} is a hostname; only localhost or an IP address is allowed.`,
  };
}
