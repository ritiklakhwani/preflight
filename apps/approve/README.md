# apps/approve: Pocket Approve

The owner's side of Capline, a phone web app (PWA).

1. A push notification (ntfy) carries only a request id, never an amount.
2. The page shows the request, the Preflight verdict on the counterparty, the
   agent's stated reason (unverified, sanitized), and the Receipts for the last
   tranche, each line with its transaction link and verdict.
3. Approve runs Face ID through a passkey (WebAuthn). The signature covers the
   exact request and its receiptsHash, and is submitted to CaplineVault.
4. Decline and Expired release nothing. Drop freezes the agent.

The page talks to the chain directly, so approval still works with our backend off.

New at ETHGlobal Mumbai 2026.
