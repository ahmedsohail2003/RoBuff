# Demo runbook (judging table)

How to run RoBuff for a judge: 2 minutes of setup, 3 minutes of demo, 2 minutes of questions. Everything shown is a SIMULATION: there is no real robot.

## Before leaving

From the repo root:

```bash
cd web
npm run smoke                  # build, unit tests, the scripted pick, vendored files; ends with SMOKE OK
npm run build && npm run preview
```

`npm run preview` serves the built app at `http://localhost:4173`. The arm model, the physics engine's WASM and the hand model are all served from the app itself, so the demo needs no network. Only two things use the network, and both fall back on their own: browser speech recognition (type instead) and the optional key server for Gemini and ElevenLabs (`node server/index.mjs`, keys in the git-ignored `web/.env`; without it the offline mock and the browser voice run, labelled on screen).

Also: charge the laptop, set Chrome to high performance (Windows Settings, System, Display, Graphics), test the webcam in the room light you expect, and have a phone hotspot ready.

## At the table, before the judge arrives (2 minutes)

1. Open `http://localhost:4173/?input=webcam&hands=2` in Chrome and allow the camera.
2. Wait for "tracking warm". The first detection can take about 10 s cold.
3. Check the tracking time on screen is under 50 ms. If not, use `?input=webcam&hands=1` (the two-hands stop gesture is then off; Space still stops).
4. Do one Direct pick, then leave the app in Direct mode.

## The 3 minutes

| Beat | Do | Say (short) |
| --- | --- | --- |
| It works | Direct mode: move, pinch, lift a rock by friction. | "A simulated arm; my hand drives it; it grips by friction, so it can slip." |
| The problem | Switch to Moon. Pinch, and wait out the 2.56 s. | "Light takes 2.56 s to the Moon and back. That's physics, not bandwidth." |
| Ghost | Ghost off, then on: the see-through arm answers at once. | "The ghost is a second simulation that answers now. It doesn't know the rock's true mass." |
| Objects | Type "an asteroid the size of Texas". | "Gemini proposes; code decides. It refuses with numbers, then rescales." |
| Gravity | Bennu, then flick the rock. | "Above Bennu's escape speed the screen says it's gone. Values from NASA and JPL." |
| Results | The results panel or README. | Only logged numbers, or "not yet measured". |
| Close | Disclosure. | "Built this weekend; every simulated and mocked part is labelled." |

If time allows, hand the judge the hand: "try a pick".

## Fallbacks

| Problem | Do |
| --- | --- |
| Camera refused, or no hand found for 10 s | Open `?input=mouse` and say so. |
| Tracking over 50 ms | Use `?hands=1`. |
| The page crashes or hangs | Reload (the model files are local). |
| No network, or the voice service is blocked | The offline grammar, the browser voice and captions keep working; type requests instead of speaking. |
| Everything else fails | Play the demo video from the laptop. |

## Questions

Prepared answers (new work, "a simulation predicting a simulation", autonomy, what the AI does, how accurate the physics is) are in [HOW_IT_WORKS.md](../HOW_IT_WORKS.md#prepared-answers). Every feature and its test: [FEATURES.md](FEATURES.md).
