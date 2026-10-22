// Veyra core: vault, recipient registry, grants, egress gate, audit log.
// Trust boundary: everything in this file is TRUSTED server code.
// The LLM agent never imports this module directly; it only receives
// buildAgentContext() output and calls tools that go through gate.disclose().

const TOKEN_RE = /\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/gi;

export const DEMO_PROFILE = Object.freeze({
  legal_name: 'Maya Okafor',
  email: 'maya.okafor@example.com',
  phone: '415-555-0142',
  home_address: '2291 Fake Ave, San Francisco, CA 94110',
  ssn: '900-12-3456', // synthetic, invalid range
  credit_score: '742',
  bank_balance: '$61,800',
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

export function createVeyra({ now = () => Date.now(), profile = DEMO_PROFILE, recipients = DEMO_RECIPIENTS, budgetCheckLimit = 3 } = {}) {
  // ---- Vault (private; never returned to the agent) ----
  const vault = new Map(Object.entries(profile));
  const fieldNames = () => [...vault.keys()];

  // ---- Audit log (records field NAMES only, never values) ----
  const audit = [];
  const log = (entry) => { const e = { ts: new Date(now()).toISOString(), ...entry }; audit.push(e); return e; };

  // ---- Grants: field x recipient x purpose x expiry, revocable ----
  const grants = [];
  let grantSeq = 0;

  // Only callable from the user-facing consent endpoint, never exposed as an agent tool.
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

  // ---- Outbox (simulated delivery; the only place resolved values exist after egress) ----
  const outbox = [];

  // ---- Egress gate: the ONLY path for data to leave ----
  // All-or-nothing: if any token is unauthorized, nothing is sent.
  function disclose({ recipientId, purpose, template, source = 'agent' }) {
    const base = { type: 'disclosure', source, recipient: recipientId, purpose };
    if (typeof template !== 'string' || template.length > 5000) {
      return finish(log({ ...base, status: 'blocked', reason: 'invalid payload', requested: [], released: [], blocked: [] }));
    }
    const recipient = recipients[recipientId];
    if (!recipient) {
      return finish(log({ ...base, status: 'blocked', reason: 'unknown recipient (agent cannot supply destinations)', requested: [], released: [], blocked: [] }));
    }
    if (!PURPOSES.includes(purpose)) {
      return finish(log({ ...base, status: 'blocked', reason: 'unknown purpose', requested: [], released: [], blocked: [] }));
    }

    // Defense in depth: a raw vault value should never appear in agent output.
    // If one does, something upstream leaked; refuse to send it.
    const rawHits = fieldNames().filter((f) => {
      const v = String(vault.get(f));
      return v.length >= 3 && template.includes(v);
    });
    if (rawHits.length) {
      return finish(log({ ...base, status: 'blocked', reason: 'raw private value found in payload', requested: [], released: [], blocked: rawHits }));
    }

    const requested = [...new Set([...template.matchAll(TOKEN_RE)].map((m) => m[1].toLowerCase()))];
    const blocked = [];
    const reasons = {};
    for (const f of requested) {
      if (!vault.has(f)) { blocked.push(f); reasons[f] = 'unknown field'; continue; }
      if (!validGrant(f, recipientId, purpose)) { blocked.push(f); reasons[f] = whyNoGrant(f, recipientId, purpose); }
    }

    if (blocked.length) {
      return finish(log({ ...base, status: 'blocked', reason: 'ungranted fields requested', requested, released: [], blocked, reasons }));
    }

    const payload = template.replace(TOKEN_RE, (_, f) => String(vault.get(f.toLowerCase())));
    outbox.push({ ts: new Date(now()).toISOString(), recipient: recipientId, endpoint: recipient.endpoint, purpose, payload });
    return finish(log({ ...base, status: 'sent', reason: 'all fields granted', requested, released: requested, blocked: [] }));
  }

  function finish(entry) {
    // Return value goes back to the agent: no values, only names and status.
    return { status: entry.status, reason: entry.reason, released: entry.released, blocked: entry.blocked, reasons: entry.reasons };
  }

  // ---- Derived fact: coarse budget check, server-sourced inputs only, rate-limited ----
  // The agent passes a listing id; the asking rent comes from trusted listing data,
  // so the agent cannot binary-search the private budget with arbitrary numbers.
  let budgetChecks = 0;
  function budgetCheck(listing) {
    if (budgetChecks >= budgetCheckLimit) {
      log({ type: 'derived', field: 'max_monthly_rent', result: 'refused', reason: 'rate limit' });
      return { result: 'refused', reason: 'budget check limit reached for this session' };
    }
    budgetChecks++;
    const rent = Number(listing?.askingRentMonthly);
    const max = Number(String(vault.get('max_monthly_rent') || '').replace(/[^0-9.]/g, ''));
    const result = !Number.isFinite(rent) || rent <= 0 || !max ? 'unknown' : rent <= max ? 'within_range' : 'over_range';
    log({ type: 'derived', field: 'max_monthly_rent', listing: listing?.id, result });
    return { result };
  }

  // ---- What the agent is allowed to see ----
  function buildAgentContext(publicData = {}) {
    return {
      instructions: 'You may reference private fields ONLY as placeholder tokens like {{email}}. You do not know their values. A server gate decides what is released.',
      availableTokens: fieldNames().map((f) => `{{${f}}}`),
      recipients: Object.values(recipients).map(({ id, name }) => ({ id, name })),
      purposes: [...PURPOSES],
      publicData,
    };
  }

  return {
    grantConsent, revoke, disclose, budgetCheck, buildAgentContext,
    // Read-only views for the owner UI / tests
    listGrants: () => grants.map((g) => ({ ...g })),
    auditLog: () => audit.map((e) => ({ ...e })),
    outbox: () => outbox.map((o) => ({ ...o })),
    _vaultValuesForTests: () => [...vault.values()].map(String),
  };
}
