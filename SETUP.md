# signal — setup from scratch

Order: config → X Developer Portal → Supabase → Netlify → checks. About 30–40 minutes in total.

## 0. Project config

Open `shared/brand.mjs` and fill in:

| Field | What to put |
|---|---|
| `site` | your domain, e.g. `https://asksignal.chat` |
| `xHandle` | the X account handle, without `@` |
| `postId` | the pinned post ID (the number in `x.com/<handle>/status/<ID>`) |
| `ticker` / `unit` | the ticker (`SIG`) and how amounts are shown (`$SIG`) |
| `token.ca` | the Solana contract address. While empty, the site says "Launching soon" |
| `swap.url` | the NFT → $SIG swap link. The button is locked until launch, then opens this link |
| `launch.at` / `label` | launch time (ISO with a time zone) and the countdown label; empty means "date not set yet", no countdown |

Tasks take the handle and the post from here, so there is no SQL to touch.

Task texts live in two places: `shared/tasks.mjs` (demo) and the `tasks` table (production, migration `0013_signal.sql`). If you change them, change both.

## 1. X Developer Portal (sign-in with X)

1. developer.x.com → Projects & Apps → create an App inside a Project (without a Project, X API v2 will not return the profile).
2. **User authentication settings:**
   - App permissions: **Read**;
   - Type of App: **Web App, Automated App or Bot**;
   - Callback URI:
     - production `https://YOUR_DOMAIN/auth/x/callback`;
     - local `http://127.0.0.1:8888/auth/x/callback` (X does not accept `localhost`);
   - Website URL: `https://YOUR_DOMAIN`.
3. Keys and tokens → **OAuth 2.0 Client ID and Client Secret** → `X_CLIENT_ID`, `X_CLIENT_SECRET`. These are not the OAuth 1.0a API Key/Secret.

No paid X API tier is needed. X is used only for sign-in: every task on X is counted by a server-side timer (migration `0014_timer_tasks.sql`).

## 2. Supabase

1. Create a project. Pick the region closest to your Netlify functions (us-east by default).
2. SQL Editor → paste and run the migrations **strictly in order**: `0001_init.sql`, `0002_limits.sql`, … `0014_timer_tasks.sql`. All migrations are idempotent, so running one again is safe.
3. Advisors → Security: there must be no "RLS disabled".
4. Project Settings → API:
   - `SUPABASE_URL` = Project URL;
   - `SUPABASE_SERVICE_ROLE_KEY` = service_role / secret key (**server only**).
5. A free project pauses after a week without requests. Press Restore in the dashboard when that happens.

Migration 0013 only renames the tasks for signal. The mechanics, wallets and NFT tables do not change.

## 3. Model (optional)

Any OpenAI-compatible `chat/completions` endpoint with tools support works: `MODEL_BASE_URL`, `MODEL_API_KEY`, `MODEL_NAME`. Without it the scripted brain answers: the character is plainer, but everything works. Daily spend limits live in `app_config` (see `docs/OPERATIONS.md`).

## 4. NFT (minting the pass on Solana, optional)

Without these variables the site works, the "My NFT" menu just does not open. The order:

1. You need an RPC with DAS support (Helius, Triton, etc.) → `NFT_RPC_URL`.
2. On your own machine, after `npm install`:
   - `node scripts/nft-setup.mjs keygen` → the minting wallet in `.nft/minter.json`. Fund it with SOL for gas: about 0.0001 SOL per pass plus a one-time payment for the tree;
   - `node scripts/nft-setup.mjs tree --yes` → merkle tree (`NFT_TREE`);
   - `node scripts/nft-setup.mjs collection --site https://YOUR_DOMAIN --yes` → the collection (`NFT_COLLECTION`).
3. `NFT_SECRET_KEY` = the contents of `.nft/minter.json`, `NFT_NETWORK` = `devnet` (first) or `mainnet`.
4. **Everything on devnet first:** `node scripts/nft-setup.mjs test-mint --to <your wallet> --site https://YOUR_DOMAIN`, then a mint from the site. Only after that switch to mainnet.
5. Who can mint — a list in the database, or "everyone": SQL in `docs/OPERATIONS.md` → Minting. Function check: `/api/nft/health`.

The NFT image is drawn on the server with the fonts in `netlify/fonts` (Geist Mono, Manrope). To give the NFT the same fonts as the site, put the Martian Mono and Space Grotesk TTFs there and change `font-family` in `netlify/lib/nft.mjs`.

## 5. Netlify

1. Code on GitHub → Netlify → Add new site → Import from Git. Or `npx netlify-cli deploy --build --prod`.
   - ⚠️ A drag-and-drop zip uploads **static files only**: the functions will not deploy, and `/api` returns 404 or HTML.
2. Site settings → Environment variables (secrets: Scope: Functions, "Contains secret values"):

| Variable | Value |
|---|---|
| `X_CLIENT_ID`, `X_CLIENT_SECRET` | from the X Portal |
| `SESSION_SECRET` | `openssl rand -base64 48` (at least 32 characters) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | from Supabase |
| `SITE_URL` | `https://YOUR_DOMAIN` (required on your own domain) |
| `MODEL_BASE_URL`, `MODEL_API_KEY`, `MODEL_NAME` | optional |
| `X_MIN_ACCOUNT_AGE_DAYS` | optional, e.g. `30` |
| `NFT_RPC_URL`, `NFT_SECRET_KEY`, `NFT_TREE`, `NFT_COLLECTION`, `NFT_NETWORK` | for minting, see section 4 |

3. **A change to env needs a Redeploy** (Deploys → Trigger deploy).
4. Open `https://YOUR_DOMAIN/api/health`: it should say `ok: true`. Copy `callback_url` from there into the X Portal, character for character.
5. Go through sign-in end to end: X → back to the site → `?auth=ok` → `/api/me` answers 200.

## 6. Running locally

- Interface only: `npm run dev` → `http://127.0.0.1:5193`, demo mode on localStorage with a DEMO badge.
- With functions: `npx netlify-cli dev` → `http://127.0.0.1:8888`; set `SITE_URL=http://127.0.0.1:8888` in `.env`.
- ⚠️ `netlify dev` pulls the site's env, so it writes to the **production** database. Use a separate Supabase project for tests.

## Error → cause

| What you see | Cause |
|---|---|
| Toast "X refused the sign-in", `reason=token` | The callback in the X Portal does not match character for character, a wrong secret, or the app type is not Web App |
| `reason=state` / `expired` | Cookies blocked, sign-in took longer than 10 minutes, or it started on www and came back without www (pin `SITE_URL`) |
| `reason=profile` | The App is not attached to a Project and has no X API v2 access |
| `reason=database` | Migrations not run, a wrong service key, or the Supabase project is paused |
| `reason=config` | No `X_CLIENT_ID` / `X_CLIENT_SECRET` on the server (check `/api/health`, then Redeploy) |
| `reason=too_new` | The account is younger than `X_MIN_ACCOUNT_AGE_DAYS` |
| "Service unavailable" banner, `/api/*` returns HTML or 404 | The functions did not deploy (drag-and-drop), or `npm run dev` is running without `netlify dev` |
| The character answers from a script | No `MODEL_*`, or the daily budget ran out. `/api/health?llm=1` shows whether the model answers |
| "that post does not exist" on a real link | The post is not public, or X oEmbed is temporarily down (then the server checks only the link format) |
| Tasks lead to someone else's post | `postId` in `shared/brand.mjs` is still the default |
| The countdown shows "$SIG is live" right away | The `launch.at` date is already in the past |
| "Minting is not set up yet." | No `NFT_*` variables on the server. `/api/nft/health` shows which |
| "Solana is not answering" / "The reserve is refilling its gas" | The RPC does not answer, or the minting wallet ran out of SOL |
| "Minting is not open for you yet." | The account is not on the mint list (`nft_allowlist`) and `nft_open` is off |
| NFT with no text, or boxes instead of letters | The function did not find the fonts: check `included_files` in `netlify.toml` and that the deploy comes from Git |

## Before launch

- [ ] `/api/health` → ok. Sign-in works in production, on a phone and in the X in-app browser.
- [ ] A repeated "done" does not pay twice. Your own ref link does not count.
- [ ] No secrets in the bundle: `grep -r "service_role\|SECRET" dist/` is empty.
- [ ] Supabase Advisors are clean.
- [ ] Handle, post ID, launch date and CA (or "Launching soon") in `shared/brand.mjs` are real.
- [ ] Minting tested on devnet, the minting wallet has SOL, `/api/nft/health` → ok.
- [ ] The OG image shows in the X preview (send the link to yourself in a DM).
- [ ] No horizontal scroll at 375px, `prefers-reduced-motion` works.
- [ ] Any keys ever pasted into a chat have been rotated.
