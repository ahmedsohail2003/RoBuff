# Third-party assets and libraries

All application code in this repository was written during the UB Hacking 2026 period. The items below existed before it.

## Robot model

| Item | Source | Pinned at | License |
| --- | --- | --- | --- |
| Standard Open Arm-100 5DOF MJCF model and STL meshes | [google-deepmind/mujoco_menagerie](https://github.com/google-deepmind/mujoco_menagerie/tree/98a70c569c4c1b6da467a20012f766ee1f8dc521/trs_so_arm100), folder `trs_so_arm100` | commit `98a70c569c4c1b6da467a20012f766ee1f8dc521` | Apache-2.0 (`web/public/models/so_arm100/LICENSE`) |

The Menagerie model is derived from the [SO-ARM100](https://github.com/TheRobotStudio/SO-ARM100) robot description by The Robot Studio.

Copied into `web/public/models/so_arm100/`: `LICENSE`, `README.md`, `CHANGELOG.md`, `scene.xml`, `so_arm100.xml`, and `assets/*.stl`. These files are unmodified. `so_arm100.png` was not copied.

Changes made by this project:

- `web/public/models/so_arm100/arena.xml` is our own scene file. It adds the floor, light and test cube, and includes `so_arm100.xml`.
- `web/src/sim/armXml.ts` inserts three `<site>` elements into the arm XML in memory when the model loads. The file on disk does not change.

## npm packages

Exact versions are pinned in `web/package.json` and `web/package-lock.json`.

| Package | Version | License | Used for |
| --- | --- | --- | --- |
| `@mujoco/mujoco` | 4.0.0 | Apache-2.0 | Physics engine, single-threaded WASM build |
| `@mediapipe/tasks-vision` | 1.2.2 | Apache-2.0 | Hand landmark detection (HandLandmarker) in the browser |
| `three` | 0.187.0 | MIT | Rendering |
| `vite` | 8.3.6 | MIT | Dev server and bundler (development only) |
| `vitest` | 5.1.0 | MIT | Unit tests (development only) |
| `@playwright/test` | 1.65.0 | Apache-2.0 | Browser tests (development only) |
| `typescript` | 7.0.2 | Apache-2.0 | Type checking (development only) |
| `@types/three` | 0.187.0 | MIT | Type declarations (development only) |
| `@types/node` | 22.20.5 | MIT | Type declarations (development only) |

## Hand tracking assets

| Item | Source | Pinned at | License |
| --- | --- | --- | --- |
| MediaPipe vision WASM (`vision_wasm_internal.js`, `vision_wasm_internal.wasm`) | npm `@mediapipe/tasks-vision`, folder `wasm/` | version 1.2.2 | Apache-2.0 (package license) |
| Hand landmarker model `hand_landmarker.task` (7,819,105 bytes) | https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task (the URL in the package README) | `float16/1`, SHA-256 `fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1`, downloaded 2026-11-07 | Apache License, Version 2.0 per the model card *Model Card Hand Tracking (Lite/Full) with Fairness*, Oct 2021, page 2 ("LICENSED UNDER Apache License, Version 2.0"), https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Hand%20Tracking%20(Lite_Full)%20with%20Fairness%20Oct%202021.pdf, retrieved 2026-11-07 |

- The WASM files are not committed. `web/scripts/vendor-mediapipe.mjs` copies them from the pinned npm package into `web/public/mediapipe/wasm/` (git-ignored) on `npm install`, `npm run dev`, `npm run build` and before the Playwright tests. The app loads them, and the model at `web/public/mediapipe/hand_landmarker.task`, from its own origin, so no CDN is needed and cross-origin isolation headers cannot block them.

## Test fixtures

| Item | Source | Retrieved | License |
| --- | --- | --- | --- |
| `web/e2e/fixtures/woman_hands.jpg` (640 x 960 JPEG, 67,719 bytes, SHA-256 `70cbeb38e198c9862202e0979c21a99b40ca980d3e7b250176c85b1636a40f12`) | MediaPipe's hand landmarker sample image, https://storage.googleapis.com/mediapipe-tasks/hand_landmarker/woman_hands.jpg (Last-Modified 2022-12-02) | 2026-11-07 | **Not stated at the URL.** It is the sample image Google serves for the MediaPipe hand landmarker. It looks like a stock photo; its original photographer and licence were not found. Used only by the browser test. Replace it with a photo of our own hand before publishing if the licence cannot be confirmed. |

- The fake-camera clip `web/e2e/fixtures/woman_hands_640x480.y4m` is generated from this photo by the test (cropped to rows 300-779) and is git-ignored.

## Generated objects (`web/src/objects`)

All code in `web/src/objects` (moved from `packages/objects`) was written during the UB Hacking 2026 period. It uses no code from earlier projects. Its convex hull, noise, generators and guardrail are new code; three.js is not used there. It uses the app's own `@mujoco/mujoco` 4.0.0 (listed above), so there is one WASM copy.

Numbers taken from outside sources. These are facts used as constants, not copied code.

| Value | Source |
| --- | --- |
| C-type sample density 1.6 g/cc, range 1.2-2.3 | Bennu returned-sample matrix density, JAMS 2025 abstract R5-13 (via the project's research notes) |
| S-type sample density 3.2 g/cc, range 2.2-3.4 | Itokawa sample 3.4 g/cc (Tsuchiyama 2011) and LL chondrites 3.15-3.4 (via arXiv 2104.06484) |
| Ice on steel friction 0.03; aluminium on mild steel 0.47 kinetic | Engineering ToolBox, "Friction - Coefficients for Common Materials and Surfaces" |
| Earth 9.82, Mars 3.73, Moon 1.62 m/s2 | NASA NSSDC planetary fact sheets |
| Bennu 8.3e-5 m/s2 | Calculated from JPL SBDB GM 4.8904 m3/s2 and diameter 484.44 m, spin ignored |
| Arm limits (jaw width, mass, clamp force, height) | Measured in MuJoCo 4.0.0 on the Menagerie `trs_so_arm100` model (Apache-2.0) by this project, 2026-11-07 |

Rock friction (0.6 C-type, 0.7 S-type) and iron friction (0.6) are design values, not looked-up measurements.

## Services, imagery and sources named in the docs

| Item | Status in this build | Terms and attribution |
| --- | --- | --- |
| Hand-pose model and MediaPipe WASM | Used, on device | Listed under "Hand tracking assets" above (Apache-2.0). |
| Google Gemini API (Gemini 3.8 Flash), for object specs | Not connected yet: no key exists and no code calls it. Object specs come from the offline keyword mock in `web/src/objects/mock.ts`. | Google's Gemini API terms apply once a key is used. A key would live only in `web/.env` (git-ignored), never in the browser. |
| ElevenLabs text to speech, for the console's spoken lines | Not connected yet: no key exists and no code calls it. | When it is used, the README, the on-screen voice badge and this file will credit ElevenLabs, whatever the plan's terms require. |
| NASA imagery | None used. The space backdrop is drawn by our code (`web/src/render/spaceScene.ts`). | Not applicable. |
| Test photo `web/e2e/fixtures/woman_hands.jpg` | Not replaced yet. It is git-ignored and not in this repository, so a fresh clone cannot run the photo and fake-camera cases of `e2e/s3-hand.spec.ts` until it is fetched or replaced with a photo we own. | Licence not stated (see "Test fixtures" above). |
| Facts quoted in `README.md` and `HOW_IT_WORKS.md` | Sources, all retrieved 2026-11-07: NASA NSSDC Moon fact sheet (mean distance 384,400 km); Louca et al. 2024, ACM THRI, doi:10.1145/3651993; Sheridan 1984, NTRS 19850006202; Richter et al. 2019, IEEE ICRA, arXiv 1809.08627; DLR's ROTEX history page; the Canadian Space Agency's Canadarm3 page. | Facts and short citations only; no text or images copied. |

## Test pictures (M1 update, 2026-11-07)

The browser tests no longer use any photograph. `web/e2e/s3-hand.spec.ts` paints the synthetic hand's 21 landmarks as a flat hand (`web/src/input/drawHand.ts`, our code) at test time, checks the hand model on that picture, and writes it frame by frame into the fake-camera clip `web/e2e/fixtures/synthetic_hand_640x480.y4m` (git-ignored, regenerated each run). A fresh clone runs every case without fetching anything. The MediaPipe sample photo `woman_hands.jpg` listed under "Test fixtures" and in the row above is no longer read by any test and is not in the repository; the rows about it stay only as history.
