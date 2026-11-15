/** Color ramps as [t, r, g, b, a] stops, t in 0..1. Expanded to 256-entry RGBA lookup tables. */
export type Stop = [number, number, number, number, number];

export const RAMPS: Record<string, Stop[]> = {
  // Ember to white-hot. Low end stays clearly visible over dark and green imagery.
  fire: [
    [0.0, 120, 20, 10, 150],
    [0.2, 200, 40, 20, 190],
    [0.45, 240, 100, 30, 215],
    [0.7, 252, 170, 50, 235],
    [0.88, 255, 225, 120, 245],
    [1.0, 255, 255, 230, 255],
  ],
  // Perceptually ordered blue to yellow, for non-fire variables.
  viridis: [
    [0.0, 68, 1, 84, 200],
    [0.25, 59, 82, 139, 215],
    [0.5, 33, 145, 140, 230],
    [0.75, 94, 201, 98, 240],
    [1.0, 253, 231, 37, 255],
  ],
  // Diverging, for differences and ratios (t = 0.5 is neutral).
  diverging: [
    [0.0, 33, 102, 172, 255],
    [0.35, 146, 197, 222, 220],
    [0.5, 247, 247, 247, 60],
    [0.65, 244, 165, 130, 220],
    [1.0, 178, 24, 43, 255],
  ],
};

// Colour-vision-deficiency safe ramps (selected by the Accessibility menu). Lightness rises monotonically, so order
// survives red-green confusion; hue runs along the blue to yellow axis (cividis-like). The low end is a bright enough
// blue to stay visible over dark and green imagery; alpha rises like the fire ramp.
RAMPS.cvdFire = [
  [0.0, 30, 72, 150, 170],
  [0.2, 75, 83, 125, 200],
  [0.4, 112, 113, 115, 215],
  [0.6, 166, 157, 117, 230],
  [0.8, 228, 207, 91, 242],
  [1.0, 255, 248, 170, 255],
];
// Diverging blue - white - orange (t = 0.5 neutral), safe for the common colour confusions.
RAMPS.cvdDiverging = [
  [0.0, 24, 80, 160, 255],
  [0.35, 125, 175, 220, 220],
  [0.5, 247, 247, 247, 60],
  [0.65, 250, 195, 110, 220],
  [1.0, 190, 90, 0, 255],
];

export function lut(stops: Stop[]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 1;
    while (k < stops.length - 1 && stops[k][0] < t) k++;
    const a = stops[k - 1];
    const b = stops[k];
    const f = Math.min(1, Math.max(0, (t - a[0]) / (b[0] - a[0] || 1)));
    for (let c = 0; c < 4; c++) out[i * 4 + c] = a[c + 1] + (b[c + 1] - a[c + 1]) * f;
  }
  return out;
}

export function cssGradient(stops: Stop[]): string {
  return `linear-gradient(90deg, ${stops
    .map(([t, r, g, b, a]) => `rgba(${r},${g},${b},${(a / 255).toFixed(2)}) ${(t * 100).toFixed(0)}%`)
    .join(', ')})`;
}
