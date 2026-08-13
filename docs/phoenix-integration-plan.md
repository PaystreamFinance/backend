# Phoenix Integration Plan

## Goal

Integrate `phoenix` (`phoenix.trade`) as a supported arb venue across `api`, `core-worker`, and shared exchange infrastructure, while reusing the same architectural seams already used for `hyperliquid`, `pacifica`, `aster`, `lighter`, and `01`.

This document is intentionally a planning document only. It does not include implementation.

Primary external references:

- API docs: [https://docs.phoenix.trade/api](https://docs.phoenix.trade/api)
- SDK docs: [https://docs.phoenix.trade/sdk/rise](https://docs.phoenix.trade/sdk/rise)
- SDK repo: [https://github.com/Ellipsis-Labs/rise-public](https://github.com/Ellipsis-Labs/rise-public)
- Exchange snapshot: [https://docs.phoenix.trade/api/exchange/get-exchange-snapshot](https://docs.phoenix.trade/api/exchange/get-exchange-snapshot)
- List markets: [https://docs.phoenix.trade/api/exchange/list-markets](https://docs.phoenix.trade/api/exchange/list-markets)
- Invite activation: [https://docs.phoenix.trade/api/invite/activate](https://docs.phoenix.trade/api/invite/activate)
- Referral activation: [https://docs.phoenix.trade/api/invite/activate-with-referral](https://docs.phoenix.trade/api/invite/activate-with-referral)
- Accounts model: [https://docs.phoenix.trade/phoenix/collateral-and-accounts/accounts](https://docs.phoenix.trade/phoenix/collateral-and-accounts/accounts)
- Collateral and withdraw queue: [https://docs.phoenix.trade/phoenix/collateral-and-accounts/collateral](https://docs.phoenix.trade/phoenix/collateral-and-accounts/collateral)
- Funding model: [https://docs.phoenix.trade/phoenix/margin-and-risk/funding-rate](https://docs.phoenix.trade/phoenix/margin-and-risk/funding-rate)

## Decisions Already Assumed For V1

- Invite flow: server-managed Phoenix code, not user-supplied.
- Account model: cross only for v1, using Phoenix default cross account with `portfolio_index=0` and `subaccount_index=0`.
- Scope: arb integration only for now, not spot-perp or unrelated product surfaces.
- Signing model: use the same backend-orchestrated signing flow style already used by Solana/EVM venues, but mapped onto Phoenix Rise instruction builders.

## Current Codebase Map

### API entrypoints that will need Phoenix support

- `api/api/arb/index.ts`
- `api/api/arb/markets.ts`
- `api/api/arb/funding-rates/history.ts`
- `api/api/arb/funding-rates/dex.ts`
- `api/api/arb/trade.ts`
- `api/api/arb/close.ts`
- `api/api/arb/activity/funding-history.ts`
- `api/api/arb/balance/all.ts`
- `api/services/arb-set-tp-sl-executor.ts`
- `api/services/mark-price-feed.ts`

### Shared exchange and funding infrastructure

- `packages/perps/registry.ts`
- `packages/perps/types.ts`
- `packages/perps/market-data.ts`
- `packages/perps/funding-rates/types.ts`
- `packages/perps/funding-rates/utils.ts`
- `packages/perps/funding-rates/fetchers/*`

### Worker flows that assume a fixed venue set today

- `core-worker/funding-rates/service.ts`
- `core-worker/queue/arb-producer.ts`
- `core-worker/services/opportunity-checker.ts`
- `core-worker/services/arb-position-fetcher.ts`
- `core-worker/services/arb-funding-check.ts`
- `core-worker/services/oi-monitor.ts`

### DB schemas that may need Phoenix enum coverage

- `packages/db/schema/transfers.ts`
- `packages/db/schema/exchange.ts`
- `packages/db/schema/funding.ts`

## What Phoenix Provides That Maps To Our Needs

Based on the Phoenix docs and the Rise SDK README/repo:

- Market discovery via exchange and markets APIs
- Historical funding rate access
- Trader state and positions access
- Invite-based user activation
- Trading and order packet flows
- Deposit and withdrawal instruction flows
- Streams for live market data including mark price, funding, mids, and market stats

Important behavior from docs:

- Phoenix requires invite activation during its private-beta style onboarding
- Phoenix collateral is Solana USDC based
- Withdrawals may be queued globally rather than settling immediately
- Funding is hourly in accumulation terms, with settlement behavior described separately in docs
- Phoenix has cross and isolated account concepts, but cross-only is the correct first fit for our current arb model

## Existing Patterns We Should Reuse

### Shared provider pattern

Current integrations centralize venue logic behind provider/client layers instead of scattering protocol-specific logic everywhere. Phoenix should follow that same pattern:

- shared client in `packages/perps/clients/*`
- venue provider in `packages/perps/providers/*`
- registry bootstrap in `packages/perps/registry.ts`
- route-level branches in `api/api/arb/*` only for orchestration, validation, and auth

### Funding ingestion pattern

Funding history today is normalized into `funding_rate_history` with:

- `dex`
- canonical `symbol`
- venue-native `protocolSymbol`
- `timestamp`
- `rate`
- `granularity`

Phoenix should follow the same storage pattern so the existing funding history endpoints and arb analytics continue to work.

### Live price pattern

Frontend and workers already consume shared market snapshots and mark prices. Phoenix should plug into:

- cached market data used by `/api/arb/markets`
- live mark price feed used by `api/services/mark-price-feed.ts`
- shared price lookup used by `packages/perps/market-data.ts`

### Trade / close / TP-SL pattern

Trade orchestration already does:

- validate venue pair
- initialize providers
- fetch market info
- compute target size
- build/sign/submit venue-specific transactions
- persist pair state and positions

Phoenix should follow the same route-level pattern rather than introducing a separate subsystem.

## Required Integration Areas

## 1. Protocol and Type Registration

Add `phoenix` anywhere the codebase currently treats venue identity as a closed union.

Expected files:

- `api/models/arb.ts`
- `packages/perps/funding-rates/types.ts`
- `packages/db/schema/transfers.ts`
- possibly `packages/db/schema/exchange.ts`
- any response types that enumerate venue columns explicitly

Notes:

- `transfers` definitely needs Phoenix as a protocol enum because deposits and withdrawals are required.
- `exchange_name` should only be extended if Phoenix needs persisted session or credential records in the same table family. If Rise integration is fully signer-and-state driven, we may avoid forcing Phoenix into API-key oriented persistence.

## 2. Shared Phoenix Client

Create a shared Phoenix client wrapper in:

- `packages/perps/clients/phoenix-client.ts`

Responsibilities:

- own API base URL configuration
- own Solana RPC configuration
- bootstrap Rise client and exchange metadata cache
- expose typed helpers for:
  - exchange snapshot
  - list markets
  - market lookup by symbol
  - trader state
  - positions
  - invite activation
  - funding history
  - mark price / market stats streams or fetches
  - deposit and withdrawal instruction builders
  - trade and close instruction helpers

Reasoning:

- keeps Phoenix-specific SDK surface isolated from route handlers
- mirrors existing exchange-specific client structure
- makes both `api` and `core-worker` depend on one shared implementation path

## 3. Phoenix Provider

Create a Phoenix provider in:

- `packages/perps/providers/phoenix-provider.ts`

Responsibilities:

- `initialize`
- `getAllMarkets`
- `getMarketInfo`
- `getFees`
- `getPositions`
- `executeTrade`
- `executeClose`
- `setTakeProfit`
- `setStopLoss`
- `getFundingPayments` if Phoenix exposes the right user-level funding history path
- balance / trader collateral reads
- deposit / withdraw helpers
- `ensureTraderRegistered`

Important provider design note:

The formal `IArbProvider` interface in `packages/perps/types.ts` does not currently describe every method real route handlers use. Phoenix implementation should follow the existing practical pattern and then, if worthwhile, this can be a later cleanup task to make provider interfaces more explicit.

## 4. Registry and Market Cache Wiring

Extend:

- `packages/perps/registry.ts`

Needed changes:

- initialize Phoenix alongside current venues
- cache Phoenix markets in the same style as existing venue caches
- add a getter like `getPhoenixProvider()`
- include Phoenix in `getCachedMarketData()` shape

This is the key seam for `/api/arb/markets`, frontend price views, and worker opportunity scanning.

## 5. Market Discovery and Normalization

Phoenix needs to power live data for `/api/arb/markets`.

Expected work:

- fetch all Phoenix markets from exchange/markets endpoints
- normalize market symbols into the project’s canonical symbol format
- store the Phoenix-native symbol separately as `protocolSymbol`
- map Phoenix market fields into the common arb market shape:
  - mark price
  - index price if available
  - funding rate
  - funding interval or effective cadence
  - open interest
  - fees
  - leverage / margin constraints

Normalization rule to preserve:

- project canonical symbol should remain comparable across venues
- Phoenix-native symbol should remain available for execution and history

Likely symbol approach for Phoenix:

- canonical `symbol`: base asset symbol used everywhere else in the app
- `protocolSymbol`: the exact Phoenix market identifier

This mirrors how the codebase already differentiates normalized symbols from venue-native identifiers.

## 6. Live Prices For `/markets`

Target:

- Phoenix data should appear as another venue column in `/api/arb/markets`

Files affected conceptually:

- `packages/perps/registry.ts`
- `api/api/arb/markets.ts`
- `api/services/mark-price-feed.ts`
- `packages/perps/market-data.ts`

Implementation plan:

- source Phoenix live mark prices either from Rise streams or a stable Phoenix market stats endpoint
- populate cached market snapshots the same way the other venues do
- add Phoenix to merged market row generation in `api/api/arb/markets.ts`
- make sure Phoenix participates in `maxArb` and APR calculations

Funding cadence note:

`api/api/arb/markets.ts` already normalizes venues differently depending on hourly vs eight-hour behavior. Phoenix should be treated according to its actual published funding cadence, not copied from another venue blindly.

## 7. Historical Funding Rate Support

Target:

- Phoenix should feed the existing funding history endpoints and worker storage model

Files affected conceptually:

- `packages/perps/funding-rates/fetchers/phoenix.ts`
- `core-worker/funding-rates/service.ts`
- `api/api/arb/funding-rates/history.ts`
- `api/api/arb/funding-rates/dex.ts`
- `core-worker/services/arb-funding-check.ts`

Plan:

- build a Phoenix funding fetcher using the API or SDK historical funding endpoint
- normalize records into:
  - `dex = 'phoenix'`
  - canonical `symbol`
  - Phoenix-native `protocolSymbol`
  - raw timestamp
  - funding `rate`
  - correct `granularity`
- include Phoenix in public history route allowlists
- make sure worker close logic can use Phoenix funding history exactly like other venues

Important constraint:

The funding fetcher should not infer cadence from guesswork. It should use actual Phoenix documentation and returned data semantics.

## 8. Trading Ability For `trade` Endpoint

Target:

- allow Phoenix as either leg in `/api/arb/trade` and `/api/arb/trade/v2`

Files affected conceptually:

- `api/api/arb/trade.ts`
- `packages/perps/providers/phoenix-provider.ts`
- any signer/auth helper needed for Solana Phoenix execution

Plan:

- add Phoenix to supported arb protocol validation
- add route-level Phoenix execution branch in the same style as other venues
- before first execution, call `ensureTraderRegistered`
- build trade instructions using Rise SDK
- integrate with existing Privy-backed signing flow used for Solana wallet actions
- return consistent execution metadata into existing persistence flow

Key implementation requirement:

Phoenix execution should not bypass the common size calculation, market info validation, pair persistence, or error sanitation framework already present in `api/api/arb/trade.ts`.

## 9. Ability To Set TP / SL

Target:

- support Phoenix in `/api/arb/set-tp-sl`

Files affected conceptually:

- `api/services/arb-set-tp-sl-executor.ts`
- `packages/perps/providers/phoenix-provider.ts`

Plan:

- verify whether Phoenix exposes native conditional order workflows for TP/SL through Rise
- if yes, map them into provider methods:
  - `setTakeProfit`
  - `setStopLoss`
- if no, document whether Phoenix v1 support must be deferred or emulated externally

Important note:

This is one of the highest-risk areas because current providers are not uniform. The plan must explicitly validate Phoenix’s exact order model before implementation starts.

## 10. Ability To Close Trades

Target:

- support Phoenix in `/api/arb/close` and `/api/arb/close-all`

Files affected conceptually:

- `api/api/arb/close.ts`
- `packages/perps/providers/phoenix-provider.ts`

Plan:

- expose a Phoenix close helper that uses current position state plus market metadata
- allow Phoenix-specific symbol handling from persisted pairs
- preserve the existing pair lifecycle:
  - close one leg
  - close second leg
  - update DB status
  - handle partial failures carefully

Risk to account for:

- if Phoenix close size precision differs from the normalized target size, `computeTargetSize` and the Phoenix lot-size helpers need to agree on rounding rules.

## 11. Ability To Create User / Activate Invite

Target:

- backend should be able to activate Phoenix access on behalf of the user the first time Phoenix is used

Files affected conceptually:

- shared Phoenix client/provider layer
- `api/api/arb/trade.ts`
- Phoenix deposit/withdraw entrypoints
- possibly balance/position fetchers if trader state access requires registration

Plan:

- implement `ensureTraderRegistered(authority)` in the Phoenix provider
- use server-managed code from env
- call Phoenix invite activation endpoint idempotently before the first operation that requires trader state
- check trader state first, so repeated calls do not re-register or fail noisily

Config expected:

- `PHOENIX_API_URL`
- `PHOENIX_INVITE_CODE`
- optionally a mode flag if Phoenix access and referral activation paths must both be supported

This is better than a user-driven invite field because it fits current backend-managed onboarding patterns and reduces UX friction.

## 12. Deposit / Withdraw From Solana

Target:

- support Phoenix deposits and withdrawals through Solana USDC flows

New endpoints expected:

- `api/api/arb/deposit/phoenix.ts`
- `api/api/arb/withdraw/phoenix.ts`

Files affected conceptually:

- `api/api/arb/index.ts`
- `packages/perps/providers/phoenix-provider.ts`
- `packages/db/schema/transfers.ts`

Plan:

- use Rise deposit and withdraw instruction builders
- keep v1 asset scope to Solana USDC only
- record transfer rows using the same transfer model as existing venues
- surface queued withdrawals clearly if Phoenix places withdrawals into a queue

Important behavior from docs:

- Phoenix collateral is not just a generic wallet balance; deposit and withdrawal semantics pass through Phoenix collateral systems and Ember wrapping
- user messaging and transfer status handling must reflect that

## 13. Positions, Balances, And User Funding History

Targets:

- Phoenix balances in aggregated `/api/arb/balance`
- Phoenix positions in `/api/arb/positions` and `/positions/v2`
- Phoenix funding payments in `/api/arb/activity/funding/history` if exposed

Files affected conceptually:

- `api/api/arb/balance/all.ts`
- `api/api/arb/activity/funding-history.ts`
- any position serialization helpers used by arb routes
- `packages/perps/providers/phoenix-provider.ts`

Plan:

- read Phoenix collateral and available margin from trader state
- map open positions into the same response shape as other venues
- if Phoenix exposes realized funding payment history, add it to activity endpoints
- if user-level funding payment history is not exposed cleanly, separate that from historical market funding rate support and mark it as a possible gap

## 14. Worker Support

Phoenix must be added everywhere worker logic assumes a closed set of venues.

### Funding worker

- `core-worker/funding-rates/service.ts`

Plan:

- call Phoenix funding fetcher during scheduled collection
- upsert into `funding_rate_history`

### Opportunity detection

- `core-worker/services/opportunity-checker.ts`

Plan:

- extend parser to understand Phoenix as another venue column from `/api/arb/markets`
- ensure APR / spread logic includes Phoenix without breaking current assumptions

### Live position fetcher

- `core-worker/services/arb-position-fetcher.ts`

Plan:

- add a Phoenix branch for user position reads
- reuse shared provider access rather than bespoke logic

### OI monitor

- `core-worker/services/oi-monitor.ts`

Plan:

- source Phoenix OI updates from streams or stable polling
- integrate into risk tagging like the other venues

### Producer allowlist

- `core-worker/queue/arb-producer.ts`

Plan:

- add `phoenix` to the supported base protocol list so candidate pairs are not filtered out

## 15. Mark Price And Market Data Feed

Two consumers need Phoenix mark pricing:

- frontend live feed via `api/services/mark-price-feed.ts`
- worker and backend price fetches via `packages/perps/market-data.ts`

Plan:

- add Phoenix mark price source
- decide whether to use stream subscriptions or periodic pull based on stability and cost
- keep fallback behavior consistent with current venue implementations

Preference:

- use Rise streaming if it is stable in our runtime and matches current server process model
- otherwise use a reliable HTTP polling fallback for initial rollout

## 16. Error Handling And Operational Behavior

Phoenix-specific errors should plug into the same user-facing error style used in arb routes.

Plan:

- map invite-required or not-registered cases to actionable messages
- map insufficient collateral separately from generic order failure
- surface queued withdrawal state clearly
- preserve existing pair failure semantics if one leg succeeds and the other fails

This matters most in:

- `api/api/arb/trade.ts`
- `api/api/arb/close.ts`
- deposit and withdrawal handlers

## 17. Migrations / Config / Env

Expected config additions:

- `PHOENIX_API_URL`
- Phoenix RPC or cluster config if not inherited from existing Solana RPC config
- `PHOENIX_INVITE_CODE`
- optional `PHOENIX_INVITE_MODE`

Potential DB migration needs:

- add `phoenix` to `transfer_protocol`
- add `phoenix` to any venue enum used in arb rows or serialized filters
- add `phoenix` to `exchange_name` only if the final implementation truly needs exchange credential persistence

## 18. Open Questions To Resolve Before Implementation

These should be verified directly against the Phoenix SDK/docs before coding starts:

1. Does Rise expose native TP/SL order creation in a way that matches our current `setTakeProfit` and `setStopLoss` flow?
2. Is user-level funding payment history exposed, or only market-level historical funding rates?
3. Are mark price, market stats, and OI streams stable enough for server use, or should v1 rely on polling?
4. What exact market symbol format does Phoenix return, and how should that map to our canonical symbol normalization?
5. Do Phoenix withdrawals return synchronous finality, a queued state, or both depending on system conditions?
6. Does Phoenix require any persisted venue-specific session state, or can we operate entirely from wallet authority plus invite activation and trader-state reads?

## 19. Recommended Implementation Order

1. Add protocol/type/enum support for `phoenix`
2. Build shared Phoenix client
3. Build Phoenix provider
4. Wire registry and market cache
5. Add market discovery and live mark price support
6. Add funding fetcher and history exposure
7. Add balance and positions support
8. Add invite activation flow
9. Add deposit and withdraw endpoints
10. Add trade and close support
11. Add TP/SL support
12. Add worker support and risk monitoring
13. Run end-to-end validation on one market first, then expand

This order keeps data visibility and onboarding in place before execution paths.

## 20. Acceptance Criteria

Phoenix integration is ready for rollout when all of the following are true:

- `/api/arb/markets` returns a Phoenix venue column with normalized symbols and live prices
- Phoenix funding history appears in `/api/arb/funding-rates/history` and `/api/arb/funding-rates/history/:dex`
- a user can be auto-activated with the configured backend invite code
- a user can deposit Solana USDC into Phoenix through our API
- a user can withdraw Solana USDC from Phoenix through our API with clear queued-state handling
- a user can open an arb trade with Phoenix as one leg
- a user can close a Phoenix leg through existing close flows
- TP/SL support is either working or explicitly deferred with documented reasons
- balances and positions include Phoenix
- worker funding, pricing, OI, and live-position logic do not skip or break on Phoenix

## 21. Risks And Product Notes

- Phoenix docs currently describe access-code gating, which means onboarding is not fully permissionless
- Phoenix docs also state availability limitations that need product/compliance review before production rollout
- TP/SL support may be the biggest functional unknown until exact Rise order primitives are confirmed
- Withdrawal queue behavior may require UX and status-model adjustments
- Symbol normalization must be done carefully or arb spread and funding history comparisons will be wrong

## Final Recommendation

Implement Phoenix through a shared `packages/perps` provider/client integration centered on the Rise SDK, then wire it into existing `api` and `core-worker` seams rather than creating a one-off Phoenix path.

That gives us:

- consistent market normalization
- reusable funding ingestion
- less route-level duplication
- cleaner worker support
- lower long-term maintenance cost

The most important non-obvious design choice is to treat Phoenix as a standard arb venue in the existing architecture, while keeping onboarding, Solana collateral flows, and any Phoenix-specific order semantics encapsulated in a dedicated provider layer.
