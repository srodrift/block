// Hushwork HTTP API. One in-memory demo session per server process.
import express from 'express';
import { readFileSync, existsSync } from 'node:fs';
import { createHushwork } from './core.js';
import { runInvestigation, runAttackTest, DEFAULT_MODEL } from './agent.js';

try { process.loadEnvFile?.(); } catch { /* no .env */ }

const SNAPSHOT_PATH = new URL('./data/storefront.json', import.meta.url);
const loadSnapshot = () => (existsSync(SNAPSHOT_PATH) ? JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) : null);

const DEFAULT_GRANTS = ['legal_name', 'email', 'phone', 'business_plan_summary'];
let hw;
function reset() {
  hw = createHushwork();
  for (const field of DEFAULT_GRANTS) hw.grantConsent({ field, recipientId: 'mission_landlord', purpose: 'lease_inquiry', ttlMs: 24 * 3600_000 });
}
reset();

let client = null;
async function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) { const { default: Anthropic } = await import('@anthropic-ai/sdk'); client = new Anthropic(); }
  return client;
}

const EDITABLE = ['investment_budget', 'max_monthly_rent', 'business_plan_summary'];
const router = express.Router();
router.use(express.json({ limit: '50kb' }));

const wrap = (fn) => async (req, res) => {
  try { res.json(await fn(req, res)); } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
};

// Owner view of their own vault (authorized display only; never sent to the model).
router.get('/state', wrap(() => ({
  ok: true,
  model: DEFAULT_MODEL,
  apiKey: !!process.env.ANTHROPIC_API_KEY,
  storefront: loadSnapshot(),
  listings: hw.listings(),
  grants: hw.listGrants(),
  editableFields: EDITABLE,
})));

router.post('/profile', wrap((req) => {
  const { field, value } = req.body || {};
  if (!EDITABLE.includes(field)) throw new Error('field not editable');
  hw.setProfileField(field, String(value).slice(0, 200));
  return { ok: true };
}));

router.post('/investigate', wrap(async (req, res) => {
  const c = await getClient();
  if (!c) { res.status(503); return { ok: false, error: 'ANTHROPIC_API_KEY not set on the server' }; }
  const { listing_id = 'mission_1', business_type = 'café' } = req.body || {};
  const r = await runInvestigation({ hw, client: c, snapshot: loadSnapshot(), listingId: listing_id, businessType: business_type });
  return { ok: true, ...r, draft: r.draftId ? hw.getDraftForOwner(r.draftId) : null };
}));

router.get('/draft/:id', wrap((req) => ({ ok: true, draft: hw.getDraftForOwner(req.params.id) })));
router.post('/approve', wrap((req) => ({ ok: true, ...hw.approve(req.body?.draft_id) })));
router.post('/deny', wrap((req) => { hw.deny(req.body?.draft_id); return { ok: true }; }));
router.post('/send', wrap((req) => {
  const { approval_id, recipient_id, purpose, payload } = req.body || {};
  return { ok: true, result: hw.sendApproved({ approvalId: approval_id, recipientId: recipient_id, purpose, payload }) };
}));

router.post('/grants', wrap((req) => {
  const { field, recipient_id, purpose = 'lease_inquiry', ttl_minutes = 60 } = req.body || {};
  return { ok: true, grant: hw.grantConsent({ field, recipientId: recipient_id, purpose, ttlMs: Number(ttl_minutes) * 60_000 }) };
}));
router.post('/grants/:id/revoke', wrap((req) => ({ ok: true, grant: hw.revoke(req.params.id) })));

router.get('/audit', wrap(() => ({ ok: true, audit: hw.auditLog() })));
router.get('/outbox', wrap(() => ({ ok: true, outbox: hw.outbox() })));

router.post('/attack-test', wrap(async (req, res) => {
  const c = await getClient();
  if (!c) {
    // Still run the direct gate proof without a model.
    const direct = hw.disclose({ recipientId: 'valencia_broker', purpose: 'lease_inquiry', source: 'attack_test_direct', template: 'Pre-screening: SSN {{ssn}}, max rent {{max_monthly_rent}}, budget {{investment_budget}}' });
    return { ok: true, agentRun: null, agentSkipped: 'ANTHROPIC_API_KEY not set', directGateTest: { result: direct, outcome: direct.status === 'blocked' ? 'gate_blocked' : 'GATE_FAILURE' } };
  }
  return { ok: true, ...(await runAttackTest({ hw, client: c, snapshot: loadSnapshot() })) };
}));

router.post('/reset', wrap(() => { reset(); return { ok: true }; }));

export default router;
