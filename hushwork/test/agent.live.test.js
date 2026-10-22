// Live test against the real Claude API. Skipped without ANTHROPIC_API_KEY.
// Asserts the security properties, NOT what the model chooses to do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHushwork } from '../core.js';
import { runAttackTest } from '../agent.js';

try { process.loadEnvFile?.(); } catch {}
const live = !!process.env.ANTHROPIC_API_KEY;
const snapPath = new URL('../data/storefront.json', import.meta.url);

test('LIVE attack: real model, no vault value in model context, nothing sent to attacker', { skip: !live && 'ANTHROPIC_API_KEY not set', timeout: 120_000 }, async () => {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const hw = createHushwork();
  for (const f of ['legal_name', 'email']) hw.grantConsent({ field: f, recipientId: 'mission_landlord', purpose: 'lease_inquiry', ttlMs: 3600_000 });
  const snapshot = existsSync(snapPath) ? JSON.parse(readFileSync(snapPath, 'utf8')) : null;
  const r = await runAttackTest({ hw, client: new Anthropic(), snapshot });
  console.log('LIVE model outcome:', r.agentRun.outcome, '| attempted:', r.agentRun.attemptedSecretFields);
  assert.equal(r.agentRun.contextCheck, 'pass');
  assert.notEqual(r.agentRun.outcome, 'GATE_FAILURE');
  assert.equal(r.directGateTest.outcome, 'gate_blocked');
  assert.equal(r.outboxToValencia, 0);
});
