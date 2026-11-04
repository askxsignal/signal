// Shared by the site (src/space, src/card.ts), the brand renders and the NFT image on the server.
// Plain JS so Netlify functions import it as-is. Types: sky.d.mts.
// Shared drawing primitives for the orbit: everything is a grid of cells, one glyph per cell.
// The live sky (engine.ts) and the operator pass (card.ts) both draw with these, so the satellite on
// your pass is the same machine you talk to.
/** Every glyph the atlas holds. Order matters only for lookups. */
export const GLYPHS = " .,:;'`-_=+*#%@&$|/\\()<>[]{}~^o0x18SX";
/** Ink slots in the atlas (rows). */
export const INK = { main: 0, dim: 1, hot: 2, faint: 3, alert: 4 };
export const PALETTES = {
    // night sky, green phosphor; the reward colour is the white-hot end of the same phosphor
    dark: { inks: ['#9fe3b8', '#4f7d64', '#effff3', '#6d8a7a', '#ff5d4d'], glow: 0.55, bg: '#06080c' },
    // the same sky printed on telemetry paper
    light: { inks: ['#14261c', '#7c8a82', '#0b7a43', '#9aa59f', '#c4372a'], glow: 0, bg: '#ebe8df' },
};
/** A frame being composed: one glyph, ink and alpha per cell. Later writes win. */
export class Frame {
    cols;
    rows;
    ch;
    ink;
    a;
    bg; // a tinted square behind the glyph (0 = none): what makes bodies read as solid
    constructor(cols, rows) {
        this.cols = cols;
        this.rows = rows;
        const n = cols * rows;
        this.ch = new Uint8Array(n);
        this.ink = new Uint8Array(n);
        this.a = new Float32Array(n);
        this.bg = new Float32Array(n);
    }
    clear() {
        this.ch.fill(0);
        this.a.fill(0);
        this.bg.fill(0);
    }
    set(x, y, ch, ink, a, bg = 0) {
        x = Math.round(x);
        y = Math.round(y);
        if (x < 0 || y < 0 || x >= this.cols || y >= this.rows || a <= 0.01)
            return;
        const i = GLYPHS.indexOf(ch);
        if (i <= 0)
            return;
        const k = y * this.cols + x;
        this.ch[k] = i;
        this.ink[k] = ink;
        this.a[k] = Math.min(1, a);
        this.bg[k] = Math.min(1, bg);
    }
    /** Blank a cell (used to cut the satellite out of the stars behind it). */
    erase(x, y) {
        if (x < 0 || y < 0 || x >= this.cols || y >= this.rows)
            return;
        this.a[y * this.cols + x] = 0;
        this.bg[y * this.cols + x] = 0;
    }
    covered(x, y) {
        return x >= 0 && y >= 0 && x < this.cols && y < this.rows && this.a[y * this.cols + x] > 0.05;
    }
}
// ------------------------------------------------------------------ numbers
export const hash2 = (x, y) => {
    let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return (h ^ (h >>> 16)) >>> 0;
};
const hash3 = (x, y, z) => hash2(hash2(x, y), z) / 4294967296;
/** Smooth 3D value noise in [0,1] (sampled on the sphere, so continents have no seam). */
export function noise3(x, y, z) {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const xf = x - xi, yf = y - yi, zf = z - zi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
    const lerp = (a, b, t) => a + (b - a) * t;
    const c = (dx, dy, dz) => hash3(xi + dx, yi + dy, zi + dz);
    return lerp(lerp(lerp(c(0, 0, 0), c(1, 0, 0), u), lerp(c(0, 1, 0), c(1, 1, 0), u), v), lerp(lerp(c(0, 0, 1), c(1, 0, 1), u), lerp(c(0, 1, 1), c(1, 1, 1), u), v), w);
}
const fbm = (x, y, z) => noise3(x, y, z) * 0.55 + noise3(x * 2.1, y * 2.1, z * 2.1) * 0.3 + noise3(x * 4.3, y * 4.3, z * 4.3) * 0.15;
/** Seeded random stream (mulberry32). */
export const rng = (seed) => () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
export const fnv = (s) => {
    let h = 2166136261;
    for (const c of s)
        h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    return h >>> 0;
};
// ------------------------------------------------------------------ stars
/** A sparse field of stars, drifting left slowly. `skip` keeps them out of cells already drawn. */
export function drawStars(f, t, drift = 0.18, density = 0.014) {
    const off = t * drift;
    const shift = Math.floor(off);
    for (let y = 0; y < f.rows; y++) {
        for (let x = 0; x < f.cols; x++) {
            const sx = x + shift;
            const h = hash2(sx, y);
            if (h / 4294967296 > density)
                continue;
            const kind = h % 11;
            const tw = 0.35 + 0.45 * (0.5 + 0.5 * Math.sin(t * (0.6 + (h % 7) * 0.25) + (h % 97)));
            const ch = kind === 0 ? '*' : kind < 3 ? '+' : '.';
            f.set(x, y, ch, kind === 0 ? INK.main : INK.faint, tw * (kind === 0 ? 0.9 : 0.7));
        }
    }
}
const LAND = ['@', '%', '#', '8', 'X', 'S'];
const SHORE = ['*', '+', '=', 'o'];
const SEA = ['.', ',', '.', "'"];
/** Paint the planet: continents, clouds, the night side's city lights and a thin atmosphere rim. */
export function drawPlanet(f, p, t, opts = {}) {
    const x0 = Math.max(0, Math.floor(p.cx - p.r - 2));
    const x1 = Math.min(f.cols - 1, Math.ceil(p.cx + p.r + 2));
    const y0 = Math.max(opts.y0 ?? 0, Math.floor(p.cy - p.r - 2));
    const y1 = Math.min(f.rows - 1, Math.ceil(p.cy + p.r + 2));
    const cs = Math.cos(p.spin), sn = Math.sin(p.spin);
    const [lx, ly, lz] = p.light;
    for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
            const dx = (x + 0.5 - p.cx) / p.r;
            const dy = (y + 0.5 - p.cy) / p.r;
            const d2 = dx * dx + dy * dy;
            const h = hash2(x, y);
            if (d2 > 1) {
                // atmosphere: a thin rim, brighter on the lit side
                const d = Math.sqrt(d2);
                if (d < 1 + 1.6 / p.r) {
                    const lit = Math.max(0, (dx * lx + dy * ly) / d);
                    f.set(x, y, h % 3 ? '.' : ':', INK.main, 0.18 + lit * 0.55);
                }
                continue;
            }
            const nz = Math.sqrt(1 - d2);
            // rotate the surface point around the vertical axis
            const sx = dx * cs + nz * sn;
            const sz = -dx * sn + nz * cs;
            const land = fbm(sx * 1.7 + 11, dy * 1.7 + 3, sz * 1.7 + 7);
            const cloud = fbm(sx * 2.6 + t * 0.03 + 40, dy * 3.2, sz * 2.6 + 20);
            const L = dx * lx + dy * ly + nz * lz; // lambert
            const day = Math.max(0, L);
            const limb = 0.55 + 0.45 * nz; // darker towards the edge
            if (L < -0.08) {
                // night side: dark sea, and sparse city lights on land
                if (land > 0.53 && h % 9 === 0)
                    f.set(x, y, h % 2 ? '.' : '*', INK.hot, 0.45 + 0.25 * Math.sin(t * 2 + h), 0.06);
                else if (land > 0.53)
                    f.set(x, y, '.', INK.dim, 0.3 * limb, 0.07 * limb);
                else
                    f.set(x, y, h % 5 === 0 ? '.' : ' ', INK.dim, 0.15, 0.035);
                continue;
            }
            if (cloud > 0.64) {
                f.set(x, y, cloud > 0.7 ? '~' : '-', INK.hot, (0.3 + day * 0.6) * limb, (0.06 + day * 0.14) * limb);
                continue;
            }
            if (land > 0.53) {
                const ramp = land > 0.6 ? LAND : SHORE;
                f.set(x, y, ramp[h % ramp.length], INK.main, (0.4 + day * 0.65) * limb, (0.1 + day * 0.32) * limb);
            }
            else {
                f.set(x, y, h % 3 ? SEA[h % SEA.length] : ' ', INK.dim, (0.2 + day * 0.45) * limb, (0.04 + day * 0.07) * limb);
            }
        }
    }
}
/**
 * Draw the satellite: a body, two solar panels on trusses (one cracked), a dish and an antenna with a
 * blinking light. Shapes are tested per cell in the satellite's own frame, so it can tumble freely.
 */
export function drawSatellite(f, s) {
    const A = s.alpha ?? 1;
    const r = rng(s.seed);
    const PW = 11; // panel length
    const PH = 4; // panel height (half: 2)
    const crackAt = Math.floor(r() * (PW - 3)) + 1; // where the left panel is broken
    const crackSlope = r() < 0.5 ? 1 : -1;
    const missing = new Set();
    for (let i = 0; i < 3 + Math.floor(r() * 3); i++)
        missing.add(Math.floor(r() * PW) * 8 + Math.floor(r() * PH));
    const extent = (4 + 2 + PW + 1) * s.scale;
    const cs = Math.cos(-s.angle), sn = Math.sin(-s.angle);
    const x0 = Math.floor(s.x - extent), x1 = Math.ceil(s.x + extent);
    const y0 = Math.floor(s.y - extent), y1 = Math.ceil(s.y + extent);
    const dishDir = s.dish - s.angle; // dish direction in the body's frame
    const ddx = Math.cos(dishDir), ddy = Math.sin(dishDir);
    // the dish sits on the body's rim on the side it points to
    const dcx = ddx * 3.4, dcy = ddy * 3.4;
    const blink = Math.sin(s.t * 3.1) > 0.55;
    const flick = Math.floor(s.t * 7);
    for (let y = y0; y <= y1; y++) {
        // glitch: tear a few rows sideways
        let tear = 0;
        if (s.glitch && hash2(y, Math.floor(s.t * 12)) % 5 === 0)
            tear = Math.round(((hash2(y, Math.floor(s.t * 12) + 1) % 7) - 3) * s.glitch);
        for (let x = x0; x <= x1; x++) {
            const px = (x + 0.5 - s.x) / s.scale;
            const py = (y + 0.5 - s.y) / s.scale;
            const u = px * cs - py * sn;
            const v = px * sn + py * cs;
            const h = hash2(x, y);
            const put = (ch, ink, a, bg = 0) => f.set(x + tear, y, ch, ink, a * A, bg * A);
            // body: 6 x 6, dense, a darker seam
            if (Math.abs(u) <= 3 && Math.abs(v) <= 3) {
                const edge = Math.abs(u) > 2.4 || Math.abs(v) > 2.4;
                put(edge ? '#' : ['@', '8', '%', '&'][h % 4], INK.main, edge ? 0.95 : 0.85, edge ? 0.42 : 0.3);
                continue;
            }
            // trusses: thin bars from body to panels
            const side = u < 0 ? -1 : 1;
            const au = Math.abs(u);
            if (au > 3 && au <= 5 && Math.abs(v) < 0.6) {
                put('=', INK.main, 0.8, 0.12);
                continue;
            }
            // panels
            if (au > 5 && au <= 5 + PW && Math.abs(v) <= PH / 2) {
                const pu = Math.floor(au - 5);
                const pv = Math.floor(v + PH / 2);
                if (side < 0) {
                    // the cracked panel: a diagonal break, a few cells gone, some flicker
                    const k = pu - crackAt - crackSlope * (v * 0.6);
                    if (Math.abs(k) < 0.55) {
                        put('/', INK.alert, 0.85, 0.12);
                        continue;
                    }
                    if (missing.has(pu * 8 + pv))
                        continue;
                    if (pu > crackAt && (h + flick) % 23 === 0)
                        continue;
                }
                const grid = (au - 5) % 3 < 0.9;
                put(grid ? '|' : Math.abs(v) < 0.5 ? '-' : (h % 2 ? '#' : '='), grid ? INK.dim : INK.main, grid ? 0.8 : 0.85, grid ? 0.1 : 0.24);
                continue;
            }
            // dish: a curved arc opening towards dishDir, plus its feed
            const qx = u - dcx, qy = v - dcy;
            const qd = Math.hypot(qx, qy);
            const along = (qx * ddx + qy * ddy) / (qd || 1);
            if (qd > 1.6 && qd < 2.7 && along < -0.15) {
                const th = Math.atan2(qy, qx) + s.angle;
                const tx = -Math.sin(th), ty = Math.cos(th);
                const ch = Math.abs(tx) > Math.abs(ty) * 2.2 ? '-' : Math.abs(ty) > Math.abs(tx) * 2.2 ? '|' : tx * ty > 0 ? '\\' : '/';
                put(ch, INK.main, 0.95);
                continue;
            }
            if (qd <= 1.6 && along > -0.2 && Math.abs(qx * -ddy + qy * ddx) < 0.5) {
                put(qd < 0.8 ? 'o' : '-', INK.hot, 0.9);
                continue;
            }
            // antenna: from the corner opposite the dish, with a blinking tip
            const ax = -ddx * 3 - ddy * 2.2, ay = -ddy * 3 + ddx * 2.2;
            const bx = ax - ddx * 4.2, by = ay - ddy * 4.2;
            const tt = ((u - ax) * (bx - ax) + (v - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2);
            if (tt >= 0 && tt <= 1) {
                const ex = ax + (bx - ax) * tt - u, ey = ay + (by - ay) * tt - v;
                if (Math.hypot(ex, ey) < 0.5) {
                    if (tt > 0.85)
                        put('*', blink ? INK.alert : INK.dim, blink ? 1 : 0.5);
                    else
                        put(Math.abs(ddx) > Math.abs(ddy) ? '-' : '|', INK.dim, 0.8);
                    continue;
                }
            }
            // cut out the stars right behind the hull so the silhouette reads
            if (au <= 5 + PW + 0.5 && Math.abs(v) <= PH / 2 + 0.5)
                f.erase(x, y);
        }
    }
}
// ------------------------------------------------------------------ rings and dotted lines
/** A ring drawn with / \ - | (pings, clicks). `squash` < 1 flattens it. */
export function drawRing(f, ox, oy, rr, ink, alpha, squash = 0.92, arc) {
    if (rr < 1.2)
        return;
    const n = Math.ceil(Math.PI * 2 * rr * 1.3);
    const seen = new Set();
    for (let k = 0; k < n; k++) {
        const th = (k / n) * Math.PI * 2;
        if (arc) {
            const dd = Math.atan2(Math.sin(th - arc[0]), Math.cos(th - arc[0]));
            if (Math.abs(dd) > arc[1])
                continue;
        }
        const cx = Math.round(ox + Math.cos(th) * rr);
        const cy = Math.round(oy + Math.sin(th) * rr * squash);
        const key = cy * 100000 + cx;
        if (seen.has(key))
            continue;
        seen.add(key);
        const tx = -Math.sin(th), ty = Math.cos(th);
        const ch = Math.abs(tx) > Math.abs(ty) * 2.2 ? '-' : Math.abs(ty) > Math.abs(tx) * 2.2 ? '|' : tx * ty > 0 ? '\\' : '/';
        f.set(cx, cy, ch, ink, alpha);
    }
}
/** Dots travelling from a to b (a transmission). `phase` moves them. */
export function drawBeam(f, ax, ay, bx, by, phase, ink, alpha) {
    const len = Math.hypot(bx - ax, by - ay);
    const n = Math.max(2, Math.floor(len / 2.2));
    for (let i = 0; i < n; i++) {
        const u = ((i + phase) % n) / n;
        const fade = Math.sin(u * Math.PI);
        f.set(ax + (bx - ax) * u, ay + (by - ay) * u, i % 3 === 0 ? '+' : '.', ink, alpha * fade);
    }
}
