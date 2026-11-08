# How Robuff works

One page, one part per section. Every number below came from a test or a measurement run on this laptop on 2026-11-07 (Windows 11, headless Chrome, an RTX 4050 or the Intel Iris Xe where noted). Everything here is a SIMULATION: there is no real robot. Parts that are not built yet say so.

## Hand to arm

The webcam image goes to Google's MediaPipe hand landmarker, which runs in the browser on your own machine and returns 21 points on your hand. From those points the app reads a palm position and a pinch (thumb tip to index tip, divided by the palm size). Side to side and up and down in the image move the gripper sideways and up and down; how big your palm looks moves it nearer or farther. A One Euro filter smooths the points (in a test it cut the arm target's jitter from 5.39 mm to 1.80 mm), and the pinch closes the jaw below 0.25 and opens it above 0.38, only after 2 frames agree. Those two thresholds come from a sample photo, not from a real pinch, so they still need tuning on a real hand. The arm then solves damped least squares inverse kinematics on MuJoCo's own Jacobian (reachable test targets landed within 0.09 to 1.85 mm). In a fake-camera test, tracking took a median of 11 ms per frame (maximum 17.5 ms, 120 frames) on the RTX 4050, and found a hand in 123 of 123 frames; when Chrome picked the Intel Iris Xe instead, the median was 26.6 ms. The physics runs at 240 frames per second headless on the RTX 4050, with a median of 0.30 to 0.40 ms of physics per frame.

## Friction grip

Nothing glues the rock to the jaw: no weld, no parenting. The jaw closes on it, and it rises only if contact friction holds it. The arm's actuators and contact values are the public model's own (position servos with gain 50, a 3.5 N m limit, pad friction 1). A scripted pick of the 20 g test cube rose 78.2 mm, stayed held for 5.65 s with 0.054 mm of jaw penetration, and fell 0.25 s after the jaw opened. Five repeats from the same start all passed, which shows the run is deterministic, not that it is robust. Over 9 cube positions, 6 picks passed; the 3 that failed were 8 to 12 cm off the arm's centre line, because the jaw always points along the line from the base.

## Delay and ghost

Not built yet; this section describes the plan. Light takes 1.28 s each way between the Earth and the Moon (384,400 km, the mean distance in NASA's NSSDC Moon fact sheet, divided by the speed of light: 1.2822 s one way, 2.5644 s round trip). In Moon mode your commands will wait 1.28 s before they reach the arm, and the camera view will wait another 1.28 s before it reaches you. A second simulation, the ghost, will run your commands at once and draw a see-through arm. The ghost will hold a nominal rock (density 1.6 g/cm³, friction 0.8) while the true arm holds values the ghost does not know (2.3 g/cm³, friction 0.6), so the two can really disagree, and the gap between them will be shown in millimetres. No ghost result exists yet.

## Guardrail and lift test

When you ask for an object, a spec (kind, size, material) becomes a generated mesh, and a guardrail checks it in steps before it can appear: the mesh is sane, its convex hull, which way the jaw should face it, its scale, its mass, whether friction can hold it, and the grip height. The limits are measured on the simulated arm: the jaw opens 10 to 70 mm (15 to 55 mm for hand flying), it lifts up to 0.30 kg (200 g for hand flying), and it squeezes with about 50 N. A request that is too big is scaled down and the receipt says by how much; one that cannot work is refused with the numbers. Then a headless lift test runs the same arm on a second copy of the physics state, and only a rise of at least 48 mm at the end of the hold counts as a pass. In the browser test: the Bennu-like sample passed (rise 77.3 mm, held 2.02 s, both jaws touching); "an asteroid the size of Texas" was too wide as asked, so it was rescaled to a 55 mm model of 144 g, which then lifted 76.0 mm; "solid iron, 60 mm" was refused at 562 g; the comet ice shard was refused because the pads meet it 14 degrees off square and it needs friction 0.26 where ice has 0.03. Recompiling the scene with a new object took 211 to 259 ms in Chrome, and the lift test 399 to 551 ms. Today the specs come from an offline keyword parser in the browser, labelled "offline mock, no Gemini" on screen; no Gemini call is made.

## Gravity

The gravity menu writes a new value into every running simulation at once: Earth 9.82, Mars 3.73 and Moon 1.62 m/s² (NASA NSSDC fact sheets), Bennu 8.3e-5 m/s² (calculated from JPL's GM 4.8904 m³/s² and diameter 484.44 m, spin ignored), and orbit 0. A cube released 0.10 m above the floor touched it after 0.354 s on the Moon (theory 0.351 s) and 0.144 s on Earth (theory 0.143 s); on Bennu it was still 0.09896 m up after 5 s. On Bennu the screen shows the escape speed, about 0.20 m/s, and says "That rock is gone." once the rock is more than 1.5 m from the pad and moving faster than that. The sim's gravity is uniform, so this is a label, not a simulated escape. Contact at very low gravity is not trustworthy: a 5 cm/s sideways push lifted the resting cube 46.9 mm on Bennu, against 0.044 mm on the Moon and none on Earth, so the receipt carries a warning whenever gravity is below 0.1 m/s².

## Voice

Not built yet. The plan is hold-to-talk with the browser's speech recognition, a fixed offline grammar for commands (stop, home, gravity, delay, ghost), Gemini for object requests when a key is present, and ElevenLabs or the browser voice for spoken lines, with captions always on. No API key exists tonight, so the offline modes are what will ship first, labelled on screen.

## Safety

Space stops the arm. The stop latch then sends no new commands, so every joint and the jaw hold where they are and a held rock is not dropped; only the on-screen Resume button clears it. Its unit tests pass (2 of 2, run 2026-11-07 18:11 EST); its browser check is still pending. If the hand is lost, the arm holds the last palm position and grip; a returning hand must be seen for 2 frames, and the arm target cannot move faster than 0.25 m/s. A stop gesture (both hands open) is planned and not built.

## Prepared answers

### Is this new work? Haven't you built robot arms before?

Yes, I have built related projects: the WorkCell series, EmberHacks "The cell" (submitted to another event) and HandSignal. None of their code is here. Every line of application code in this repo was written during UB Hacking 2026, and the commit history starts after hacking opened. What carries over is what I learned, plus public libraries and the same public arm model (MuJoCo Menagerie's SO-ARM100), all listed in [THIRD_PARTY.md](THIRD_PARTY.md). EmberHacks was a robot cell you instruct by voice, with no physics; Robuff is your own hand reaching an arm through contact physics, light delay and low gravity.

### Your ghost is a simulation predicting a simulation. Of course it matches.

Right, and that is the biggest limit. If the ghost and the true arm shared one model the ghost would be exact, so the true arm holds rock mass and friction the ghost does not know, and the error between them is shown. That matches the literature: predictive displays have helped with reaching since the 1980s, and they break down at contact. We test one operator, in simulation only, and claim nothing about hardware.

### Real lunar arms will be autonomous. Why hand control?

Mostly they will. The Canadian Space Agency says Canadarm3 will do some tasks on its own, with people operating it when required. This is about the moments when people step in, and it is mainly a teaching tool: you cannot explain light delay as well as you can make someone feel it.

### What does the AI actually do?

A hand-pose model (MediaPipe's hand landmarker) reads your hand on your own machine; without it there is no hand control. The guardrail is plain rules and a simulated lift test, not AI. Object requests are meant to go to Gemini; tonight no key exists, so the offline keyword mock ships, and the screen says so. The physics and the ghost are not AI.

### How accurate is the physics? Can the arm really lift that?

Gravity values come from NASA and JPL data and the rock densities from published sample work, all listed in [THIRD_PARTY.md](THIRD_PARTY.md). Contact is not validated against anything real: at Bennu gravity MuJoCo shows artefacts (a 5 cm/s push lifted a cube 46.9 mm), regolith is not modelled, and Bennu's spin is ignored. The lift test uses the same simulated arm as the live scene, so "it can lift this" means the simulated arm can, not a real SO-ARM100.
