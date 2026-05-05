# Known Issues

This repo currently includes the workspace-local msg-bridge model:
- bridge state is stored per workspace
- multiple workspaces can run msg-bridge independently
- only one live connection per bot/session identity is intended

For personal use, especially Slack-only usage, the current implementation is generally acceptable.
However, the following limitations are known.

## 1. Lock acquisition is not fully atomic

Files involved:
- `src/lock.ts`

Details:
- Bot/workspace locks are implemented with a read/check/write flow.
- In a tight cross-process race, two sessions could theoretically both think they acquired the same lock.
- If lock-file writes fail, the code falls back to in-memory ownership, which only protects within one process.

Impact:
- Rare for normal personal/manual use.
- More relevant for highly concurrent or automated multi-session usage.

## 2. Startup/configure race windows exist

Files involved:
- `src/index.ts`
- `src/ui/main-menu.ts`

Details:
- Transport initialization happens in a background async task at session start.
- If configure/connect actions happen during that startup window, stale config/provider state may race with the new action.

Impact:
- Usually low in manual usage.
- More likely if commands are run immediately after startup or in unusual timing situations.

## 3. Disconnect may release locks even if teardown is imperfect

Files involved:
- `src/transports/manager.ts`
- `src/index.ts`
- `src/ui/main-menu.ts`

Details:
- `disconnectAll()` uses `Promise.allSettled(...)` and callers release locks afterward.
- If a transport does not fully stop, lock release can happen before actual remote teardown is truly complete.

Impact:
- Lower risk for Slack-only personal use.
- More important for transports with reconnect/background lifecycle behavior.

## 4. WhatsApp is the riskiest transport

Files involved:
- `src/transports/whatsapp.ts`

Details:
- WhatsApp connection lifecycle is more asynchronous/event-driven.
- Reconnect timing and non-immediate teardown make lock/liveness mismatches more plausible.

Impact:
- If using WhatsApp, be more cautious with reconnect/reconfigure/disconnect behavior.
- For Slack-only use, this is mostly informational.

## 5. No automatic migration from old global paths

Details:
- Older global locations such as:
  - `~/.pi/msg-bridge.json`
  - `~/.pi/msg-bridge-whatsapp-auth`
- are not automatically migrated into workspace-local storage.

Impact:
- Existing users may need to reconfigure after switching to the workspace-local model.

## Practical guidance

If you are using this personally and mainly with Slack:
- risk is relatively low
- avoid rapidly reconfiguring immediately after startup
- if behavior looks stale, disconnect and restart the pi session
- if anything looks inconsistent, check that only one workspace is connected to the same Slack bot

If this project later grows toward heavier automation or multi-session orchestration, the next hardening steps should be:
1. make lock acquisition atomic
2. tighten startup/configure sequencing
3. make disconnect semantics stricter before releasing bot locks
4. harden WhatsApp reconnect/disconnect ownership behavior
