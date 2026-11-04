# Decisions

Non-obvious choices, one line each: **decision** — why.

## Product

- **Fork glyph instead of writing from scratch** — the reach comes from its mechanics (trials on X, quote with your own card, invite link), and its engine is MIT, small and already hardened (server timers, oEmbed checks, ledger, rate limits). Rebuilding it would only add bugs.
- **Same trials as glyph: follow, like, repost, reply, quote with the pass** — the experiment is about reach, so the loop that made every participant a carrier stays intact. Rewarding follows/likes/reposts is against X's platform-manipulation rules; the owner accepted that risk for this experiment.
- **$SIG token, wallet and NFT mint kept as in glyph** — the owner is launching $SIG on Solana, so the reserve, the pending allocation, the wallet step, `/mintallo` and the NFT → $SIG swap all stay. Wording follows the honesty layer: pending, not a balance; airdrop planned, not promised; "launching soon" until the CA is set.
- **The NFT image is our operator pass, drawn on the server** — same satellite primitives (`shared/sky.mjs`) as the site, rendered to SVG and then PNG with resvg, so nobody can forge the numbers. Minting, metadata and the Solana code are glyph's, unchanged apart from names.
- **NFT fonts are Geist Mono + Manrope** — the site's fonts could not be fetched while building; the TTFs glyph shipped (OFL) render fine. Swap in Martian Mono / Space Grotesk later if wanted (SETUP.ru.md → NFT).
- **The log (leaderboard) added on top** — rank is on the pass and in the menu; a public ranking gives people a reason to keep climbing before the drop.
- **`/uplink` replaces `/glyphfree`; `/mintallo` kept** — one command for the launch post, the second opens the mint like in glyph.

## World and look

- **North star: a forgotten satellite's telemetry console** — the character is a broken satellite, so the whole page is its sky: stars, the earth turning below, debris, and the console UI it talks through.
- **Green phosphor on near-black; the reward colour is the white-hot end of the same phosphor** — red, amber and green keep their meanings (error, waiting, done). Not a repeat of earlier sites: solana matrix is purple/green/cyan on void, crawl planet cyan/magenta.
- **Fonts: Major Mono Display (display), Space Grotesk (UI), Martian Mono (numbers, canvas)** — none used on earlier sites; Martian Mono's square glyphs suit the cell grid.
- **Square corners, corner ticks, scanlines** — the console's frame language instead of glyph's soft glass and rounded cards.
- **Cells get a tinted square behind the glyph** — pure glyphs read as noise at 9–12 px; the mosaic makes the hull and continents read as solid bodies (same trick glyph uses).
- **The dish tracks you** — towards the composer while you type, the earth while it thinks, the cursor otherwise. The satellite glitches (rows tear) while thinking; a transmission beams down after a reward.
- **Boot screen once per session, under 4 s, skippable, off with reduced motion** — per the project rules; it also sells "broken satellite" in two seconds (the damaged solar array line).
- **Sound is synthesised blips, off by default** — per the project rules; toggle in the menu.
- **Light theme is "printout"** — the same sky on telemetry paper, not an inverted copy.

## Tech

- **Kept glyph's stack (Vite + vanilla TS, Netlify Functions, Supabase RPC)** — matches archetype A; no reason to move.
- **New migration `0013_signal.sql` instead of editing 0001–0012** — anyone who already ran glyph's migrations upgrades with one file; fresh installs run all 13.
- **Shared sky primitives (`shared/sky.mjs`, plain JS)** — the live engine, the operator pass, the brand renders and the server-side NFT draw the same satellite, so the one on your pass is the one you talked to.
- **Callsign and satellite markings seeded by handle (FNV + mulberry32)** — same handle, same pass, every time; no storage needed.
- **`/api/leaderboard` keeps `no-store`** — project rule for all API responses; it is one cheap indexed query.
