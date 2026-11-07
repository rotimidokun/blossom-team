# Paystack re-probe — new Registered-Business account

## Why
Old account (starter) blocked `POST /transfer`: "You cannot initiate third party
payouts as a starter business" (field-notes 2026-11-01). User created a NEW account,
chose Registered Business, submitted KYC, has a new test key already in
`vending-api/.env` (`sk_test_5118...`; old key was `sk_test_2374...`).

## Probe sequence (test mode, safe)
1. `GET /balance` — confirms the new key is valid.
2. `POST /transferrecipient` — the old `RCP_81czh...` belongs to the old account;
   create a fresh nuban recipient (bank 057, 0000000000, NGN) on the new account.
3. `POST /transfer` — source `balance`, amount 10000 (₦100), new recipient code.
   This is THE blocked call. Success = payouts unblocked.

## Outcomes
- **Pass**: Kemi's pull path is live → update `skills/kemi/utility-bills.md`
  (remove `transfer_unavailable` caveat), update `TESTING-FLOW.md`, log resolved
  blocker in `field-notes.md`.
- **Fail (same starter error)**: KYC not yet effective → log as pending-verification
  in field notes, keep push path, re-probe after approval.

## Run
Inline PowerShell from `vending-api/` (Architect mode cannot write .ps1 — run via
execute_command, or switch to Code mode for the script + follow-up edits).
