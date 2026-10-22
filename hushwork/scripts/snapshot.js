// Snapshot ONE storefront's public SF records to hushwork/data/storefront.json.
// Usage: node hushwork/scripts/snapshot.js "1000 Valencia St" [block] [lot]
// Same DataSF queries as Block Book's /api/city/history (server.js).
import { writeFileSync } from 'node:fs';

const [address, block = '', lot = ''] = process.argv.slice(2);
if (!address) { console.error('usage: node hushwork/scripts/snapshot.js "<number> <street>" [block] [lot]'); process.exit(1); }

const DATASETS = {
  businesses: { id: 'g8m3-pdis', name: 'Registered Business Locations - San Francisco' },
  permits: { id: 'i98e-djp9', name: 'Building Permits' },
  tax: { id: 'rzkk-54yv', name: 'Commercial Vacancy Tax (search)' },
};

const m = address.match(/^(\d+)\s+(.+?)(?:\s+(Street|St|Avenue|Ave|Boulevard|Blvd|Road|Rd|Drive|Dr)\.?)?$/i);
const num = m?.[1] || '';
const street = (m?.[2] || address).replace(/'/g, '').toUpperCase().split(/\s+/)[0];
const like = `${num}%${street}%`;
const bizWhere = num
  ? `upper(full_business_address) like '${like}' AND upper(city)='SAN FRANCISCO'`
  : `upper(full_business_address) like '%${street}%' AND upper(city)='SAN FRANCISCO'`;
const permitWhere = num ? `street_number='${num}' AND upper(street_name)='${street}'` : `upper(street_name)='${street}'`;

const queries = {
  businesses: `$where=${encodeURIComponent(bizWhere)}&$limit=12&$order=dba_start_date DESC`,
  permits: `$where=${encodeURIComponent(permitWhere)}&$limit=12&$order=permit_creation_date DESC`,
  tax: `$q=${encodeURIComponent(address)}&$limit=6`,
};

const out = { address, block, lot, retrievedAt: new Date().toISOString(), note: 'Public records snapshot. Records show history, not current vacancy, rent, or zoning approval.', sources: {} };

for (const [key, qs] of Object.entries(queries)) {
  const ds = DATASETS[key];
  const url = `https://data.sfgov.org/resource/${ds.id}.json?${qs}`;
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    const rows = r.ok ? await r.json() : [];
    out.sources[key] = { dataset: ds.name, datasetUrl: `https://data.sfgov.org/d/${ds.id}`, queryUrl: url, ok: r.ok, count: rows.length, rows };
  } catch (e) {
    out.sources[key] = { dataset: ds.name, datasetUrl: `https://data.sfgov.org/d/${ds.id}`, queryUrl: url, ok: false, error: e.message, rows: [] };
  }
  console.log(`${key}: ${out.sources[key].ok ? out.sources[key].count + ' rows' : 'FAILED'}`);
}

writeFileSync(new URL('../data/storefront.json', import.meta.url), JSON.stringify(out, null, 2));
console.log('wrote hushwork/data/storefront.json');
