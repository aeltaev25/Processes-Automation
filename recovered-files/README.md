Recovered files moved from Processes-Automation/.git on 2026-05-26

Contents:
- Core Config loader with environment validation.ts
- Enterprise Architecture
- Enterprise structured logger using Winston.ts
- Full Project Directory Structure
- Main backend package with all enterprise dependencies.json
- Postgresql connection pool with full enterprise config.ts
- Prometheus metrics definitions.ts
- RabbitMQ event bus service.ts
- Redis Cache service with leaky bucket rate limiter.ts
- TypeScript config for backend.json
- bash Starting
- package.json-for-backend.json

Action taken:
- Files moved to this folder to avoid corruption of git metadata.

Suggested placements (draft):
- `Core Config loader with environment validation.ts` -> `Processes-Automation/config/` (as `config/env-loader.ts`)
- `Postgresql connection pool with full enterprise config.ts` -> `Processes-Automation/config/database.ts` (review and merge with existing `config/database.js`)
- `Enterprise structured logger using Winston.ts` and `Logger` artifacts -> `Processes-Automation/config/logger.js` or `Processes-Automation/middleware/`
- `Prometheus metrics definitions.ts` -> `Processes-Automation/monitoring/` or `Processes-Automation/k8s/` depending on intended use
- `RabbitMQ event bus service.ts` -> `Processes-Automation/services/` or `Processes-Automation/config/rabbitmq.js`
- `Redis Cache service with leaky bucket rate limiter.ts` -> `Processes-Automation/services/` or `Processes-Automation/config/redis.js`
- `TypeScript config for backend.json` -> root or `tsconfig.backend.json` if you want to add TypeScript support
- `package.json-for-backend.json` -> review and merge into any backend package manifests if needed

Next steps (I can do any of these):
- Move individual files from this folder into the suggested locations and create `.sample` copies if you prefer.
- Force-add and commit these recovered files into the `Processes-Automation` repo (I can do this now).
- Push commits to the remote for both `Processes-Automation` and `advantour`.

If you want me to proceed with moving files into the suggested locations and pushing, confirm and I'll perform the operations now.
