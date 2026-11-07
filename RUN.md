# Running Aftergrip

## Start

Needs Node 22 and Chrome. From the repo root:

```bash
cd web
npm install
npm run dev
```

Open http://localhost:5173 in Chrome. `npm install` also copies the MediaPipe WASM files into `web/public/mediapipe/wasm/` (git-ignored), so the app needs no CDN.

On a laptop with two GPUs, set Chrome to high performance (Windows Settings, System, Display, Graphics, add Chrome, High performance) before using the webcam.

## Input modes

Add `?input=` to the URL:

| URL | What drives the arm |
| --- | --- |
| http://localhost:5173/ | The webcam if the browser lists a camera, else the mouse. |
| http://localhost:5173/?input=webcam | Your hand on the webcam. A start screen says why the camera is wanted and warms up the hand model; press "Use camera" (or "Use mouse instead"). Pinch to grip. If the camera is missing or refused, the page says so and offers the mouse. |
| http://localhost:5173/?input=mouse | Mouse. Move to steer, W/S to reach, G to open or close the grip. Dragging orbits the camera. |
| http://localhost:5173/?input=synthetic | A scripted hand that picks up the cube by itself. Used by the tests. |

`?speed=N` runs N simulated seconds per wall second (0.1 to 8). For example `?input=synthetic&speed=3`. `?hands=2` makes the hand model look for two hands (default 1).

**Space stops the arm**: no command reaches it until you press Resume on screen; every joint and the jaw hold where they were.

## Keys

No key is needed to run the app. Optional keys go in `web/.env`, which git ignores. Copy `web/.env.example` to `web/.env` and fill in only the keys you have:

| Name | Service |
| --- | --- |
| `GEMINI_API_KEY` | Google Gemini |
| `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` | ElevenLabs |
| `VULTR_API_KEY` | Vultr (deploy only) |

Never commit `web/.env`. `git check-ignore -v web/.env` prints the rule that ignores it.

## Tests

From `web/`:

```bash
npm test                 # unit tests (Vitest)
npx playwright test      # browser tests on the installed Chrome
```

The browser tests start their own dev server on port 5199. Set `E2E_PORT` to use another port, for example to run two test sessions at once. They write screenshots and reports to `web/evidence/` (git-ignored). Set `EVIDENCE_DIR` to write them somewhere else.
