# Decisions

Non-obvious choices, one line each: **decision** — why.

## Product

- **Reach through the loop: trials on X, quote with your own pass, invite link** — every participant becomes a carrier. The engine stays small: server timers, a ledger, rate limits.
- **Trials: follow, like, repost, reply, quote with the pass** — the experiment is about reach, so every trial makes the participant a carrier. Rewarding follows/likes/reposts is against X's platform-manipulation rules; the owner accepted that risk for this experiment.
- **$SIG token, wallet and NFT mint** — the owner is launching $SIG on Solana, so there is a reserve, a pending allocation, a wallet step, `/mintallo` and the NFT → $SIG swap. Wording follows the honesty layer: pending, not a balance; airdrop planned, not promised; "launching soon" until the CA is set.
- **The NFT image is our operator pass, drawn on the server** — same satellite primitives (`shared/sky.mjs`) as the site, rendered to SVG and then PNG with resvg, so nobody can forge the numbers.
- **NFT fonts are Geist Mono + Manrope** — the site's fonts could not be fetched while building; these OFL TTFs render fine. Swap in Martian Mono / Space Grotesk later if wanted (SETUP.md → NFT).
- **The log (leaderboard) added on top** — rank is on the pass and in the menu; a public ranking gives people a reason to keep climbing before the drop.
- **Two commands: `/uplink` and `/mintallo`** — one for the launch post, the second opens the mint.

## World and look

- **North star: a forgotten satellite's telemetry console** — the character is a broken satellite, so the whole page is its sky: stars, the earth turning below, debris, and the console UI it talks through.
- **Green phosphor on near-black; the reward colour is the white-hot end of the same phosphor** — red, amber and green keep their meanings (error, waiting, done). Not a repeat of earlier sites: solana matrix is purple/green/cyan on void, crawl planet cyan/magenta.
- **Fonts: Major Mono Display (display), Space Grotesk (UI), Martian Mono (numbers, canvas)** — none used on earlier sites; Martian Mono's square letterforms suit the cell grid.
- **Square corners, corner ticks, scanlines** — the console's frame language, no soft glass or rounded cards.
- **Cells get a tinted square behind the character** — bare characters read as noise at 9–12 px; the mosaic makes the hull and continents read as solid bodies.
- **The dish tracks you** — towards the composer while you type, the earth while it thinks, the cursor otherwise. The satellite glitches (rows tear) while thinking; a transmission beams down after a reward.
- **Boot screen once per session, under 4 s, skippable, off with reduced motion** — per the project rules; it also sells "broken satellite" in two seconds (the damaged solar array line).
- **Sound is synthesised blips, off by default** — per the project rules; toggle in the menu.
- **Light theme is "printout"** — the same sky on telemetry paper, not an inverted copy.

## Tech

- **Stack: Vite + vanilla TS, `(Request) => Response` handlers, Supabase RPC** — small, no framework; the handlers run on Netlify or behind `server.mjs` on a VPS.
- **Migrations only move forward** — each change is a new numbered file; a fresh install runs them all in order.
- **Shared sky primitives (`shared/sky.mjs`, plain JS)** — the live engine, the operator pass, the brand renders and the server-side NFT draw the same satellite, so the one on your pass is the one you talked to.
- **Callsign and satellite markings seeded by handle (FNV + mulberry32)** — same handle, same pass, every time; no storage needed.
- **`/api/leaderboard` keeps `no-store`** — project rule for all API responses; it is one cheap indexed query.
