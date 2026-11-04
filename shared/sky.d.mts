export type Theme = 'dark' | 'light';
export type Mode = 'idle' | 'thinking' | 'listening';
/** Every character the atlas holds. Order matters only for lookups. */
export declare const CHARS = " .,:;'`-_=+*#%@&$|/\\()<>[]{}~^o0x18SX";
/** Ink slots in the atlas (rows). */
export declare const INK: {
    readonly main: 0;
    readonly dim: 1;
    readonly hot: 2;
    readonly faint: 3;
    readonly alert: 4;
};
export type Ink = (typeof INK)[keyof typeof INK];
export declare const PALETTES: Record<Theme, {
    inks: [string, string, string, string, string];
    glow: number;
    bg: string;
}>;
/** A frame being composed: one character, ink and alpha per cell. Later writes win. */
export declare class Frame {
    cols: number;
    rows: number;
    ch: Uint8Array;
    ink: Uint8Array;
    a: Float32Array;
    bg: Float32Array;
    constructor(cols: number, rows: number);
    clear(): void;
    set(x: number, y: number, ch: string, ink: number, a: number, bg?: number): void;
    /** Blank a cell (used to cut the satellite out of the stars behind it). */
    erase(x: number, y: number): void;
    covered(x: number, y: number): boolean;
}
export declare const hash2: (x: number, y: number) => number;
/** Smooth 3D value noise in [0,1] (sampled on the sphere, so continents have no seam). */
export declare function noise3(x: number, y: number, z: number): number;
/** Seeded random stream (mulberry32). */
export declare const rng: (seed: number) => () => number;
export declare const fnv: (s: string) => number;
/** A sparse field of stars, drifting left slowly. `skip` keeps them out of cells already drawn. */
export declare function drawStars(f: Frame, t: number, drift?: number, density?: number): void;
export interface Planet {
    cx: number;
    cy: number;
    r: number;
    spin: number;
    light: [number, number, number];
}
/** Paint the planet: continents, clouds, the night side's city lights and a thin atmosphere rim. */
export declare function drawPlanet(f: Frame, p: Planet, t: number, opts?: {
    y0?: number;
}): void;
export interface Sat {
    x: number;
    y: number;
    angle: number;
    scale: number;
    dish: number;
    t: number;
    seed: number;
    glitch?: number;
    alpha?: number;
}
/**
 * Draw the satellite: a body, two solar panels on trusses (one cracked), a dish and an antenna with a
 * blinking light. Shapes are tested per cell in the satellite's own frame, so it can tumble freely.
 */
export declare function drawSatellite(f: Frame, s: Sat): void;
/** A ring drawn with / \ - | (pings, clicks). `squash` < 1 flattens it. */
export declare function drawRing(f: Frame, ox: number, oy: number, rr: number, ink: number, alpha: number, squash?: number, arc?: [number, number]): void;
/** Dots travelling from a to b (a transmission). `phase` moves them. */
export declare function drawBeam(f: Frame, ax: number, ay: number, bx: number, by: number, phase: number, ink: number, alpha: number): void;
