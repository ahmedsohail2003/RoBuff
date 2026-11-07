# objects

Generated deep-space objects, and the guardrail that decides whether the simulated arm should try to lift them. Pure TypeScript logic: no DOM, no rendering.

```ts
import loadMujoco from '@mujoco/mujoco';
import { validate, settle, withSettle, toMjcf, proveLift, specFromText } from './index';

const { spec, source } = specFromText('an asteroid the size of Texas'); // source: 'offline-mock'
let receipt = validate(spec, { gravity_m_s2: 9.82 });  // READY_FOR_LIFT_TEST or REFUSED, never PASS
const mj = await loadMujoco();
receipt = withSettle(receipt, settle(mj, receipt));     // ROLLS / SETTLED note, and the rest pose
const fragment = toMjcf(receipt);                       // <mesh> asset + free <body>
receipt = await proveLift(receipt, tester);             // PASS / ADJUSTED / REFUSED, aimed from the rest pose
```

In the app, `web/src/sim/objectRequest.ts` runs this end to end: the object is spawned in the
live scene (`sim/objectSlot.ts`), settled on the pad there, and the lift tester
(`sim/liftTester.ts`, a second `MjData` on the same compiled model) is the `LiftTester`.

| File | Job |
| --- | --- |
| `spec.ts` | `ObjectSpec`, the JSON schema for structured output, and clamping |
| `materials.ts` | Densities and friction, with sources |
| `limits.ts` | Every arm limit, with the measurement behind it |
| `generate/` | Seeded meshes: asteroid (642-vertex icosphere), panel, dish, bus, fragment |
| `hull.ts`, `geometry.ts` | Convex hull, volume, sanity checks, widths, cross-sections |
| `guardrail.ts`, `messages.ts`, `receipt.ts` | The cheap pipeline and its receipt lines |
| `mjcf.ts` | MJCF fragment with inline hull vertices, `maxhullvert="64"`, explicit mass |
| `settle.ts` | Drop on a plane in MuJoCo, report rest pose and roll; rest-pose helpers |
| `lift.ts` | `LiftTester` interface and `proveLift`, which aims from the rest pose when there is one |
| `mock.ts` | Offline keyword parser and five presets |

Units are metres, kilograms and seconds inside; receipts speak in millimetres and grams. Z is up. Every limit describes the simulated arm; a real arm's payload is unverified.

```sh
# from web/
npx tsc --noEmit
npx vitest run src/objects
node scripts/run-ts.mjs scripts/gallery.ts   # writes s4-gallery.json and s4-asteroid.obj to private/.autopilot/evidence
```

This folder was `packages/objects` until slice S5 moved it into the app, so it uses the app's
single `@mujoco/mujoco` install (one WASM copy).
