import express from 'express';

const app = express();
app.use(express.static('.'));
app.get('/', (_req, res) => res.redirect('/blockbook.html'));

function sodaGet(id, qs){
  const url = `https://data.sfgov.org/resource/${id}.json?${qs}`;
  return fetch(url, { headers: { Accept: 'application/json' } })
    .then(async r => {
      const text = await r.text();
      if (!r.ok) return { ok:false, status:r.status, rows:[] };
      try {
        const rows = JSON.parse(text);
        return { ok:true, rows: Array.isArray(rows) ? rows : [] };
      } catch {
        return { ok:false, rows:[] };
      }
    })
    .catch(e => ({ ok:false, error:e.message, rows:[] }));
}

app.get('/api/city/history', async (req, res) => {
  const address = String(req.query.address || '').replace(/[^\w\s.#/-]/g, '').slice(0, 80);
  const block = String(req.query.block || '').replace(/\D/g, '').slice(0, 6);
  const lot = String(req.query.lot || '').replace(/\D/g, '').slice(0, 5);
  if (!address) return res.status(400).json({ ok:false, error:'address required' });
  const m = address.match(/^(\d+)\s+(.+?)(?:\s+(Street|St|Avenue|Ave|Boulevard|Blvd|Road|Rd|Drive|Dr)\.?)?$/i);
  const num = m?.[1] || '';
  const street = (m?.[2] || address).replace(/'/g, '').toUpperCase().split(/\s+/)[0];
  const like = `${num}%${street}%`;
  const bizWhere = num
    ? `upper(full_business_address) like '${like}' AND upper(city)='SAN FRANCISCO'`
    : `upper(full_business_address) like '%${street}%' AND upper(city)='SAN FRANCISCO'`;
  const permitWhere = num
    ? `street_number='${num}' AND upper(street_name)='${street}'`
    : (block ? `block='${block}'` : `upper(street_name)='${street}'`);
  const [businesses, permits, tax] = await Promise.all([
    sodaGet('g8m3-pdis', `$where=${encodeURIComponent(bizWhere)}&$limit=12&$order=dba_start_date DESC`),
    sodaGet('i98e-djp9', `$where=${encodeURIComponent(permitWhere)}&$limit=12&$order=permit_creation_date DESC`),
    sodaGet('rzkk-54yv', `$q=${encodeURIComponent(address)}&$limit=6`)
  ]);
  res.json({
    ok: !!(businesses.ok || permits.ok),
    address, block, lot,
    businesses, permits, tax
  });
});

app.listen(3000, () => console.log('Block Book → http://localhost:3000/blockbook.html'));
