/** Where a URL points, and a guard that keeps a browser on the public web.
 *
 *  A TypeScript port of browser-box's `gateway/gateway/security.py`. Both implementations run
 *  the same vectors (test/scope-vectors.json, copied from browser-box's tests/), so they
 *  cannot quietly drift apart.
 *
 *  Why it exists: once Jev drives a browser that sits on a server next to other services, a
 *  click can navigate anywhere a link points. On 2026-09-23 `open http://127.0.0.1:3000/v1/sessions`
 *  made a Steel browser read Steel's own session list. A gateway in front cannot see those
 *  navigations; only the browser can, so the check lives here, on every request.
 *
 *  Node's WHATWG URL parser canonicalises obfuscated IPv4 (0x7f000001, 2130706433, 0177.0.0.1,
 *  127.1) to dotted form exactly as Chromium does, so this port needs no special parsing for
 *  those; IPv4-mapped IPv6 does need unpacking. */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type TargetScope = "none" | "public_web" | "loopback" | "private_network" | "link_local" | "local_file";

type V4Range = readonly [base: string, bits: number, scope: TargetScope];

/** Checked in order: loopback and link-local first, then everything else that is not the
 *  public internet. Mirrors Python's ipaddress is_private/is_reserved set, plus 100.64.0.0/10
 *  (carrier-grade NAT — and Tailscale's address space). */
const V4: readonly V4Range[] = [
  ["127.0.0.0", 8, "loopback"],
  ["169.254.0.0", 16, "link_local"],
  ["0.0.0.0", 8, "private_network"],
  ["10.0.0.0", 8, "private_network"],
  ["100.64.0.0", 10, "private_network"],
  ["172.16.0.0", 12, "private_network"],
  ["192.0.0.0", 24, "private_network"],
  ["192.0.2.0", 24, "private_network"],
  ["192.168.0.0", 16, "private_network"],
  ["198.18.0.0", 15, "private_network"],
  ["198.51.100.0", 24, "private_network"],
  ["203.0.113.0", 24, "private_network"],
  ["240.0.0.0", 4, "private_network"],
];

const PRIVATE_SUFFIXES = [".local", ".internal", ".lan", ".home", ".corp"];

function v4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function scopeOfV4(ip: string): TargetScope {
  const n = v4ToInt(ip);
  for (const [base, bits, scope] of V4) {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    if ((n & mask) === (v4ToInt(base) & mask)) return scope;
  }
  return "public_web";
}

/** Expand an IPv6 literal to eight 16-bit groups. */
function v6Groups(ip: string): number[] {
  let text = ip;
  // A trailing embedded IPv4 (::ffff:1.2.3.4) becomes two groups.
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)?.[1];
  if (tail) {
    const n = v4ToInt(tail);
    text = text.slice(0, -tail.length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, rest] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = rest !== undefined && rest ? rest.split(":") : [];
  const fill = rest !== undefined ? Array(8 - left.length - right.length).fill("0") : [];
  return [...left, ...fill, ...right].map((g) => parseInt(g || "0", 16));
}

function scopeOfV6(ip: string): TargetScope {
  const g = v6Groups(ip);
  const [g0 = 0, g1 = 0, , , , g5 = 0, g6 = 0, g7 = 0] = g;
  if (g.every((x) => x === 0)) return "private_network"; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g7 === 1) return "loopback"; // ::1
  if (g.slice(0, 5).every((x) => x === 0) && g5 === 0xffff) {
    // IPv4-mapped: judge the IPv4 it carries, or ::ffff:127.0.0.1 walks straight through.
    return scopeOfV4(`${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`);
  }
  if ((g0 & 0xffc0) === 0xfe80) return "link_local"; // fe80::/10
  if ((g0 & 0xfe00) === 0xfc00) return "private_network"; // fc00::/7 unique local
  if (g0 === 0x2001 && g1 === 0x0db8) return "private_network"; // documentation
  return "public_web";
}

export function scopeOfAddress(address: string): TargetScope {
  const kind = isIP(address);
  if (kind === 4) return scopeOfV4(address);
  if (kind === 6) return scopeOfV6(address);
  return "none";
}

/** Classify where a URL points by what is written in it. Never throws. */
export function targetScope(url: string | null | undefined): TargetScope {
  if (!url) return "none";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "none";
  }
  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
  if (scheme === "file") return "local_file";
  if (scheme !== "http" && scheme !== "https") return "none";
  let host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return "none";
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host === "localhost" || host === "localhost.localdomain" || host.endsWith(".localhost")) return "loopback";
  if (isIP(host)) return scopeOfAddress(host);
  // A bare single label resolves through internal DNS (a compose service name, say), never
  // the public web.
  if (!host.includes(".") || PRIVATE_SUFFIXES.some((s) => host.endsWith(s))) return "private_network";
  return "public_web";
}

export interface Verdict {
  allowed: boolean;
  scope: TargetScope;
  reason?: string;
}

type Resolver = (host: string) => Promise<string[]>;

const defaultResolver: Resolver = async (host) => (await lookup(host, { all: true })).map((a) => a.address);

/** Only http(s) goes over the network; data:, blob: and about: never leave the browser. */
const LOCAL_SCHEMES = new Set(["data", "blob", "about", "chrome-extension", "devtools"]);

/** Decide one request. A public-looking name is resolved and EVERY address checked: one public
 *  A record must not launder a second one pointing at the metadata service. Answers are cached
 *  briefly because a page makes many requests to the same few hosts. This does not close DNS
 *  rebinding (the answer can change after we look); the host egress rule is the real control. */
export function createGuard(resolve: Resolver = defaultResolver, ttlMs = 60_000) {
  const cache = new Map<string, { at: number; verdict: Verdict }>();
  return async function check(url: string): Promise<Verdict> {
    let scheme = "";
    try {
      scheme = new URL(url).protocol.replace(/:$/, "").toLowerCase();
    } catch {
      return { allowed: false, scope: "none", reason: "unparseable URL" };
    }
    if (LOCAL_SCHEMES.has(scheme)) return { allowed: true, scope: "none" };
    const scope = targetScope(url);
    if (scope !== "public_web") return { allowed: false, scope, reason: `${scope} target` };
    const host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
    const hit = cache.get(host);
    if (hit && Date.now() - hit.at < ttlMs) return hit.verdict;
    let verdict: Verdict;
    try {
      const addresses = await resolve(host);
      const inward = addresses.map((a) => [a, scopeOfAddress(a)] as const).find(([, s]) => s !== "public_web");
      verdict = inward
        ? { allowed: false, scope: inward[1], reason: `${host} resolves to ${inward[0]} (${inward[1]})` }
        : addresses.length
          ? { allowed: true, scope: "public_web" }
          : { allowed: false, scope: "none", reason: `${host} resolved to nothing` };
    } catch (err) {
      verdict = { allowed: false, scope: "none", reason: `${host} does not resolve` };
    }
    cache.set(host, { at: Date.now(), verdict });
    return verdict;
  };
}
