# signal

**is anyone out there?**

A broken ASCII satellite in low orbit guards the **$SIG** reserve. Talk to it, pass its trials on X, make your
case, leave a wallet, and mint your operator pass as a compressed NFT on Solana. Allocations are pending and
reviewed before any drop: **airdrop planned, not promised.**

Built on the open-source [glyph](https://github.com/askglyph/glyph) (MIT): same chat-quest engine, mint and
rewards, with a new world, character, operator pass and look.

## How it works

| Step | What happens |
|---|---|
| 1 | `/uplink` — the protocol in one breath, then the first trial. (The launch post tells people to type it.) |
| 2 | Trials on X: follow, like, repost, reply, quote your pass. Each one is checked and credited to the pending allocation. |
| 3 | The pitch: three attempts to talk signal into more. Tough but fair; capped and paid once per tier. Then a wallet. |
| 4 | `/mintallo`: the operator pass as a compressed NFT, minted to the wallet. The reserve pays the gas. Approved operators only. |
| 5 | Quote the pinned post with the NFT for a bonus, then the countdown to the $SIG launch (with the NFT → $SIG swap button, locked until launch). |
| — | Bonus: post with your invite link, bring 2 friends who finish a task. Secret phrases pay once. The log ranks everyone. |

Words come from the model, numbers from the database. The model can only call tools (`show_task`,
`verify_task`, `judge_pitch`, `save_wallet`, `show_invite`, `show_token`); every amount is a fixed SQL function behind an idempotency key.
Without a model endpoint (or when it is slow) a scripted brain answers with the same tools.

## Routes

| Route | What |
|---|---|
| `/` | the site (one chat window over the sky) |
| `GET /auth/x/start` · `GET /auth/x/callback` | X OAuth 2.0 + PKCE |
| `GET /api/health` | which env vars are missing (names only), the exact X callback URL, brain mode. `?llm=1` pings the model |
| `GET /api/me` · `GET /api/history` | the signed-in operator and their chat |
| `GET /api/leaderboard` | the log: top 100 by SIG (public) |
| `POST /api/chat` · `POST /api/task/open` · `POST /api/logout` | chat turn, server-clock task timer, sign-out |
| `POST /api/nft/mint` · `GET /api/nft/status` · `GET /api/nft/preview.png` · `GET /api/nft/health` | the mint, its state, the pass preview, the minting setup |
| `GET /nft/<id>.json` · `GET /nft/<id>.png` · `/nft/collection.json` · `/nft/collection.png` | Metaplex metadata and images, drawn from the database on request |

## Layout

```
shared/brand.mjs     ← every name, handle, post id, ticker, contract, swap link and launch date. Edit this first.
shared/persona.mjs   signal's character and tools (the model's instructions)
shared/brain.mjs     scripted brain, /uplink and /mintallo, reply copy
shared/sky.mjs       the sky primitives (stars, earth, satellite, rings): site, brand renders and NFT image
shared/tasks.mjs     demo task list (production: the `tasks` table)
shared/replies.mjs   suggested reply texts, one per operator
src/space/engine.ts  the live sky
src/card.ts          the operator pass (1200×675 PNG, drawn in the browser)
src/app.ts           the interface; src/boot.ts the boot screen
netlify/functions/   api, auth-start / auth-callback (X), nft (mint, metadata, images)
netlify/lib/         agent loop, sessions + CSRF, X post checks, NFT renderer, Solana mint
netlify/fonts/       fonts for the NFT image (resvg)
scripts/nft-setup.mjs  minting wallet, merkle tree, collection
supabase/migrations/ 0001 → 0013, run in order
scripts/brand.*      renders the OG image, X avatar and header
brand/               the rendered brand kit
```

## Run it

```bash
npm install
npm run dev            # DEMO mode: scripted brain, everything in localStorage → http://127.0.0.1:5193
npx netlify-cli dev    # with the functions (needs .env) → http://127.0.0.1:8888
npm run build          # → dist/
```

Database: create a Supabase project and run `supabase/migrations/0001_init.sql` → `0013_signal.sql` in
order in the SQL editor. Step-by-step setup in Russian, with an error → cause table: **[SETUP.ru.md](SETUP.ru.md)**.

### Environment

| Variable | What it is |
|---|---|
| `X_CLIENT_ID`, `X_CLIENT_SECRET` | X app (Web App, OAuth 2.0). Callback: `https://<domain>/auth/x/callback` |
| `SESSION_SECRET` | 32+ random characters (`openssl rand -base64 48`) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Postgres over RPC, server only |
| `SITE_URL` | public origin, e.g. `https://asksignal.chat` (required on a custom domain) |
| `MODEL_BASE_URL`, `MODEL_API_KEY`, `MODEL_NAME` | any OpenAI-compatible chat-completions endpoint; without it the scripted brain answers |
| `MODEL_OPTIONS`, `CHAT_DEADLINE_MS` | optional |
| `X_MIN_ACCOUNT_AGE_DAYS` | optional anti-farm floor, e.g. 30 |
| `NFT_RPC_URL`, `NFT_SECRET_KEY`, `NFT_TREE`, `NFT_COLLECTION`, `NFT_NETWORK` | minting (see `scripts/nft-setup.mjs`); optional, the site runs without it |

Server-side only; nothing secret ever gets a `VITE_` prefix.

### Minting

`node scripts/nft-setup.mjs keygen`, then `tree --yes` and `collection --site https://<your-domain> --yes`.
Start on devnet. Who may mint, daily caps, the emergency stop: [docs/OPERATIONS.md](docs/OPERATIONS.md).

### Deploy

From Git on Netlify, or `npx netlify-cli deploy --build --prod`. A drag-and-drop upload ships static
files only — no functions, and `/api` breaks. After changing env vars, redeploy.

## Brand kit

`brand/` holds the X avatar (400×400), header (1500×500 and @2x) and the OG image (also in `public/og.png`).
To re-render after changing the look: `npm run dev`, open `http://127.0.0.1:5193/scripts/brand.html`,
and save the canvases (or read `window.__brand`, which holds them as PNG data URLs).

## Honesty

- Allocations are pending, not a balance, and reviewed before any distribution: airdrop planned, not promised.
  signal never promises price, returns, listings or dates beyond the launch date in the config.
- Until `token.ca` is set the site says "launching soon", and signal says anyone showing a contract is lying.
- Demo mode carries a DEMO badge; the demo log holds only you; minting needs the live site.
- Footer: not financial advice · not affiliated with X.

## Security

See [SECURITY.md](SECURITY.md). In short: the browser never talks to the database, amounts never come from
the client or the model, the minting key signs only the one instruction the server built, every mutation
needs a same-origin JSON body, every API response is `no-store`.

## License

MIT. Based on glyph © 2026 glyph (MIT).
