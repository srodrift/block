// Hushwork core: vault, recipient registry, grants, egress gate,
// payload-bound approvals, audit log.
// Trust boundary: everything in this file is TRUSTED server code.
// The LLM agent never imports this module. It only receives
// buildAgentContext() output and calls narrow tools (draft_inquiry,
// budget_check) that go through the gate.

import { createHash, randomUUID } from 'node:crypto';
import { DEMO_LISTINGS } from './data/listings.js';

const TOKEN_RE = /\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/gi;

export const DEMO_PROFILE = Object.freeze({
  legal_name: 'Maya Okafor',
  email: 'maya.okafor@example.com',
  phone: '415-555-0142',
  home_address: '2291 Fake Ave, San Francisco, CA 94110',
  ssn: '900-12-3456', // synthetic, invalid range
  credit_score: '742',
  bank_balance: '$61,800',
  investment_budget: '$80,000',
  max_monthly_rent: '$7,500',
  business_plan_summary: 'Neighborhood bakery + coffee counter, 6 staff, opening Q2 2027.',
  personal_guarantee_willing: 'yes',
});

// Recipients are defined server-side. The agent can only name a recipient id;
// it can never supply a URL, email, or endpoint.
export const DEMO_RECIPIENTS = Object.freeze({
  mission_landlord: { id: 'mission_landlord', name: 'Mission St Landlord', endpoint: 'sim://outbox/mission_landlord' },
  valencia_broker: { id: 'valencia_broker', name: 'Valencia Broker', endpoint: 'sim://outbox/valencia_broker' },
});

export const PURPOSES = Object.freeze(['lease_inquiry']);

// Canonical form for hashing: Unicode NFC + normalized line endings. Nothing else
// is normalized, so any visible edit (even one character) changes the hash.
export const canonical = (s) => String(s).normalize('NFC').replace(/\r\n?/g, '\n');
export const approvalHash = (recipientId, purpose, payload) =>
  createHash('sha256').update(JSON.stringify([recipientId, purpose, canonical(payload)])).digest('hex');

export function createHushwork({
  now = () => Date.now(),
  profile = DEMO_PROFILE,
  recipients = DEMO_RECIPIENTS,
  listings = DEMO_LISTINGS,
  budgetCheckLimit = 3,
} = {}) {
  // ---- Vault (private; never returned to the agent) ----
  const vault = new Map(Object.entries(profile));
  const fieldNames = () => [...vault.keys()];
  const vaultValues = () => fieldNames().map((f) => [f, String(vault.get(f))]);

  function setProfileField(field, value) { // owner-only
    if (!vault.has(field)) throw new Error(`unknown field: ${field}`);
    vault.set(field, String(value));
    log({ type: 'vault_update', field });
  }

  // ---- Audit log (records field NAMES only, never values) ----
  const audit = [];
  const log = (entry) => { const e = { ts: new Date(now()).toISOString(), ...entry }; audit.push(e); return e; };

  // ---- Grants: field x recipient x purpose x expiry, revocable ----
  const grants = [];
  let grantSeq = 0;

  // Owner-only (consent UI). Never exposed as an agent tool.
  function grantConsent({ field, recipientId, purpose, ttlMs }) {
    if (!vault.has(field)) throw new Error(`unknown field: ${field}`);
    if (!recipients[recipientId]) throw new Error(`unknown recipient: ${recipientId}`);
    if (!PURPOSES.includes(purpose)) throw new Error(`unknown purpose: ${purpose}`);
    if (!(ttlMs > 0)) throw new Error('ttlMs must be > 0');
    const g = { id: `g${++grantSeq}`, field, recipientId, purpose, expiresAt: now() + ttlMs, revoked: false };
    grants.push(g);
    log({ type: 'grant', grantId: g.id, field, recipient: recipientId, purpose, expiresAt: new Date(g.expiresAt).toISOString() });
    return { ...g };
  }

  function revoke(grantId) {
    const g = grants.find((x) => x.id === grantId);
    if (!g) throw new Error(`unknown grant: ${grantId}`);
    g.revoked = true;
    log({ type: 'revoke', grantId, field: g.field, recipient: g.recipientId });
    return { ...g };
  }

  function validGrant(field, recipientId, purpose) {
    const t = now();
    return grants.find((g) => g.field === field && g.recipientId === recipientId && g.purpose === purpose && !g.revoked && g.expiresAt > t);
  }

  function whyNoGrant(field, recipientId, purpose) {
    const t = now();
    const same = grants.filter((g) => g.field === field);
    if (!same.length) return 'no grant for field';
    const forRecipient = same.filter((g) => g.recipientId === recipientId);
    if (!forRecipient.length) return 'no grant for this recipient';
    const forPurpose = forRecipient.filter((g) => g.purpose === purpose);
    if (!forPurpose.length) return 'no grant for this purpose';
    if (forPurpose.every((g) => g.revoked)) return 'grant revoked';
    if (forPurpose.every((g) => g.revoked || g.expiresAt <= t)) return 'grant expired';
    return 'no valid grant';
  }

  // ---- Policy check shared by every egress path (deny by default) ----
  function checkTemplate({ recipientId, purpose, template }) {
    if (typeof template !== 'string' || template.length > 5000) return { ok: false, reason: 'invalid payload', requested: [], blocked: [] };
    if (!recipients[recipientId]) return { ok: false, reason: 'unknown recipient (agent cannot supply destinations)', requested: [], blocked: [] };
    if (!PURPOSES.includes(purpose)) return { ok: false, reason: 'unknown purpose', requested: [], blocked: [] };

    // Defense in depth: a raw vault value should never appear in agent output.
    const rawHits = vaultValues().filter(([, v]) => v.length >= 3 && template.includes(v)).map(([f]) => f);
    if (rawHits.length) return { ok: false, reason: 'raw private value found in payload', requested: [], blocked: rawHits };

    const requested = [...new Set([...template.matchAll(TOKEN_RE)].map((m) => m[1].toLowerCase()))];
    const blocked = [];
    const reasons = {};
    for (const f of requested) {
      if (!vault.has(f)) { blocked.push(f); reasons[f] = 'unknown field'; continue; }
      if (!validGrant(f, recipientId, purpose)) { blocked.push(f); reasons[f] = whyNoGrant(f, recipientId, purpose); }
    }
    if (blocked.length) return { ok: false, reason: 'ungranted fields requested', requested, blocked, reasons };
    return { ok: true, reason: 'all fields granted', requested, blocked: [] };
  }

  const resolve = (template) => template.replace(TOKEN_RE, (_, f) => String(vault.get(f.toLowerCase())));

  // ---- Outbox (simulated delivery) ----
  const outbox = [];
  function deliver(recipientId, purpose, payload, via) {
    outbox.push({ ts: new Date(now()).toISOString(), recipient: recipientId, endpoint: recipients[recipientId].endpoint, purpose, payload, via });
  }

  // Agent-facing results never contain values.
  const agentView = (e) => ({ status: e.status, reason: e.reason, released: e.released, blocked: e.blocked, reasons: e.reasons });

  // ---- Direct gated send (grant-only path; kept for gate tests) ----
  // All-or-nothing: if any token is unauthorized, nothing is sent.
  function disclose({ recipientId, purpose, template, source = 'agent' }) {
    const c = checkTemplate({ recipientId, purpose, template });
    const base = { type: 'disclosure', source, recipient: recipientId, purpose };
    if (!c.ok) return agentView(log({ ...base, status: 'blocked', reason: c.reason, requested: c.requested, released: [], blocked: c.blocked, reasons: c.reasons }));
    deliver(recipientId, purpose, resolve(template), 'grant');
    return agentView(log({ ...base, status: 'sent', reason: c.reason, requested: c.requested, released: c.requested, blocked: [] }));
  }

  // ---- Drafts + payload-bound approvals (the Hushwork product path) ----
  const drafts = new Map();
  const approvals = new Map();

  // Agent tool: draft an inquiry with {{tokens}}. Nothing is sent.
  function prepareDraft({ recipientId, purpose, template, source = 'agent' }) {
    const c = checkTemplate({ recipientId, purpose, template });
    const base = { type: 'draft', source, recipient: recipientId, purpose };
    if (!c.ok) return { draftId: null, ...agentView(log({ ...base, status: 'blocked', reason: c.reason, requested: c.requested, released: [], blocked: c.blocked, reasons: c.reasons })) };
    const draftId = randomUUID();
    drafts.set(draftId, { draftId, recipientId, purpose, template, createdAt: now() });
    log({ ...base, status: 'awaiting_approval', reason: 'draft ready for owner review', draftId, requested: c.requested, released: [], blocked: [] });
    return { draftId, status: 'awaiting_approval', reason: 'the user must approve the exact message', released: [], blocked: [] };
  }

  // Owner-only: what the consent card shows.
  function getDraftForOwner(draftId) {
    const d = drafts.get(draftId);
    if (!d) return null;
    const included = [...new Set([...d.template.matchAll(TOKEN_RE)].map((m) => m[1].toLowerCase()))];
    return {
      draftId, recipientId: d.recipientId, recipientName: recipients[d.recipientId].name,
      destination: recipients[d.recipientId].endpoint, purpose: d.purpose,
      payload: resolve(d.template), includedFields: included,
      excludedFields: fieldNames().filter((f) => !included.includes(f)),
    };
  }

  // Owner-only: approve the exact final payload shown on the consent card.
  function approve(draftId, { ttlMs = 15 * 60_000 } = {}) {
    const view = getDraftForOwner(draftId);
    if (!view) throw new Error('unknown draft');
    const c = checkTemplate({ recipientId: view.recipientId, purpose: view.purpose, template: drafts.get(draftId).template });
    if (!c.ok) throw new Error(`draft no longer passes policy: ${c.reason}`);
    const approvalId = randomUUID();
    const hash = approvalHash(view.recipientId, view.purpose, view.payload);
    approvals.set(approvalId, { approvalId, draftId, hash, recipientId: view.recipientId, purpose: view.purpose, expiresAt: now() + ttlMs, used: false });
    log({ type: 'approval', approvalId, draftId, recipient: view.recipientId, purpose: view.purpose, fields: view.includedFields, hash: hash.slice(0, 12) });
    return { approvalId, hash };
  }

  function deny(draftId) {
    if (!drafts.delete(draftId)) throw new Error('unknown draft');
    log({ type: 'draft_denied', draftId });
  }

  // Send exactly what was approved. Any change to recipient, purpose, or a single
  // character of payload invalidates the approval. Single use. Grants re-checked
  // at send time, so a revoke after approval still blocks.
  function sendApproved({ approvalId, recipientId, purpose, payload }) {
    const base = { type: 'disclosure', source: 'owner_approval', recipient: recipientId, purpose, approvalId };
    const block = (reason) => agentView(log({ ...base, status: 'blocked', reason, released: [], blocked: [] }));
    const a = approvals.get(approvalId);
    if (!a) return block('unknown approval');
    if (a.used) return block('approval already used');
    if (a.expiresAt <= now()) return block('approval expired');
    if (approvalHash(recipientId, purpose, payload) !== a.hash) return block('payload, recipient, or purpose differs from what the user approved');
    const d = drafts.get(a.draftId);
    const c = checkTemplate({ recipientId, purpose, template: d.template });
    if (!c.ok) return agentView(log({ ...base, status: 'blocked', reason: `policy changed since approval: ${c.reason}`, requested: c.requested, released: [], blocked: c.blocked, reasons: c.reasons }));
    a.used = true;
    deliver(recipientId, purpose, payload, 'approval');
    return agentView(log({ ...base, status: 'sent', reason: 'exact approved payload', requested: c.requested, released: c.requested, blocked: [] }));
  }

  // ---- Derived fact: coarse budget check, trusted inputs only, rate-limited ----
  // The agent passes a listing id; the asking rent comes from server-held listing
  // data, so the agent cannot binary-search the private budget with chosen numbers.
  let budgetChecks = 0;
  function budgetCheck(listingId) {
    const listing = listings[listingId];
    if (!listing) {
      log({ type: 'derived', field: 'max_monthly_rent', listing: String(listingId).slice(0, 40), result: 'refused', reason: 'unknown listing' });
      return { result: 'refused', reason: 'unknown listing' };
    }
    if (budgetChecks >= budgetCheckLimit) {
      log({ type: 'derived', field: 'max_monthly_rent', listing: listingId, result: 'refused', reason: 'rate limit' });
      return { result: 'refused', reason: 'budget check limit reached for this session' };
    }
    budgetChecks++;
    const rent = Number(listing.askingRentMonthly);
    const max = Number(String(vault.get('max_monthly_rent') || '').replace(/[^0-9.]/g, ''));
    const result = !Number.isFinite(rent) || rent <= 0 || !max ? 'unknown' : rent <= max ? 'within_range' : 'over_range';
    log({ type: 'derived', field: 'max_monthly_rent', listing: listingId, result });
    return { result, basis: 'asking rent from unverified broker listing' };
  }

  // ---- What the agent is allowed to see ----
  function buildAgentContext(publicData = {}) {
    return {
      instructions: 'You may reference private fields ONLY as placeholder tokens like {{email}}. You do not know their values. A server gate decides what is released, and the user approves the exact final message.',
      availableTokens: fieldNames().map((f) => `{{${f}}}`),
      recipients: Object.values(recipients).map(({ id, name }) => ({ id, name })),
      purposes: [...PURPOSES],
      publicData,
    };
  }

  return {
    // owner actions
    grantConsent, revoke, approve, deny, setProfileField, getDraftForOwner, sendApproved,
    // agent tools
    prepareDraft, budgetCheck,
    // gate (direct) and context
    disclose, buildAgentContext,
    // read-only views
    listGrants: () => grants.map((g) => ({ ...g })),
    auditLog: () => audit.map((e) => ({ ...e })),
    outbox: () => outbox.map((o) => ({ ...o })),
    listings: () => Object.values(listings).map((l) => ({ ...l })),
    _vaultValuesForTests: () => vaultValues().map(([, v]) => v),
  };
}

// Back-compat alias
export const createVeyra = createHushwork;
