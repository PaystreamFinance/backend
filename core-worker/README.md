# Core Worker

BullMQ background workers for position monitoring and funding rate collection.

## Run

```bash
bun run main.ts
```

Requires Redis for BullMQ queues.

## Services

| Service | Description |
|---------|-------------|
| Arb monitor | Checks liquidation proximity, size drift, funding rate flips. Auto-closes positions via API. |
| Spot-perp monitor | Monitors spot-perp positions for close conditions. |
| Funding rates | Fetches rates from 5 DEXes hourly, stores history, prunes old data. |

## Key Dependencies

- **BullMQ** — Job queues (producer/worker pattern)
- **ioredis** — Redis client
- **@paystream/perps** — Protocol clients
- **@paystream/db** — Database access
