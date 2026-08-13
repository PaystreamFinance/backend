# Paystream Backend

> **Archived reference implementation.** Paystream is no longer actively maintained. This code has not been independently audited and must not be used to custody funds or execute production trades without a complete security review.

The Paystream backend contains the API server, background workers, database package, alerting package, and exchange integrations used by the Paystream application.

The code is published for education, research, and reuse. It is provided without hosted infrastructure, credentials, operational support, or any guarantee that third-party exchange and wallet APIs remain compatible.

## Security and financial-risk warning

This service can request signatures and execute financial transactions. Incorrect configuration or defects can cause permanent loss of funds.

- Use test networks and disposable wallets first.
- Generate unique secrets for every deployment.
- Keep API and worker services on private networks when possible.
- Restrict `CORS_ORIGINS` to the exact web origins you control.
- Never log wallet authorization material, API secrets, full RPC URLs, or signed payloads.
- See [SECURITY.md](SECURITY.md) before deploying or reporting a vulnerability.

Nothing in this repository is financial, investment, legal, or tax advice.

## Structure

```text
paystream/
├── api/                Hono API server and Telegram bot
├── core-worker/        BullMQ background workers
└── packages/
    ├── alerts/         Operational alerting
    ├── db/             Drizzle schema and migrations
    └── perps/          Exchange clients and market-data providers
```

The API authenticates user routes through Privy. Worker-to-API routes use a separate `x-service-key`; the key must contain at least 32 characters and should be generated independently for each environment.

## Local development

Requirements:

- Bun 1.3 or newer
- PostgreSQL
- Redis

```bash
cp api/.env.example api/.env
cp core-worker/.env.example core-worker/.env

# Generate one shared key and place it in both env files.
openssl rand -hex 32

bun install --frozen-lockfile
bun run db:migrate
bun run dev
```

Run the worker separately:

```bash
bun run worker
```

Do not copy example credentials into a public deployment. Use a secrets manager or your hosting provider's encrypted environment configuration.

## Validation

```bash
bun run typecheck
bun audit
```

## Project status

This repository is archived in the maintenance sense: issues and pull requests may not receive a response. Protocol integrations, dependencies, migrations, and infrastructure scripts represent the state of the project at publication time.

## License

Licensed under the [Apache License 2.0](LICENSE). Paystream names and logos are not granted for use by the license; see the trademark clause in the license.
