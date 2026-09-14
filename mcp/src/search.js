/**
 * Scoring for the index.
 *
 * Queries arrive in Traditional Chinese, so whitespace tokenisation is useless
 * here — "陽臺容積" has no spaces to split on. CJK runs are therefore cut into
 * character bigrams, which needs no dictionary and degrades gracefully on terms
 * the base has never seen.
 *
 * Bigrams are noisy on their own (每個, 如何, 建築 match almost everything), so
 * terms are weighted by IDF against the 90-entry corpus. That suppresses the
 * filler without anyone maintaining a stopword list, and it adapts as the base
 * grows.
 *
 * Article numbers get their own normalisation pass: 第162條 / §162 / Article 162
 * all collapse to `#162`, because the descriptions cite articles in whichever
 * form the source regulation used.
 */

// Weighted highest to lowest by how strongly a hit there implies the entry is
// actually about the query. `description` is long and detailed — a hit is
// informative but far weaker than one in the title.
const FIELD_WEIGHTS = {
  title: 10,
  name: 6,
  regulation: 8,
  category: 4,
  summary: 3,
  description: 3,
};

const CJK_RUN = /[\u3400-\u9fff\uf900-\ufaff]+/g;
const LATIN_RUN = /[a-z0-9]+(?:[.\-_][a-z0-9]+)*%?/g;
const ARTICLE_RE = /(?:§|第|article\s*|art\.?\s*)\s*(\d+(?:[-–]\d+)?)\s*(?:條)?/gi;

function normalize(s) {
  // NFKC folds full-width digits and latin (１６２ → 162) that Chinese sources
  // mix in freely.
  return String(s || "").normalize("NFKC").toLowerCase();
}

/** Pull article citations out in a single canonical `#162` form. */
function articleTokens(s) {
  const out = [];
  for (const m of s.matchAll(ARTICLE_RE)) {
    out.push("#" + m[1].replace("–", "-"));
  }
  return out;
}

/** Split into matchable terms: latin words, CJK bigrams, article numbers. */
export function terms(s) {
  const text = normalize(s);
  const out = new Set(articleTokens(text));

  for (const m of text.matchAll(LATIN_RUN)) out.add(m[0]);

  for (const run of text.match(CJK_RUN) || []) {
    if (run.length === 1) {
      out.add(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2));
  }
  return [...out];
}

/** Flatten one entry into the normalised fields we score against. */
function toDoc(entry) {
  const category = [entry.category, ...(entry.breadcrumb || [])].join(" ");
  const fields = {
    title: normalize(entry.title),
    name: normalize(entry.name).replace(/-/g, " "),
    regulation: normalize(entry.regulation),
    category: normalize(category),
    summary: normalize(entry.summary),
    description: normalize(entry.description),
  };
  // Article citations live inside prose, so index them alongside it rather than
  // as a field of their own.
  const cited = new Set();
  for (const v of Object.values(fields)) {
    for (const t of articleTokens(v)) cited.add(t);
  }
  return { entry, fields, cited };
}

let docCache = { key: null, docs: null };

function buildDocs(entries) {
  if (docCache.key === entries) return docCache.docs;
  const docs = entries.map(toDoc);
  docCache = { key: entries, docs };
  return docs;
}

function hits(doc, term) {
  if (term.startsWith("#")) return doc.cited.has(term) ? { cited: true } : null;
  let found = null;
  for (const [field, text] of Object.entries(doc.fields)) {
    if (text.includes(term)) (found ||= {})[field] = true;
  }
  return found;
}

/**
 * Rank entries against a query.
 *
 * @param {object[]} entries  index entries
 * @param {string}   query    natural-language query, Chinese or English
 * @param {object}   filters  {klass, category, region, verifiedOnly}
 * @returns {{entry: object, score: number}[]} scored, descending, hits only
 */
export function search(entries, query, filters = {}) {
  const pool = entries.filter((e) => {
    if (filters.klass && e.klass !== filters.klass) return false;
    if (filters.region && e.region !== filters.region) return false;
    if (filters.verifiedOnly && !e.verified) return false;
    if (filters.category) {
      const hay = normalize([e.category, ...(e.breadcrumb || [])].join(" "));
      if (!hay.includes(normalize(filters.category))) return false;
    }
    return true;
  });

  const q = (query || "").trim();
  // An empty query is a browse, not a search — filters alone decide the pool.
  if (!q) return pool.map((entry) => ({ entry, score: 0 }));

  const docs = buildDocs(pool);
  const qTerms = terms(q);
  if (!qTerms.length) return [];

  // IDF over the filtered pool: a term matching most entries carries little
  // signal, whatever it is.
  const n = docs.length || 1;
  const idf = new Map();
  for (const term of qTerms) {
    let df = 0;
    for (const doc of docs) if (hits(doc, term)) df++;
    idf.set(term, Math.log(1 + n / (df || n)));
  }

  const phrase = normalize(q);
  const scored = [];
  for (const doc of docs) {
    let score = 0;
    for (const term of qTerms) {
      const h = hits(doc, term);
      if (!h) continue;
      const w = idf.get(term);
      if (h.cited) {
        // An article number matching exactly is the strongest signal available
        // — it is what a practitioner actually asked for.
        score += w * 12;
        continue;
      }
      for (const field of Object.keys(h)) score += w * FIELD_WEIGHTS[field];
    }
    // Whole-query substring: rewards entries about the exact phrase over ones
    // that merely collect its bigrams from unrelated places.
    if (score > 0) {
      for (const [field, text] of Object.entries(doc.fields)) {
        if (text.includes(phrase)) score += FIELD_WEIGHTS[field] * 2;
      }
    }
    if (score > 0) scored.push({ entry: doc.entry, score });
  }

  return scored.sort((a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title));
}
