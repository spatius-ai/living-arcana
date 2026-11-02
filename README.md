# Living Arcana

An interactive daily tarot experience built with React, Three.js and Spatius AvatarKit. Includes daily cards, three-card spreads, streamed readings, voice input and character speech.

## Quick start

Use Node.js 24 and pnpm 10.33.0.

```sh
pnpm install --frozen-lockfile
cp .env.example .env.local
pnpm dev
```

The card interface and curated reading fallback can be explored without API keys. Live avatars, generated readings and speech require your own service credentials. Optional services may show an unavailable state until configured.

## Configuration

Only `.env.example` and `.dev.vars.example` are published. Copy the former to `.env.local` for Vite or the latter to `.dev.vars` for Wrangler. Never commit real credentials.

| Feature | Server configuration | Browser configuration |
| --- | --- | --- |
| Spatius avatars | `SPATIUS_APP_ID`, `SPATIUS_API_KEY`, `SPATIUS_REGION` | `VITE_SPATIUS_APP_ID`, `VITE_SPATIUS_AVATAR_ID`, `VITE_SPATIUS_REGION` |
| Per-card avatars | — | `VITE_SPATIUS_AVATAR_MAP` (JSON keyed by card ID) |
| Generated readings | `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `OPENROUTER_VOICE_MODEL` | — |
| Transcription fallback | `OPENROUTER_API_KEY`, `OPENROUTER_TRANSCRIBE_MODEL` | — |
| Speech and realtime transcription | `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_MAP`, model settings | — |

`VITE_` values are public and embedded into the browser build. API keys must stay server-side. The server mints short-lived Spatius session tokens. No production avatar IDs or service accounts are bundled; supply a fallback avatar or a JSON map such as `{"major-00-fool":"YOUR_AVATAR_ID"}`.

Model defaults are examples; choose model IDs available to your provider account. Without OpenRouter credentials, readings use curated fallback text.

## Commands

```sh
pnpm test
pnpm build
pnpm preview
```

`pnpm preview` serves the static build; use `pnpm dev` for local API middleware. Preview cards with `?card=0` through `?card=21` and backgrounds with `?bg=0` through `?bg=5`.

## Cloudflare deployment

The Worker serves static assets and API routes, with SQLite-backed Durable Objects for anonymous reading quotas. `wrangler.jsonc` contains no production account or custom domain. Before public deployment, configure authentication and abuse controls appropriate to your service; browser quotas do not protect every paid API endpoint.

1. Set your own `VITE_` values in the build environment and your Spatius app ID in Worker configuration.
2. Authenticate Wrangler to your own Cloudflare account.
3. Store credentials as Worker secrets:

```sh
pnpm exec wrangler secret put SPATIUS_API_KEY
pnpm exec wrangler secret put OPENROUTER_API_KEY
pnpm exec wrangler secret put ELEVENLABS_API_KEY
pnpm exec wrangler secret put ELEVENLABS_VOICE_MAP
pnpm deploy
```

Only configure secrets for features you enable. `SPATIUS_APP_ID` can be set as a Worker variable or secret. Deployments are manual; CI only runs tests and builds. Configure your own canonical URL and absolute social-image URLs in `index.html` for a public deployment.

## Repository layout

- `src/`: interface, card content, audio and avatar integration.
- `server/`: provider integrations and quota logic.
- `worker.js`: Cloudflare API routing and Durable Object implementation.
- `public/`: redistributable card artwork, video and audio.
- `tests/`: unit and request-handling tests.

This release is based on upstream `main` at `fe098ad5e909ce176adf781d32ba3b0d170ab031`. Local uncommitted changes and upstream Git history are excluded. See [release scope](docs/OPEN_SOURCE_SCOPE.md).

## License

MIT; see [LICENSE](LICENSE). Bundled project media is included with the project owner's authorization; third-party fonts retain their SIL OFL license. Third-party dependencies retain their own licenses and service access requires your own account. AvatarKit is an external SDK whose package declares `UNLICENSED`; its usage terms are separate from this project's MIT license. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
