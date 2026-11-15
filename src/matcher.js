'use strict';
/**
 * matcher.js — domain/legal-name normalisation, Jaro-Winkler + Levenshtein
 * similarity, blocking, scoring and clustering of HubSpot companies.
 *
 * PURE MODULE: no require(), no I/O, deterministic output for a given input.
 * scripts/build-workflow.js inlines this file verbatim into the n8n Code node
 * "Normalize & Fuzzy Match", and test/workflow.test.js proves the workflow
 * and the CLI produce identical results.
 */

// Legal-entity designators stripped from the END of a company name.
const LEGAL_SUFFIXES = new Set([
  'inc', 'incorporated', 'llc', 'lc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company',
  'plc', 'llp', 'lp', 'pllc', 'pc', 'gmbh', 'mbh', 'ag', 'kg', 'gmbhco', 'ug', 'ev', 'se',
  'sa', 'sas', 'sarl', 'srl', 'spa', 'sl', 'bv', 'nv', 'oy', 'oyj', 'ab', 'as', 'asa', 'aps',
  'pty', 'pte', 'pvt', 'kk', 'kft', 'sro', 'ou', 'sp', 'z', 'oo', 'zoo', 'cv', 'de', 'sapi',
]);

// Two-label public suffixes where the registrable root needs three labels.
const MULTI_PART_TLDS = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'ltd.uk', 'plc.uk', 'me.uk',
  'com.au', 'net.au', 'org.au', 'co.nz', 'org.nz', 'co.za', 'co.jp', 'or.jp', 'ne.jp',
  'co.kr', 'or.kr', 'com.br', 'com.mx', 'com.ar', 'com.co', 'com.sg', 'com.my', 'com.hk',
  'com.cn', 'com.tw', 'com.tr', 'co.in', 'firm.in', 'net.in', 'co.il', 'co.id', 'co.th',
  'com.ph', 'com.vn', 'com.pk', 'com.bd', 'com.eg', 'com.sa', 'com.ng', 'co.ke',
]);

// Hosting platforms where the sub-domain identifies the company.
const PLATFORM_DOMAINS = new Set([
  'github.io', 'myshopify.com', 'wixsite.com', 'squarespace.com', 'wordpress.com', 'blogspot.com',
  'webflow.io', 'netlify.app', 'vercel.app', 'herokuapp.com', 'carrd.co', 'godaddysites.com',
]);

// Shared / free domains that say nothing about company identity.
const SHARED_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'google.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'live.com',
  'msn.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.de',
  'yandex.com', 'mail.com', 'zoho.com', 'linkedin.com', 'facebook.com', 'instagram.com',
  'twitter.com', 'x.com', 'youtube.com', 'bit.ly', 'linktr.ee',
]);

const DEFAULT_MATCH_OPTIONS = {
  threshold: 0.85,
  maxBlockSize: 2000,
  maxCompanies: Infinity,
  minNameLength: 4,          // shorter normalised names must match exactly
  minDomainLabelLength: 3,   // shorter domain labels must match exactly
  nameWeight: 0.65,          // combined = nameWeight*name + domainWeight*domain
  domainWeight: 0.35,
  jaroWinklerWeight: 0.5,    // blended string score = 0.5*JW + 0.5*Levenshtein ratio
  levenshteinWeight: 0.5,
  exactNameFloor: 0.9,       // identical normalised names score at least this
  domainPrefixScore: 0.9,    // one domain label starts with the other (acme / acme-corp)
  extraSharedDomains: [],
};

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * Normalise a domain or website value.
 *   "https://www.EU.Acme.example:8443/about?x=1" -> { host: "eu.acme.example", root: "acme.example", label: "acme" }
 * Returns null when nothing usable remains.
 */
function normalizeDomain(input, extraShared) {
  if (input === undefined || input === null) return null;
  let s = String(input).trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^\/\//, '');
  s = s.replace(/^[^@\/?#]*@/, '');          // userinfo or an email address
  s = s.split(/[\/?#\\\s]/)[0];               // path, query, fragment
  s = s.replace(/:\d*$/, '').replace(/\.+$/, '');
  s = s.replace(/^www\d*\./, '');
  if (!s || s.indexOf('.') === -1 || !/^[\p{L}\p{N}.-]+$/u.test(s)) return null;
  const labels = s.split('.').filter(Boolean);
  if (labels.length < 2) return null;
  const last2 = labels.slice(-2).join('.');
  let rootLen = 2;
  if (labels.length >= 3 && (MULTI_PART_TLDS.has(last2) || PLATFORM_DOMAINS.has(last2))) rootLen = 3;
  const host = labels.join('.');
  const root = labels.slice(-rootLen).join('.');
  const label = labels[labels.length - rootLen];
  const extra = extraShared || [];
  const shared = SHARED_DOMAINS.has(root) || SHARED_DOMAINS.has(host) || PLATFORM_DOMAINS.has(root) ||
    extra.indexOf(root) !== -1 || extra.indexOf(host) !== -1;
  return { host, root, label, shared };
}

/**
 * Normalise a legal company name.
 *   "The ACME Corp., Inc."  -> "acme"
 *   "Café Lumière S.A.R.L." -> "cafe lumiere"
 *   "Halverson & Co."       -> "halverson"
 */
function normalizeName(input) {
  if (input === undefined || input === null) return '';
  let s = String(input).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  s = s.replace(/[’'`´]/g, '');
  s = s.replace(/[&+]/g, ' and ');
  s = s.replace(/\b(?:[a-z]\.){2,}/g, (m) => m.replace(/\./g, '') + ' '); // S.A.R.L. -> sarl
  s = s.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const tokens = s.split(' ').filter(Boolean);
  if (tokens.length > 1 && tokens[0] === 'the') tokens.shift();
  while (tokens.length > 1) {
    const last = tokens[tokens.length - 1];
    if (LEGAL_SUFFIXES.has(last) || last === 'and') tokens.pop();
    else break;
  }
  return tokens.join(' ');
}

// ---------------------------------------------------------------------------
// String similarity
// ---------------------------------------------------------------------------

function jaroWinkler(a, b, prefixScale) {
  const p = prefixScale === undefined ? 0.1 : prefixScale;
  if (a === b) return 1;
  const la = a.length;
  const lb = b.length;
  if (!la || !lb) return 0;
  const range = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1);
  const aMatch = new Array(la).fill(false);
  const bMatch = new Array(lb).fill(false);
  let matches = 0;
  for (let i = 0; i < la; i++) {
    const start = Math.max(0, i - range);
    const end = Math.min(i + range + 1, lb);
    for (let j = start; j < end; j++) {
      if (!bMatch[j] && a[i] === b[j]) {
        aMatch[i] = true;
        bMatch[j] = true;
        matches++;
        break;
      }
    }
  }
  if (!matches) return 0;
  let k = 0;
  let transpositions = 0;
  for (let i = 0; i < la; i++) {
    if (!aMatch[i]) continue;
    while (!bMatch[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  const t = transpositions / 2;
  const jaro = (matches / la + matches / lb + (matches - t) / matches) / 3;
  let prefix = 0;
  for (let i = 0; i < Math.min(4, la, lb); i++) {
    if (a[i] === b[i]) prefix++;
    else break;
  }
  return jaro + prefix * p * (1 - jaro);
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array(b.length + 1);
  let curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    const tmp = prev; prev = curr; curr = tmp;
  }
  return prev[b.length];
}

function levenshteinRatio(a, b) {
  const max = Math.max(a.length, b.length);
  if (!max) return 1;
  return 1 - levenshtein(a, b) / max;
}

/** Blended score: JW rewards shared prefixes and typos, Levenshtein penalises different endings. */
function blendedSimilarity(a, b, opts) {
  const o = opts || DEFAULT_MATCH_OPTIONS;
  const jw = jaroWinkler(a, b);
  const lev = levenshteinRatio(a, b);
  return { jaroWinkler: jw, levenshtein: lev, score: o.jaroWinklerWeight * jw + o.levenshteinWeight * lev };
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

function toNumber(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Convert a HubSpot CRM v3 company object (or a flat object) into a match record. */
function toRecord(raw, opts) {
  const o = opts || DEFAULT_MATCH_OPTIONS;
  const src = raw || {};
  const p = src.properties || src;
  const id = String(src.id !== undefined && src.id !== null ? src.id : (p.hs_object_id !== undefined && p.hs_object_id !== null ? p.hs_object_id : ''));
  const name = p.name === undefined || p.name === null ? '' : String(p.name).trim();
  const normName = normalizeName(name);
  const domainInfo = normalizeDomain(p.domain, o.extraSharedDomains) || normalizeDomain(p.website, o.extraSharedDomains);
  return {
    id,
    name,
    domain: p.domain ? String(p.domain) : '',
    website: p.website ? String(p.website) : '',
    createdate: p.createdate || null,
    numAssociatedDeals: toNumber(p.num_associated_deals),
    annualRevenue: toNumber(p.annualrevenue),
    normName,
    compactName: normName.replace(/ /g, ''),
    sortedName: normName.split(' ').sort().join(' '),
    domainInfo,
  };
}

function compareIds(a, b) {
  const na = /^\d+$/.test(a);
  const nb = /^\d+$/.test(b);
  if (na && nb && a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Pair scoring
// ---------------------------------------------------------------------------

function compareRecords(a, b, options) {
  const o = Object.assign({}, DEFAULT_MATCH_OPTIONS, options || {});
  const reasons = [];

  let name = null;
  let exactName = false;
  if (a.normName && b.normName) {
    if (a.normName === b.normName || a.compactName === b.compactName) {
      exactName = true;
      name = { jaroWinkler: 1, levenshtein: 1, score: 1 };
      reasons.push('exact-normalized-name');
    } else if (Math.min(a.compactName.length, b.compactName.length) < o.minNameLength) {
      name = { jaroWinkler: 0, levenshtein: 0, score: 0 };
    } else {
      const forms = [
        [a.normName, b.normName],
        [a.sortedName, b.sortedName],
        [a.compactName, b.compactName],
      ];
      for (const [x, y] of forms) {
        const s = blendedSimilarity(x, y, o);
        if (!name || s.score > name.score) name = s;
      }
    }
  }

  let domain = null;
  const da = a.domainInfo;
  const db = b.domainInfo;
  if (da && db && !da.shared && !db.shared) {
    if (da.root === db.root) {
      domain = { jaroWinkler: 1, levenshtein: 1, score: 1, sameRoot: true };
      reasons.push('same-root-domain');
      if (da.host !== db.host) reasons.push('subdomain-variant');
    } else if (Math.min(da.label.length, db.label.length) < o.minDomainLabelLength) {
      domain = { jaroWinkler: 0, levenshtein: 0, score: 0, sameRoot: false };
    } else {
      // Compare hyphen-free labels; "globex" vs "globex-industries" is a prefix match.
      const la = da.label.replace(/-/g, '');
      const lb = db.label.replace(/-/g, '');
      domain = Object.assign(blendedSimilarity(la, lb, o), { sameRoot: false, prefixMatch: false });
      const shorter = la.length <= lb.length ? la : lb;
      const longer = la.length <= lb.length ? lb : la;
      if (la !== lb && shorter.length >= o.minNameLength && longer.indexOf(shorter) === 0) {
        domain.prefixMatch = true;
        domain.score = Math.max(domain.score, o.domainPrefixScore);
      }
    }
  }

  let score;
  if (domain && domain.sameRoot) score = name ? 0.9 + 0.1 * name.score : 0.95;
  else if (name && domain) score = o.nameWeight * name.score + o.domainWeight * domain.score;
  else if (name) score = name.score;
  else if (domain) score = domain.score;
  else score = 0;
  if (exactName) score = Math.max(score, o.exactNameFloor);

  if (name && !exactName && name.score >= o.threshold) reasons.push('name-similarity');
  if (domain && domain.prefixMatch) reasons.push('domain-prefix');
  if (domain && !domain.sameRoot && domain.score >= o.threshold) reasons.push('domain-similarity');

  return {
    score: round4(Math.min(1, score)),
    nameJaroWinkler: name ? round4(name.jaroWinkler) : null,
    nameLevenshtein: name ? round4(name.levenshtein) : null,
    nameScore: name ? round4(name.score) : null,
    domainScore: domain ? round4(domain.score) : null,
    reasons,
  };
}

// ---------------------------------------------------------------------------
// Blocking, clustering, review queue
// ---------------------------------------------------------------------------

/** Candidate blocks: only records sharing at least one key are compared. */
function blockingKeys(r) {
  const keys = [];
  if (r.domainInfo && !r.domainInfo.shared) {
    keys.push('r:' + r.domainInfo.root);
    if (r.domainInfo.label.length >= 3) keys.push('d:' + r.domainInfo.label.slice(0, 3));
  }
  if (r.compactName) {
    keys.push('n:' + r.compactName.slice(0, 3));
    const sortedCompact = r.sortedName.replace(/ /g, '');
    const k = 'n:' + sortedCompact.slice(0, 3);
    if (keys.indexOf(k) === -1) keys.push(k);
  }
  return keys;
}

function fnv1a(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Stable cluster ID derived from the member IDs: the same group gets the same ID every run. */
function stableClusterId(ids) {
  const key = ids.slice().sort(compareIds).join('|');
  const h1 = fnv1a(key, 0x811c9dc5).toString(16).padStart(8, '0');
  const h2 = fnv1a(key, 0x01000193).toString(16).padStart(8, '0');
  return 'dup-' + h1 + h2;
}

function pickPrimary(members) {
  const ts = (d) => {
    const t = d ? Date.parse(d) : NaN;
    return Number.isFinite(t) ? t : Infinity;
  };
  return members.slice().sort((x, y) =>
    (y.numAssociatedDeals || 0) - (x.numAssociatedDeals || 0) ||
    (y.annualRevenue || 0) - (x.annualRevenue || 0) ||
    ts(x.createdate) - ts(y.createdate) ||
    compareIds(x.id, y.id)
  )[0];
}

/**
 * Run the full audit over raw HubSpot companies.
 * Returns { summary, clusters } — a consolidated, deduplicated review queue.
 */
function findDuplicates(rawCompanies, options) {
  const o = Object.assign({}, DEFAULT_MATCH_OPTIONS, options || {});
  const input = Array.isArray(rawCompanies) ? rawCompanies : [];
  const limited = Number.isFinite(o.maxCompanies) ? input.slice(0, o.maxCompanies) : input;

  const byId = new Map();
  let skipped = 0;
  for (const raw of limited) {
    const r = toRecord(raw, o);
    if (!r.id || (!r.normName && !r.domainInfo) || byId.has(r.id)) { skipped++; continue; }
    byId.set(r.id, r);
  }
  const records = Array.from(byId.values()).sort((x, y) => compareIds(x.id, y.id));

  const blocks = new Map();
  records.forEach((r, idx) => {
    for (const key of blockingKeys(r)) {
      if (!blocks.has(key)) blocks.set(key, []);
      blocks.get(key).push(idx);
    }
  });

  const seen = new Set();
  const pairs = [];
  const oversizedBlocks = [];
  let comparedPairs = 0;
  const sortedKeys = Array.from(blocks.keys()).sort();
  for (const key of sortedKeys) {
    const idxs = blocks.get(key);
    if (idxs.length < 2) continue;
    if (idxs.length > o.maxBlockSize) {
      oversizedBlocks.push({ keyType: key.slice(0, 1), size: idxs.length });
      continue;
    }
    for (let i = 0; i < idxs.length; i++) {
      for (let j = i + 1; j < idxs.length; j++) {
        const pk = idxs[i] * records.length + idxs[j];
        if (seen.has(pk)) continue;
        seen.add(pk);
        comparedPairs++;
        const cmp = compareRecords(records[idxs[i]], records[idxs[j]], o);
        if (cmp.score >= o.threshold) pairs.push(Object.assign({ i: idxs[i], j: idxs[j] }, cmp));
      }
    }
  }

  // Union-find: overlapping pairs collapse into one review item per group.
  const parent = records.map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (const p of pairs) {
    const ra = find(p.i);
    const rb = find(p.j);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
  const groups = new Map();
  for (const p of pairs) {
    const root = find(p.i);
    if (!groups.has(root)) groups.set(root, { members: new Set(), pairs: [] });
    const g = groups.get(root);
    g.members.add(p.i);
    g.members.add(p.j);
    g.pairs.push(p);
  }

  const clusters = [];
  for (const g of groups.values()) {
    const members = Array.from(g.members).map((i) => records[i]);
    const primary = pickPrimary(members);
    const ids = members.map((m) => m.id);
    const reasons = [];
    for (const p of g.pairs) for (const r of p.reasons) if (reasons.indexOf(r) === -1) reasons.push(r);
    reasons.sort();
    const scores = g.pairs.map((p) => p.score);
    const orderedMembers = members.slice().sort((x, y) =>
      (x.id === primary.id ? -1 : y.id === primary.id ? 1 : 0) || compareIds(x.id, y.id));
    clusters.push({
      clusterId: stableClusterId(ids),
      size: members.length,
      maxScore: Math.max.apply(null, scores),
      minScore: Math.min.apply(null, scores),
      reasons,
      suggestedPrimaryId: primary.id,
      members: orderedMembers.map((m) => ({
        id: m.id,
        name: m.name,
        domain: m.domain,
        website: m.website,
        rootDomain: m.domainInfo ? m.domainInfo.root : null,
        normalizedName: m.normName,
        createdate: m.createdate,
        numAssociatedDeals: m.numAssociatedDeals,
        annualRevenue: m.annualRevenue,
        isSuggestedPrimary: m.id === primary.id,
      })),
      pairs: g.pairs
        .map((p) => ({
          a: records[p.i].id,
          b: records[p.j].id,
          score: p.score,
          nameJaroWinkler: p.nameJaroWinkler,
          nameLevenshtein: p.nameLevenshtein,
          nameScore: p.nameScore,
          domainScore: p.domainScore,
          reasons: p.reasons,
        }))
        .sort((x, y) => y.score - x.score || compareIds(x.a, y.a) || compareIds(x.b, y.b)),
    });
  }
  clusters.sort((x, y) => y.maxScore - x.maxScore || y.size - x.size || (x.clusterId < y.clusterId ? -1 : 1));

  return {
    summary: {
      totalInput: input.length,
      totalRecords: records.length,
      skippedRecords: skipped + (input.length - limited.length),
      truncatedAtMaxCompanies: input.length > limited.length,
      blocks: blocks.size,
      comparedPairs,
      flaggedPairs: pairs.length,
      clusterCount: clusters.length,
      recordsInClusters: clusters.reduce((n, c) => n + c.size, 0),
      threshold: o.threshold,
      oversizedBlocks,
    },
    clusters,
  };
}

// @n8n-exclude-start
module.exports = {
  DEFAULT_MATCH_OPTIONS,
  LEGAL_SUFFIXES,
  SHARED_DOMAINS,
  normalizeDomain,
  normalizeName,
  jaroWinkler,
  levenshtein,
  levenshteinRatio,
  blendedSimilarity,
  toRecord,
  compareRecords,
  blockingKeys,
  stableClusterId,
  findDuplicates,
};
// @n8n-exclude-end
