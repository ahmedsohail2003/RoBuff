# RoBuff feature inventory

Every feature in the app, the test that checks it, and the demo-video beat that shows it (times from the video plan in [slides/teleprompter.html](../slides/teleprompter.html)), or "not shown". Status as of 2026-11-07 19:45 EST, before the 21:30 feature freeze: "verified" means an independent re-run of the milestone's acceptance test passed; "built" means its own test passed and the re-check has not run yet; "in progress" means it is still being written. Everything here is a SIMULATION: there is no real robot.

## Hand to arm

| Feature | Status | Checked by | Shown at |
| --- | --- | --- | --- |
| Webcam hand tracking with the MediaPipe hand landmarker, on device | verified | `e2e/s3-hand.spec.ts` (fake camera, painted synthetic hand) | 0:00-0:12, and the camera preview throughout |
| Camera start screen that says why the camera is wanted, and warms the hand model up first | verified | `e2e/s3-hand.spec.ts` (c), (d) | not shown (seen before recording starts) |
| Mouse fallback when the camera is missing or refused | verified | `e2e/s3-hand.spec.ts` (d) | not shown |
| Pinch latch with hysteresis (close below 0.25, open above 0.38, 2 frames) | verified | `src/input/pinchLatch.test.ts` | 0:00-0:12 |
| One Euro smoothing of the hand points | verified | `src/input/oneEuro.test.ts` | not shown |
| Workspace clamp and the on-screen range line | verified | `src/control/handMapping.test.ts` | not shown |
| Hand lost: the arm holds its last pose and grip | verified | `src/input/handMapper.test.ts` | not shown |
| Scripted synthetic hand (tests only, never counted as a result) | verified | `e2e/s2-pick.spec.ts` | not shown |

## Arm and grip

| Feature | Status | Checked by | Shown at |
| --- | --- | --- | --- |
| Damped least squares IK on MuJoCo's Jacobian | verified | `src/control/ik.test.ts` | 0:00-0:12 |
| Friction-only grip (no weld, no parenting) | verified | `e2e/s2-pick.spec.ts`, `src/control/pickPhysics.test.ts` | 0:00-0:12 |

## Delay and ghost

| Feature | Status | Checked by | Shown at |
| --- | --- | --- | --- |
| Moon mode: commands and the view each delayed 1.28 s | verified | `src/delay/delayLine.test.ts`, `e2e/s6-delay-ghost.spec.ts` | 0:12-0:55 |
| Ghost arm: a second simulation that runs commands at once, with a rock it does not know | verified | `e2e/s6-delay-ghost.spec.ts` | 0:55-1:20 |
| Error meter between ghost and truth, in millimetres | verified | `src/delay/ghostError.test.ts` | 0:55-1:20 |
| Trial logger (CSV with a fixed column list), trial HUD and download | verified | `src/trials/logger.test.ts`, `src/trials/runner.test.ts` | not shown (used for the trials) |
| Gate scorer and results table, rule fixed before any data | verified | `scripts/trials-verdict.mjs`, `src/gate/gateRule.test.ts` | 2:10-2:28 (only once real trials exist) |

## Objects and the guardrail

| Feature | Status | Checked by | Shown at |
| --- | --- | --- | --- |
| Object requests by text or preset, with a ticking receipt | verified | `e2e/s5-objects.spec.ts` | 1:20-1:50 |
| Guardrail checks: mesh, hull, jaw direction, scale, mass, friction, grip height | verified | `src/objects/test/guardrail.test.ts` | 1:20-1:50 |
| Simulated lift test on a hidden copy of the world | verified | `src/sim/liftTester.test.ts`, `e2e/s5-objects.spec.ts` | 1:20-1:50 |
| Rescale with the numbers ("an asteroid the size of Texas") and refusals with numbers | verified | `e2e/s5-objects.spec.ts` | 1:20-1:50 |
| Gemini object specs under a JSON schema, through the local key server | live check passed (5 typed requests, all schema-valid) | key server routes test `server/test/routes.test.mjs`; live check run by hand | 1:20-1:50 |
| Offline keyword mock when no key is present, labelled on screen | verified | `src/objects/test/mock.test.ts`, `e2e/s7-voice-offline.spec.ts` | not shown |

## Gravity and scene

| Feature | Status | Checked by | Shown at |
| --- | --- | --- | --- |
| Gravity menu with sources: Earth, Mars, Moon, Bennu, orbit, written live into every simulation | verified | `e2e/s5-gravity.spec.ts`, `src/sim/gravity.test.ts` | 1:50-2:10 (Moon and Bennu); Mars and orbit not shown |
| Bennu escape readout ("That rock is gone.") | verified | `e2e/s5-gravity.spec.ts` | 1:50-2:10 |
| Low-gravity contact warning on the receipt | verified | `e2e/s5-gravity.spec.ts` | not shown |
| Dark sky, starfield, floor | verified | `e2e/s5-gravity.spec.ts` | throughout |
| SIMULATION label | verified | `e2e/s5-gravity.spec.ts` | throughout |

## Voice and safety

| Feature | Status | Checked by | Shown at |
| --- | --- | --- | --- |
| Hold V to talk, offline command grammar (stop, home, gravity, delay, ghost) | verified | `src/voice/grammar.test.ts`, `e2e/s7-voice-offline.spec.ts` | 1:20-1:50 (if the request is spoken) |
| Spoken receipts with captions, browser voice, labelled badges | verified | `e2e/s7-voice-offline.spec.ts` | 1:20-1:50 |
| ElevenLabs console voice | built and live with a key (live check 5 of 5 lines, first audio median 176 ms) | `server/test/routes.test.mjs` (no-key path) and the live check in the progress log | spoken lines in the demo |
| Key server: health, spec and speech routes, origin check, 30 requests a minute | verified | `server/test/*.mjs` | not shown |
| Space stop latch: every joint and the jaw hold; only Resume clears it | verified | `src/safety/latch.test.ts`, `e2e/s3-hand.spec.ts` (e), `e2e/s8-stop.spec.ts` | not shown |
| Two-open-hands stop gesture (`?hands=2`), experimental | verified on replayed synthetic hands; not yet tried on a real hand | `src/safety/stopGesture.test.ts`, `e2e/s8-stop.spec.ts` | not shown |

## Console

| Feature | Status | Checked by | Shown at |
| --- | --- | --- | --- |
| Mission console layout, the Sense, Understand, Act strip, first-run hint, reduced motion, keys G (gravity) and M (mode) | built | `e2e/s9-states.spec.ts`, `src/ui/loopStrip.test.ts` | throughout |

## Presentation

| Item | Checked by |
| --- | --- |
| Slides, printed PDF and teleprompter | `e2e/slides.spec.ts` |
| Pre-judging smoke test | `npm run smoke` (from `web/`) |
| Judging-table runbook | [docs/DEMO.md](DEMO.md) |

## Added at the end of the build (21:40-21:55, tested by their builder; no separate check yet)

| Feature | Status | Checked by |
| --- | --- | --- |
| Everyday object kinds (box, cylinder, sphere, cone) with a "Closest shape I can make" receipt line | built | `src/objects/test/everyday.test.ts`, `approximation.test.ts`; builder's live Gemini check (4 requests) |
| Hand gain 1.4, mouse gain 1.5, faster smoothing (0.08 s) | built | `src/control/gains.ts` and the builder's still-hand and step tests |
| Mouse: left click grips, right drag orbits, middle drag pans | built | builder's browser tests |
| Webcam direction pinned to the default view, `?flip=1` for mirrored cameras | built | builder's sign test on every axis |
| Delay modes put the 30 mm test rock back automatically | built | builder's browser test |
