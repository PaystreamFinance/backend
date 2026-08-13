# API

Hono API server + Telegram bot. Handles all client-facing requests, trade execution, and wallet management.

## Run

```bash
bun run dev       # watch mode on :9090
bun run main.ts   # no watch
```

## Routes

| Path | Description |
|------|-------------|
| `/arb/*` | Arbitrage trading — open, close, deposits, withdrawals, fees, markets |
| `/pacifica/*` | Pacifica balance, deposits, withdrawals |
| `/trade/*` | Spot-perp trading |
| `/swap/*` | Jupiter swap quotes and execution |
| `/telegram/*` | Telegram account linking |
| `/internal/*` | Service-to-service endpoints (worker → API) |

## Key Dependencies

- **Hono** — HTTP framework
- **Privy** — Auth + embedded wallets
- **Jito** — Bundle submission
- **grammY** — Telegram bot
- **OpenTelemetry** — Observability
