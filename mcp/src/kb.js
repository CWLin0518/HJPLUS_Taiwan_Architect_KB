/**
 * Index access layer.
 *
 * The knowledge base is an OKF bundle in `raw/`. `scripts/kb_index.py` distils
 * every (domain.md, SKILL.md) pair into `docs/kb.json` on each deploy, so the
 * published index is always in step with main. This module reads that file and
 * nothing else — no crawling, no local clone, no build step of our own.
 *
 * Entry text is deliberately *not* bundled into the index. Each entry carries
 * `skillPath`/`domainPath`, so full text is fetched from raw.githubusercontent
 * only when a caller actually asks for it. That keeps startup to one ~30 KB
 * gzipped request and means the text returned is always main's current version.
 */

const DEFAULT_INDEX_URL =
  "https://h30190.github.io/HJPLUS_Taiwan_Architect_KB/kb.json";
const DEFAULT_RAW_BASE =
  "https://raw.githubusercontent.com/h30190/HJPLUS_Taiwan_Architect_KB/main/";

// The index is regenerated only when content lands on main, so an hour-stale
// copy is normal and harmless. Refetching costs a round trip; the TTL keeps a
// long-lived session from paying it on every call.
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15000;

export const config = {
  indexUrl: process.env.TW_ARCH_KB_INDEX_URL || DEFAULT_INDEX_URL,
  rawBase: process.env.TW_ARCH_KB_RAW_BASE || DEFAULT_RAW_BASE,
  ttlMs: Number(process.env.TW_ARCH_KB_TTL_MS) || DEFAULT_TTL_MS,
};

let cache = { data: null, at: 0 };
let inflight = null;

async function fetchJson(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`索引下載失敗 ${res.status} ${res.statusText} — ${url}`);
  }
  return res.json();
}

/**
 * Return the parsed index, refetching only past the TTL.
 *
 * A refresh that fails while we still hold a copy serves the stale one instead
 * of throwing: an expired cache is a far better answer than no answer, and the
 * index changes slowly enough that stale data stays correct.
 */
export async function getIndex({ force = false } = {}) {
  const fresh = cache.data && Date.now() - cache.at < config.ttlMs;
  if (fresh && !force) return cache.data;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const data = await fetchJson(config.indexUrl);
      if (!Array.isArray(data?.entries)) {
        throw new Error("索引格式非預期：缺少 entries 陣列");
      }
      cache = { data, at: Date.now() };
      return data;
    } catch (err) {
      if (cache.data) return cache.data;
      throw err;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

/** Look up one entry by its frontmatter `name` (the stable skill slug). */
export async function findEntry(name) {
  const { entries } = await getIndex();
  const wanted = String(name).trim().toLowerCase();
  return (
    entries.find((e) => e.name?.toLowerCase() === wanted) ||
    // Callers paste titles as often as slugs; fall back to an exact title match
    // rather than making them guess which identifier the tool wants.
    entries.find((e) => e.title?.toLowerCase() === wanted) ||
    null
  );
}

/** Fetch one repo-relative path as text from raw.githubusercontent. */
export async function fetchText(path) {
  const url = config.rawBase + path.split("/").map(encodeURIComponent).join("/");
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) {
    throw new Error(`內容下載失敗 ${res.status} — ${path}`);
  }
  return res.text();
}
