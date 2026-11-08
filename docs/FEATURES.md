# RoBuff feature inventory

Every feature in the app, the test that checks it, and the demo-video beat that shows it (times from the video plan in [slides/teleprompter.html](../slides/teleprompter.html)), or "not shown". Status as of 2026-11-07 19:45 EST, before the 21:30 feature freeze: "verified" means an independent re-run of the milestone's acceptance test passed; "built" means its own test passed and the re-check has not run yet; "in progress" means it is still being written. Everything here is a SIMULATION: there is no real robot.

## Hand to arm

| Feature | Status | Checked by | Shown at |
| --- | --- | --- | --- |
| Webcam hand tracking with the MediaPipe hand landmarker, on device | verified | `e2e/s3-hand.spec.ts` (fake camera, painted synthetic hand) | 0:00-0:12, and the camera preview throughout |
| Camera start screen that says why the camera is wanted, and warms the hand model up first | verified | `e2e/s3-hand.spec.ts` (c), (d) | not shown (seen before recording starts) |
| Mouse fallback when the camera is missing or refused | verified | `e2e/s3-hand.spec.ts` (d) | not shown |
| Pinch latch with hysteresis (close below 0.25, open above 0.38, 2 frames) | verified | `src/input/pinchLatch.test.ts` | 0:00-0:12 |
| One Euro smoothing, a common filter for shaky tracking, of the palm position only (side to side, up and down, and depth), not of each hand point | verified | `src/input/oneEuro.test.ts` | not shown |
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
| Two-open-hands stop gesture (`?hands=2`), experimental | verified on replayed synthetic hands; a real-hand try has not been logged | `src/safety/stopGesture.test.ts`, `e2e/s8-stop.spec.ts` | not shown |

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

## Added after the freeze (2026-11-07 23:20 to 2026-11-08 00:29, independently re-checked)

| Feature | Status | Checked by | Shown at |
| --- | --- | --- | --- |
| Objects built from 3 to 8 coloured simple parts, one convex collision shape per part, in one MuJoCo body with several shapes; same guardrail and lift test | verified (00:24) | `src/objects/test/assembly.test.ts` and `src/sim/assemblyLift.test.ts` (compiled mass equals receipt mass, ratio 1.000000, for 4 of 4 test objects; AK-47 headless lift ADJUSTED, rose 77.5 mm, held 2.07 s); one final live Gemini run in the progress log, 5 of 5 scaled and lifted | not shown |
| Talk live: hands-free listening in Chrome, Gemini 3.8 Flash replies (at most 200 characters) spoken in the ElevenLabs voice, actions limited to spawn, gravity, mode, home and none; "stop" handled by the local grammar with no network | verified (00:29) | `src/voice/liveTalk.test.ts`, `server/test/routes.test.mjs` (`/api/chat` route), `e2e/live-talk.spec.ts`; one live run with a fake microphone in the progress log (reply 2850 ms, first audio 530 ms, 0 chat calls for "stop") | not shown |

## Added on 2026-11-08 (voice motion and skins, committed 04:24 EST)

Voice motion was independently re-checked at 03:54 EST, and two of its checks passed only on a second run. Skins were re-checked at 04:09 EST. The follow-up in `b70db06` and `c40ec1e` was re-checked at 04:59 EST. The voice browser-test numbers below come from the verifier's earlier browser run at 03:20 EST. "Builder-tested" means only the builder, a fixer or the integration run ran that check.

| Feature | Status | Checked by | Shown at |
| --- | --- | --- | --- |
| Voice moves by distance and direction ("move left 5 cm", "go up a bit"), screen-relative, on the same input path as the hand | verified (03:54) | `src/voice/grammar.test.ts` (63-phrase table, old 20-phrase table still passes), `src/input/voiceSource.test.ts` (5 cm move: target 50.00 mm, gripper 49.74 mm in 0.94 s), `e2e/voice-motion.spec.ts` (49.4 mm left, 0.3 mm across) | not shown |
| Voice grip, pick it up, put it down, go home and hand back to the hand | verified (03:54) | `src/control/armMacro.test.ts`, `src/control/voicePick.test.ts` (builder-tested numbers: cube 78.5 mm, AK-47 77.2 mm, both jaws), `src/input/voiceSource.test.ts`, `e2e/voice-motion.spec.ts` (cube rose 78.5 mm, both jaws) | not shown |
| Voice stop brakes the arm at once, and only Resume clears it | verified (03:54) | `src/input/voiceSource.test.ts` (at most 0.99 mm in 0.5 s), `e2e/voice-motion.spec.ts` (0.4 mm over about 0.5 s) | not shown |
| Voice moves delayed and ghosted in the Moon modes, picks refused there | verified (03:54) | `src/input/voiceSource.test.ts`, `e2e/voice-motion.spec.ts` (ghost +0.43 s, true arm +1.69 s) | not shown |
| Chat route actions for the arm and skins, at most 3 per answer, never stop or resume | verified (03:54) | `src/voice/liveTalk.test.ts`, `server/test/routes.test.mjs`, `e2e/voice-motion-live.spec.ts` (live run: Gemini 4591 ms, cube up 98 mm) | not shown |
| Skins from Nano Banana, Google's Gemini image models (`gemini-3.1-flash-lite-image` for Fast, `gemini-3-pro-image` for High quality), procedural patterns or your own image, on every part | verified (04:09) | `src/objects/test/skinUv.test.ts`, `src/objects/test/skinPattern.test.ts`, `src/render/skinBadge.test.ts` (the three files: 21 passed at the 04:09 re-check), and the verifier's live runs in the progress log (fresh Fast picture 3515 ms, every part 1024x1024) | not shown |
| Skin route with a disk cache and a daily cap (40 units at `96ac77a`, 100 units from `b70db06`) | verified (04:09, cap raise 04:59) | `server/test/skin.test.mjs`, `server/test/limits.test.mjs` (server tests 24 passed at 04:09, 27 passed in a fresh copy of `c40ec1e`), with cache hits 39.8 to 207.7 ms in the verifier's live runs | not shown |
| Paint by voice and by part ("paint the wheels black" changes only the four wheels), and an upload that makes no request | builder-tested | `e2e/skins.spec.ts` (run by the builder, both fixers and the integration run), and `src/objects/test/skinUv.test.ts` ("wheels" picks parts 2 to 5, verified) | not shown |
| High quality (Pro) drawing time, 12.1 to 12.9 s over three pictures | builder-tested | builder and fixer live runs in the progress log | not shown |
| High quality is the default. Cached skins say "(cached)". Skin text is cleaned before the cache key. The first material word sets the finish. Chat waits 20 s. A reset no longer leaves a false "already holding" (`b70db06`, `c40ec1e`). | verified (browser parts at 04:59, server parts in the fresh-copy test) | `server/test/skin.test.mjs`, `server/test/routes.test.mjs`, `src/render/skinBadge.test.ts`, `src/objects/test/skinPattern.test.ts`, `e2e/skins.spec.ts`, `e2e/voice-motion.spec.ts` (all passed again in a fresh copy of `c40ec1e`) | not shown |
