'use strict';
/**
 * hubspot.js — read-only HubSpot CRM v3 client (native fetch, Node >= 18).
 * This project never writes to HubSpot: it only reads account info and companies.
 */

const { maskSecrets } = require('./safety');

const COMPANY_PROPERTIES = [
  'name', 'domain', 'website', 'hs_object_id', 'createdate', 'num_associated_deals', 'annualrevenue',
];

class HubSpotError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'HubSpotError';
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function hubspotGet(pathName, query, ctx) {
  const { token, apiBase, fetchImpl, retries = 4, wait = sleep } = ctx;
  const url = new URL(apiBase.replace(/\/+$/, '') + pathName);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(url.toString(), {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
    });
    if (res.ok) return res.json();
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < retries) {
      const retryAfter = Number(res.headers && res.headers.get ? res.headers.get('retry-after') : NaN);
      await wait(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt);
      continue;
    }
    let body = '';
    try { body = await res.text(); } catch (_) { /* ignore */ }
    throw new HubSpotError(
      'HubSpot API ' + res.status + ' on GET ' + pathName + (body ? ': ' + maskSecrets(body.slice(0, 300), [token]) : ''),
      res.status
    );
  }
}

/** GET /account-info/v3/details — portalId, accountType (STANDARD | SANDBOX | DEVELOPER_TEST | APP_DEVELOPER), uiDomain. */
function getAccountInfo(ctx) {
  return hubspotGet('/account-info/v3/details', null, ctx);
}

/** Page through /crm/v3/objects/companies until done or maxCompanies is reached. */
async function fetchAllCompanies(ctx, options) {
  const o = options || {};
  const max = o.maxCompanies || Infinity;
  const companies = [];
  let after;
  let pages = 0;
  do {
    const body = await hubspotGet('/crm/v3/objects/companies', {
      limit: 100,
      archived: 'false',
      properties: COMPANY_PROPERTIES.join(','),
      after,
    }, ctx);
    pages++;
    for (const c of body.results || []) {
      companies.push(c);
      if (companies.length >= max) break;
    }
    after = body.paging && body.paging.next ? body.paging.next.after : undefined;
    if (o.onPage) o.onPage({ pages, fetched: companies.length });
    if (after && o.requestIntervalMs) await (ctx.wait || sleep)(o.requestIntervalMs);
  } while (after && companies.length < max);
  return companies;
}

module.exports = { COMPANY_PROPERTIES, HubSpotError, hubspotGet, getAccountInfo, fetchAllCompanies };
