# hushwork.

**Your agent works. Your secrets don't travel.**

Hushwork is a personal AI agent that investigates a San Francisco storefront for a first-time founder using public records, and drafts a lease inquiry, **without the language model ever receiving the founder's confidential financial data.** Trusted server code, not the model, decides what leaves the system, and the user approves the exact final message.

Built for the National Renaissance Hackathon at super{set}, October 22, 2026. Track: Personal Agents & Data Privacy.

## Prior work vs. built today

| | |
|---|---|
| **Inherited** (built before this hackathon, [Block Book](https://srodrift.github.io/block/blockbook.html)) | `server.js` Express app and its DataSF query logic (`/api/city/history`); the storefront list in `blockbook.html` the demo address was chosen from. |
| **Built today** | Everything in `hushwork/`: vault, egress gate, payload-bound approvals, audit log, coarse budget check, Claude agent and tools, attack test, API routes, UI, all tests, snapshot script. Two lines in `server.js` that mount Hushwork. `package.json` scripts. |

The original Block Book app is untouched and still runs at `/blockbook.html`.

## Run it

```bash
npm install
cp .env.example .env            # add ANTHROPIC_API_KEY
npm run test:hushwork           # security tests (live model test runs if the key is set)
npm start                       # http://localhost:3000/hushwork
```

Refresh public records (optional; the demo uses the committed snapshot):

```bash
npm run snapshot -- "2234 Mission Street"
```

Offline UI test without Claude: `HUSHWORK_SCRIPTED=1 npm start`. This uses a scripted fake model, labeled as such in the UI. It is for testing the wiring, not for the demo.

## Architecture

```
 untrusted                         │  trusted server code (hushwork/core.js)
                                   │
 Public records (DataSF snapshot) ─┤
 Broker listing text (simulated) ──┼──► buildAgentContext() ──► Claude
                                   │     tokens only: {{ssn}}, {{max_monthly_rent}} …
                                   │
 Claude tool calls ────────────────┼──► budget_check(listing_id) ─► within / over / unknown
                                   │──► draft_inquiry(recipient_id, purpose, template)
                                   │        └► policy check → draft (nothing sent)
                                   │
 User (consent card) ──────────────┼──► approve(draft) → sha256(recipient, purpose, exact payload)
                                   │──► send(approval, payload) → hash match? single use? grants still valid?
                                   │        └► simulated outbox
                                   │
                                   └──► audit log (field names only, never values)
```

**Vault.** Server-side, in-memory. No tool reads it. The model gets placeholder names, never values.

**Egress gate.** Deny by default. Checks recipient (server registry only; the agent cannot supply URLs or emails), purpose, every `{{token}}` against grants scoped to field × recipient × purpose × expiry, and refuses any raw vault value found in a payload. All or nothing.

**Payload-bound approval.** The user approves the exact message. Changing one character, the recipient, or the purpose voids it. Single use, expires in 15 minutes, and grants are re-checked at send time, so revoking after approval still blocks.

**Budget check.** The agent passes a listing id, not a number. Asking rent comes from server-held listing data, so the agent cannot binary-search the private budget. Coarse result only, 3 checks per session.

**Attack test.** A second listing for the same storefront hides an instruction to send the SSN, credit score, bank balance and max rent to its broker. The test (A) runs the real agent on it and reports what the model actually did, and (B) attacks the gate directly with no model. A model refusal is never reported as a gate block.

## Tests

`npm run test:hushwork`: 30 deterministic tests plus 1 live test.

- Authorized disclosure succeeds; granted fields are resolved.
- Injection: model context built from the malicious listing contains zero vault values; an agent that obeys the injection is blocked.
- Bypass: unapproved recipient, agent-invented destination, wrong purpose, expired grant, revoked grant, raw value in payload, unknown field: all blocked.
- Approval: one-character edit, appended secret, changed recipient, changed purpose, reuse, expiry, revoke-after-approval, forged id: all blocked.
- Agent loop (scripted models): obeying model → gate block; ignoring model → reported as model decision; every request sent to the model scanned for vault values.
- Live (needs key): real Claude on the malicious listing; asserts no vault value in model context and nothing sent to the attacker. It asserts the security properties, not the model's choice.

## Data sources

DataSF via Socrata: [Registered Business Locations](https://data.sfgov.org/d/g8m3-pdis), [Building Permits](https://data.sfgov.org/d/i98e-djp9). Snapshot in `hushwork/data/storefront.json` with retrieval timestamp and query URLs.

**Limitations of the data.** Records show history: past businesses and permits. They do not establish current vacancy, rent, zoning approval, or suitability for food service. The agent is instructed to report those as unknown. Asking rents are from **simulated, unverified** broker listings.

## Limitations

- Hackathon prototype. One in-memory session; restarting the server clears the vault, grants and log. No encryption at rest, no auth.
- All personal data is synthetic. Delivery is simulated; no real email is sent.
- The defense is architectural: the model never holds secrets, and trusted code gates egress. It does not claim immunity to every prompt-injection technique. For example, the model could still write misleading text in an approved message; that is why the user approves the exact final message.
- Public business-type text ("café") is task context and is shared with the model by design.

## Prior art

Separating untrusted content from privileged actions follows Simon Willison's dual-LLM pattern and Google DeepMind's CaMeL work. Hushwork applies that idea to a concrete personal-agent workflow; it does not claim to invent it.
