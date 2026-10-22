import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHushwork } from '../core.js';

const HOUR = 3600_000;
const TEMPLATE = 'Hello, I am {{legal_name}} ({{email}}). I am interested in the Mission St storefront for my business: {{business_plan_summary}}. Could we schedule a showing?';

function setup() {
  let t = Date.parse('2026-10-22T13:00:00Z');
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const v = createHushwork({ now: clock.now });
  for (const field of ['legal_name', 'email', 'business_plan_summary']) {
    v.grantConsent({ field, recipientId: 'mission_landlord', purpose: 'lease_inquiry', ttlMs: 24 * HOUR });
  }
  const d = v.prepareDraft({ recipientId: 'mission_landlord', purpose: 'lease_inquiry', template: TEMPLATE });
  const card = v.getDraftForOwner(d.draftId);
  const { approvalId } = v.approve(d.draftId);
  return { v, clock, d, card, approvalId };
}

const send = (v, approvalId, card, over = {}) =>
  v.sendApproved({ approvalId, recipientId: card.recipientId, purpose: card.purpose, payload: card.payload, ...over });

test('draft: agent gets no values back; nothing is sent until approval', () => {
  const { v, d } = setup();
  assert.equal(d.status, 'awaiting_approval');
  const text = JSON.stringify(d);
  for (const s of v._vaultValuesForTests()) assert.ok(!text.includes(s));
  assert.equal(v.outbox().length, 0);
});

test('consent card shows exact message, destination, included and excluded fields', () => {
  const { card } = setup();
  assert.match(card.payload, /Maya Okafor/);
  assert.equal(card.destination, 'sim://outbox/mission_landlord');
  assert.deepEqual(card.includedFields.sort(), ['business_plan_summary', 'email', 'legal_name']);
  for (const f of ['ssn', 'max_monthly_rent', 'investment_budget', 'bank_balance']) assert.ok(card.excludedFields.includes(f), f);
});

test('approved exact payload is sent once', () => {
  const { v, card, approvalId } = setup();
  assert.equal(send(v, approvalId, card).status, 'sent');
  assert.equal(v.outbox().length, 1);
  assert.equal(v.outbox()[0].payload, card.payload);
});

test('one-character edit after approval is blocked', () => {
  const { v, card, approvalId } = setup();
  const r = send(v, approvalId, card, { payload: card.payload.replace('showing?', 'showing!') });
  assert.equal(r.status, 'blocked');
  assert.match(r.reason, /differs from what the user approved/);
  assert.equal(v.outbox().length, 0);
});

test('appending a secret after approval is blocked', () => {
  const { v, card, approvalId } = setup();
  const r = send(v, approvalId, card, { payload: card.payload + ' Budget: $80,000' });
  assert.equal(r.status, 'blocked');
  assert.equal(v.outbox().length, 0);
});

test('changed recipient after approval is blocked', () => {
  const { v, card, approvalId } = setup();
  assert.equal(send(v, approvalId, card, { recipientId: 'valencia_broker' }).status, 'blocked');
  assert.equal(v.outbox().length, 0);
});

test('changed purpose after approval is blocked', () => {
  const { v, card, approvalId } = setup();
  assert.equal(send(v, approvalId, card, { purpose: 'marketing' }).status, 'blocked');
});

test('approval is single-use', () => {
  const { v, card, approvalId } = setup();
  assert.equal(send(v, approvalId, card).status, 'sent');
  const r = send(v, approvalId, card);
  assert.equal(r.status, 'blocked');
  assert.match(r.reason, /already used/);
  assert.equal(v.outbox().length, 1);
});

test('approval expires', () => {
  const { v, clock, card, approvalId } = setup();
  clock.advance(16 * 60_000);
  assert.match(send(v, approvalId, card).reason, /expired/);
});

test('revoking a field grant after approval still blocks the send', () => {
  const { v, card, approvalId } = setup();
  v.revoke(v.listGrants().find((g) => g.field === 'email').id);
  const r = send(v, approvalId, card);
  assert.equal(r.status, 'blocked');
  assert.match(r.reason, /policy changed since approval/);
});

test('forged approval id is blocked', () => {
  const { v, card } = setup();
  assert.match(send(v, 'not-a-real-approval', card).reason, /unknown approval/);
});

test('agent cannot draft an inquiry containing ungranted secrets', () => {
  const { v } = setup();
  const r = v.prepareDraft({ recipientId: 'valencia_broker', purpose: 'lease_inquiry', template: 'SSN {{ssn}}, max rent {{max_monthly_rent}}, budget {{investment_budget}}' });
  assert.equal(r.draftId, null);
  assert.equal(r.status, 'blocked');
  assert.deepEqual(r.blocked.sort(), ['investment_budget', 'max_monthly_rent', 'ssn']);
});

test('audit log after full approval flow contains no vault values', () => {
  const { v, card, approvalId } = setup();
  send(v, approvalId, card, { payload: card.payload + 'x' });
  send(v, approvalId, card);
  const text = JSON.stringify(v.auditLog());
  for (const s of v._vaultValuesForTests()) assert.ok(!text.includes(s), s);
});
