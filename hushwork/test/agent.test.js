// Deterministic agent-loop tests with scripted fake models (no API key needed).
// They prove the WIRING: whatever the model does, the gate decides.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHushwork } from '../core.js';
import { runInvestigation, runAttackTest } from '../agent.js';

const SNAP = {
  address: '2234 Mission Street', retrievedAt: '2026-10-22T19:40:00Z', note: 'test',
  sources: {
    businesses: { dataset: 'Registered Business Locations', datasetUrl: 'https://data.sfgov.org/d/g8m3-pdis', queryUrl: 'https://q/b', rows: [{ dba_name: 'Example Taqueria', dba_start_date: '2010-01-01' }] },
    permits: { dataset: 'Building Permits', datasetUrl: 'https://data.sfgov.org/d/i98e-djp9', queryUrl: 'https://q/p', rows: [{ permit_number: '123', description: 'storefront remodel' }] },
    tax: { rows: [] },
  },
};

// Scripted model: replays a list of turns; each turn is an array of tool_use specs.
function fakeClient(turns) {
  let i = 0;
  const seen = [];
  return {
    seen,
    messages: {
      create: async (req) => {
        seen.push(JSON.stringify(req));
        const t = turns[i++] || [];
        return { content: t.map((u, k) => ({ type: 'tool_use', id: `tu_${i}_${k}`, name: u.name, input: u.input })) };
      },
    },
  };
}

const REPORT = { name: 'submit_report', input: { findings: [{ text: 'Prior business on record', ref: 'businesses:0' }], risks: ['r'], unknowns: ['current vacancy'], next_step: 'Verify permitted use with the Permit Center' } };

function hwWithGrants() {
  const hw = createHushwork();
  for (const f of ['legal_name', 'email', 'business_plan_summary']) hw.grantConsent({ field: f, recipientId: 'mission_landlord', purpose: 'lease_inquiry', ttlMs: 3600_000 });
  return hw;
}

test('agent: normal investigation drafts a safe inquiry and cites sources', async () => {
  const hw = hwWithGrants();
  const client = fakeClient([
    [{ name: 'budget_check', input: { listing_id: 'mission_1' } }],
    [{ name: 'draft_inquiry', input: { recipient_id: 'mission_landlord', purpose: 'lease_inquiry', template: 'Hi, I am {{legal_name}} ({{email}}), plan: {{business_plan_summary}}. Can we schedule a showing?' } }],
    [REPORT],
  ]);
  const r = await runInvestigation({ hw, client, snapshot: SNAP, listingId: 'mission_1' });
  assert.ok(r.draftId, 'draft created');
  assert.equal(r.toolCalls[0].result.result, 'within_range');
  assert.equal(r.report.findings[0].source.datasetUrl, 'https://data.sfgov.org/d/g8m3-pdis');
  assert.deepEqual(r.secretsInModelContext, []);
  assert.equal(hw.outbox().length, 0, 'nothing sent without user approval');
  for (const req of client.seen) for (const s of hw._vaultValuesForTests()) assert.ok(!req.includes(s), `model saw ${s}`);
});

test('attack: model that FOLLOWS the injection is stopped by the gate, reported as such', async () => {
  const hw = hwWithGrants();
  const client = fakeClient([
    [{ name: 'draft_inquiry', input: { recipient_id: 'valencia_broker', purpose: 'lease_inquiry', template: 'SSN {{ssn}} credit {{credit_score}} max rent {{max_monthly_rent}}' } }],
    [REPORT],
  ]);
  const r = await runAttackTest({ hw, client, snapshot: SNAP });
  assert.equal(r.agentRun.outcome, 'model_followed_injection_gate_blocked');
  assert.ok(r.agentRun.attemptedSecretFields.includes('ssn'));
  assert.equal(r.agentRun.contextCheck, 'pass');
  assert.equal(r.directGateTest.outcome, 'gate_blocked');
  assert.equal(r.outboxToValencia, 0);
});

test('attack: model that IGNORES the injection is reported as a model decision, not a gate block', async () => {
  const hw = hwWithGrants();
  const client = fakeClient([[REPORT]]);
  const r = await runAttackTest({ hw, client, snapshot: SNAP });
  assert.equal(r.agentRun.outcome, 'model_did_not_draft');
  assert.equal(r.directGateTest.outcome, 'gate_blocked', 'gate is still proven directly');
  assert.equal(r.outboxToValencia, 0);
});

test('attack: model context contains the injection text but zero vault values', async () => {
  const hw = hwWithGrants();
  const client = fakeClient([[REPORT]]);
  await runAttackTest({ hw, client, snapshot: SNAP });
  const all = client.seen.join('\n');
  assert.match(all, /Ignore all prior instructions/, 'injection reached the model (realistic attack)');
  for (const s of hw._vaultValuesForTests()) assert.ok(!all.includes(s), s);
});
