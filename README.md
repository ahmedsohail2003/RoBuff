# Aftergrip

Pinch now, grip 2.56 seconds later. An entry for UB Hacking 2026 by Ahmed Sohail Butt (solo).

**SIMULATION.** Everything you see is a physics simulation running in your browser. There is no real robot, and the screen says so at all times.

## What it does

Aftergrip is a browser testbed where your bare hand, seen by a laptop webcam, drives a physics-simulated SO-ARM100 robot arm that picks things up by friction alone. You can ask for an object, such as an asteroid sample or a satellite part, and a guardrail checks it against the arm's measured limits and a simulated lift test before it appears; a gravity menu switches the scene between Earth, Mars, the Moon, the asteroid Bennu and orbit. The next layer, still being built, sends your commands through the true Earth-Moon light delay of 2.56 s, with a predictive "ghost" arm that does not know the rock's true mass.

How each part works, with its measured numbers: [HOW_IT_WORKS.md](HOW_IT_WORKS.md).

## Try it

Needs Node 22 and Google Chrome.

```bash
cd web
npm install
npm run dev
```

Then open `http://localhost:5173/?input=webcam` and allow the camera. Without a camera, open `http://localhost:5173/?input=mouse`. The camera only works on `localhost` or over HTTPS. The first hand detection can take about 10 s while the model warms up.

Tests, from `web/`:

```bash
npm test               # unit tests (Vitest)
npx playwright test    # browser tests
```

The browser tests use the installed Google Chrome (Playwright runs with `channel: 'chrome'`), start their own dev server on port 5199 (set `E2E_PORT` to change it) and write screenshots to `web/evidence/` (git-ignored). The photo and fake-camera cases in `e2e/s3-hand.spec.ts` need a sample photo that is not in this repo; see [THIRD_PARTY.md](THIRD_PARTY.md). More detail on running: [RUN.md](RUN.md).

## Modes and keys

| URL or control | What it does |
| --- | --- |
| `?input=webcam` | Your hand drives the arm. Pinch to close the jaw, open to release. With no `?input`, the app starts on the webcam if a camera exists, else on the mouse. If the camera is refused, the page says so and offers the mouse. |
| `?input=mouse` | Move the mouse to steer, W and S to reach nearer or farther, G to open or close the jaw. Dragging orbits the camera. |
| `?input=synthetic` | A scripted hand picks up the cube by itself. Used by the tests; never counted as a result. |
| `?speed=N` | Runs N simulated seconds per wall second (0.1 to 8). |
| `?hands=2` | Tracks two hands instead of one. |
| Space | Stops the arm: every joint and the jaw hold. Only the on-screen Resume button clears it. |
| Gravity menu (bottom left) | Earth, Mars, Moon, Bennu, orbit, each with its source. |
| Object panel (top right) | Type a request or pick a preset; the receipt shows every check. |

No API key is needed. `web/.env.example` lists the optional key names (Gemini, ElevenLabs, Vultr). No code reads them yet: the object brain is an offline keyword mock, labelled on screen.

## Real / simulated / mocked / unfinished

| Part | Status | What that means |
| --- | --- | --- |
| Your hand | Real | Live webcam frames, read by a public hand-pose model on your own machine. |
| Robot arm | Simulated | MuJoCo physics on the public MuJoCo Menagerie SO-ARM100 model. No real robot is connected. |
| Grip and contact | Simulated | Friction contact in MuJoCo. Not validated against any real arm. Unreliable at very low gravity (see Limits). |
| Gravity values | Real data, simulated effect | Earth, Mars and Moon from NASA's fact sheets; Bennu calculated from JPL data with spin ignored; orbit set to 0. |
| Generated objects | Simulated | Procedural meshes made in the browser. Densities from published sample data; rock and iron friction are design values. |
| Object requests | Mocked | An offline keyword parser in the browser, labelled "offline mock, no Gemini". No Gemini call is made. |
| Lift test | Simulated | A headless pick on a second copy of the same simulated arm. |
| Mouse and synthetic hand | Simulated input | Labelled on screen; never counted in results. |
| Earth-Moon delay and ghost arm | Unfinished | Being built. Not in the app yet. |
| Trial logger and results | Unfinished | Being built. No trials logged. |
| Voice | Unfinished | Not built. |
| Stop gesture | Unfinished | Not built. The Space key stop works. |
| Hand control feel | Untested | Tested with a scripted hand and a fake camera, not yet with a real hand on a webcam. |

## Results

Not run. The ghost test is one operator's logged grabs with the ghost on and off at 2.56 s delay, with its pass rule written down before any data. It has not run yet: ghost benefit: not tested (0 logged trials). The numbers that are measured so far are engineering checks (tracking time, pick height, lift tests, gravity drops), listed in [HOW_IT_WORKS.md](HOW_IT_WORKS.md).

## Limits

The ghost test will have one operator, who built the system and knows the task, so learning and expectation can favour either condition and the result will not generalise to other people. The ghost and the true arm will run the same physics engine and arm model, so the only prediction error will be the mass and friction mismatch we chose, which is far smaller and simpler than the calibration, model and contact errors that real predictive displays face. There is no hardware, network jitter or video compression: the delay will be a constant 2.56 s, so the numbers describe this interface in simulation and nothing about any flight system.

Other limits, all measured: at Bennu gravity a 5 cm/s sideways push lifted the resting cube 46.9 mm, which is a solver artefact, not real physics; scripted picks failed at 3 of 9 cube positions, all 8 to 12 cm off the arm's centre line; the pinch thresholds come from a sample photo, not a real pinch.

No camera frames leave the laptop: hand tracking runs on device; Gemini receives only the typed or transcribed request text. Today not even that is sent, because the object brain is the offline mock.

## Who this is for

Designed for students and science-centre visitors who want to feel why space robotics is hard, using only a laptop webcam. Nobody has used it yet, and no users are implied. Light takes 2.56 s to go from the Earth to the Moon and back (mean distance 384,400 km, [NASA NSSDC Moon fact sheet](https://nssdc.gsfc.nasa.gov/planetary/factsheet/moonfact.html), retrieved 2026-11-07). A 2024 University of Bristol study of a robot arm run at delays up to 2.6 s found that performance got worse on every measure the authors recorded ([Louca et al., ACM Transactions on Human-Robot Interaction](https://doi.org/10.1145/3651993), abstract retrieved 2026-11-07).

Also for anyone who wants to try a delay-display experiment without a robot or a lab. Predictive displays have cut completion times for free motion at 1 to 3 s delays ([Sheridan 1984, NTRS 19850006202](https://ntrs.nasa.gov/citations/19850006202); [Richter et al. 2019, IEEE ICRA](https://arxiv.org/abs/1809.08627), 49.2 s with the display against 60.6 s without at 1 s; both retrieved 2026-11-07), and DLR flew one on the ROTEX arm in 1993 at a 5 to 7 s delay ([DLR](https://www.dlr.de/en/rm/research/robotic-systems/history/rotex-1988-1993), retrieved 2026-11-07). Those studies are small (most had 4 to 20 people) and each needed a robot. Aftergrip is not new in idea: predictive displays date from the 1980s JPL and MIT work. It is uncommon at hackathons: in a keyword scan of 755 saved UB Hacking entries we found none that put an arm in a physics simulation, checked generated objects for pickup, or modelled light delay (full text for Fall 2025, titles and taglines for older editions, so the scan can miss entries). Hand tracking is common there, and Aftergrip does not claim it as new.

It is not operator training, it does not model Canadarm3 or any flight system, and the ghost does not solve delay.

## Provenance and disclosure

### Built during UB Hacking 2026

Every line of application code in this repository: the app in `web/src`, its tests, its scripts, and these docs. The repository's first commit is at 1:43 PM EST on November 7, 2026, after hacking opened at 1:30 PM; the commit history shows the rest.

New for the author this weekend: [AHMED fills in, for example running a contact-physics engine in the browser, or predictive displays]

### Existed before

- The robot model: MuJoCo Menagerie's SO-ARM100 (`trs_so_arm100`, Apache-2.0), itself derived from The Robot Studio's SO-ARM100.
- Libraries: MuJoCo 4.0.0 (WASM), MediaPipe Tasks Vision, three.js, Vite, Vitest, Playwright, TypeScript.
- The public MediaPipe hand landmarker model.
- Data: NASA NSSDC gravity and distance values, JPL's Bennu values, published asteroid sample densities, and Engineering ToolBox friction values.

Versions, sources and licences for all of these are in [THIRD_PARTY.md](THIRD_PARTY.md).

### Related earlier projects by the same author

These are different projects, and no code from them is reused here. During planning, their repositories were read for facts only (arm limits, package names, what overlapped), never copied.

- WorkCell series: simulated SO-ARM100 robot-learning projects.
- EmberHacks "The cell": a voice-instructed simulated robot cell with Gemini, kinematic only (no physics), submitted to another event.
- HandSignal: hand-gesture safety signals with MediaPipe.
- FleetLine: a console for a simulated robot fleet.

What they share with Aftergrip: the same public arm model (WorkCell and EmberHacks), the same hand-tracking library (HandSignal and EmberHacks), and the author's experience.

### AI tools used and how

- Anthropic's Claude, through Claude Code (the Fable and Opus models), planned the build, summarised research, and wrote and tested code and drafts under Ahmed's direction and review.
- Gemini 3.8 Flash is meant to turn object requests into specs inside the product. It is not connected yet; the offline mock runs instead.
- ElevenLabs is meant to speak the console's lines. Not connected yet.
- The MediaPipe hand landmarker reads your hand, on device.

### Simulated and mocked data

- Both arms, the gravity, the contact and (once built) the light delay are simulated.
- Object specs come from the offline keyword mock when no Gemini key is present, which is always, so far.
- The voice will use the browser's voice or cached lines when no ElevenLabs key is present.
- The tests use a scripted synthetic hand and a fake camera made from a still photo.

## Credits

Libraries, models, data and their licences: [THIRD_PARTY.md](THIRD_PARTY.md).

## License

Apache-2.0, see [LICENSE](LICENSE). The arm model folder keeps its own Apache-2.0 notice.

## Private files

This repository is public, including its commit history. Git ignores the locations below, so files in them are never committed or pushed:

| Location | Examples |
| --- | --- |
| Any folder named `private`, at any depth | `private/notes.md`, `src/private/data.csv` |
| Any file with `.private.` in its name | `pitch.private.md` |
| `.env` and `.env.*`, except `.env.example` | `.env`, `.env.local` |

Everything else can be committed and published.

This repo does not back up or share private files. The top-level `private/` folder is backed up separately to a private repo. Other private files exist only on the computer that holds them.

To check a file before you commit it, run this command. If it prints a matching rule, the file is private. If it prints nothing, the file can be published.

```bash
git check-ignore -v path/to/file
```
