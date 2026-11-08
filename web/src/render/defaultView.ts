/** The view the page opens with (world metres, z up). Kept apart from viewport.ts so tests can check screen directions without WebGL. */
export const DEFAULT_VIEW = { fovDeg: 45, position: [0.42, -0.62, 0.36], target: [0, -0.12, 0.1] } as const;
