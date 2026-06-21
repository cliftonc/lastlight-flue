import { isIP } from "node:net";

/**
 * Host normalization + private/internal-IP rejection for egress allowlists.
 *
 * PHASE-1 PARTIAL PORT: the full egress-allowlist module from the reference
 * (`~/work/lastlight/src/sandbox/egress-allowlist.ts`) also exports the
 * DEFAULT_ALLOWLIST / PROVIDER_HOSTS / docker-firewall plumbing used by the
 * sandbox egress floor. That sandbox-egress story is DEFERRED (see
 * BUILD-LOOP.md / spec/09 — egress hardening is a later phase). Only
 * `normalizeAllowlistHost` is needed here, because `config.ts` validates OTEL
 * collector hosts through it. Port the rest when the egress-hardening slice lands.
 */

const INTERNAL_HOSTNAMES = new Set(["localhost", "metadata.google.internal"]);

function isPrivateOrInternalIp(host: string): boolean {
  const ip = host.replace(/^\[|\]$/g, "");
  const family = isIP(ip);
  if (family === 4) {
    const octets = ip.split(".").map((part) => Number(part));
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
    const a = octets[0]!;
    const b = octets[1]!;
    return a === 0
      || a === 10
      || a === 127
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168);
  }
  if (family === 6) {
    const lower = ip.toLowerCase();
    const mappedIpv4 = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    if (mappedIpv4) return isPrivateOrInternalIp(mappedIpv4);
    if (lower.startsWith("::ffff:")) return true;
    return lower === "::"
      || lower === "::1"
      || lower.startsWith("fe8")
      || lower.startsWith("fe9")
      || lower.startsWith("fea")
      || lower.startsWith("feb")
      || lower.startsWith("fc")
      || lower.startsWith("fd");
  }
  return false;
}

export function normalizeAllowlistHost(host: string): string | null {
  const trimmed = host.trim().toLowerCase();
  if (!trimmed) return null;
  let parsed = trimmed;
  try {
    parsed = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).hostname.toLowerCase();
  } catch {
    parsed = trimmed.split("/")[0] || "";
    if (!parsed.startsWith("[")) parsed = parsed.split(":")[0] || "";
  }
  parsed = parsed.replace(/^\.+|\.+$/g, "").replace(/^\[|\]$/g, "");
  if (!parsed || parsed.includes("*") || INTERNAL_HOSTNAMES.has(parsed) || isPrivateOrInternalIp(parsed)) return null;
  return parsed;
}
