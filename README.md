# RoBuff

RoBuff is a browser app, built solo by Ahmed Sohail Butt for UB Hacking 2026, in which your bare hand, seen by a laptop webcam, drives a simulated robot arm that must pick up rocks by friction alone, under Earth, Moon or asteroid gravity. In Moon mode every command and every picture travels through the Earth-Moon light delay, 2.56 s round trip, while a see-through "ghost" arm shows at once what your hand is asking for and an error meter shows where that prediction is wrong. **SIMULATION:** there is no real robot; the arm, the rocks and the delay are all simulated in your browser, and the screen says so at all times. The arm, the delay and ghost, the object checks (including objects built from 3 to 8 coloured simple parts), the gravity and the voice (including a hands-free Talk live mode in Chrome) are built and pass their automated tests, but whether the ghost helps a person grab under delay is not yet measured (0 logged trials).

## What it does

### The problem

When a person on Earth drives a robot arm on or near the Moon, each command takes 1.28 s to arrive and the picture of what happened takes 1.28 s to come back. Close the gripper and you see the result 2.56 s later. Operators then fall back on "move and wait": move a little, stop, and wait for the picture to catch up, which Ferrell saw in his 1965 MIT study and Louca et al. at the University of Bristol saw again in 2024, when a robot arm run at delays up to 2.6 s did worse on every measure the authors recorded ([ACM Transactions on Human-Robot Interaction](https://doi.org/10.1145/3651993), abstract retrieved 2026-11-07). A known remedy, from 1980s NASA JPL and MIT work, is a predictive display: draw the arm where it is about to be, before the delayed picture arrives. Trying one normally takes a robot and a lab. I wanted to know whether it could be tried with only a laptop and a webcam.

### What I built

A late grip only matters if it can miss, so the arm had to really grip rather than snap the rock to the jaw. It runs in MuJoCo, a physics engine made for robotics that simulates contact and friction, compiled to WebAssembly, a format that lets compiled code run inside a web page, so the whole simulation runs in the browser with nothing to install. The arm is the SO-ARM100, a low-cost open-source desktop robot arm, loaded from MuJoCo Menagerie, Google DeepMind's collection of ready-made robot models, so its sizes, motors and contact settings are the published ones rather than values I picked. Nothing glues the rock to the jaw: it rises only if friction holds it.

Your hand drives it through MediaPipe, Google's hand-tracking library, which finds 21 points on your hand in each webcam frame on your own machine, so no video leaves the laptop. The app turns your palm position into a target for the gripper and the gap between thumb and index finger into the grip. Inverse kinematics, the calculation that finds the joint angles that put the gripper on a target point, then moves the arm. three.js, a 3D graphics library for the web, draws the scene.

For the delay, Moon mode holds each command for 1.28 s before the simulated arm receives it, and holds the picture of that arm for another 1.28 s. The ghost is a second MuJoCo simulation of the same arm that gets your commands at once and is drawn see-through. A ghost that shared every value with the true arm would always be right, so it is given the wrong rock: 43.2 g with friction 0.8, where the true rock is 62.1 g with friction 0.6. The error meter shows how far apart the two are.

You can also type or say a request such as "a comet ice shard". Gemini 3.8 Flash, Google's large language model, turns the sentence into a spec with fixed fields (kind, size, material), because requests are free text that no keyword list covers. Gemini only proposes. A guardrail written in plain code checks the spec against limits measured on the simulated arm (jaw 10 to 70 mm, at most 0.30 kg), and a lift test runs a hidden pick on a second copy of the simulation; only an object that rose at least 48 mm appears. Without a Gemini key, an offline keyword parser answers instead, labelled on screen. A gravity menu sets Earth, Mars, Moon, the asteroid Bennu or orbit, with values from NASA and JPL data. Hold V to speak commands; replies are spoken by ElevenLabs, a text-to-speech service, used because it starts speaking quickly enough for a live console, or by the browser's own voice when no key is set.

A single shape makes a poor plane or mug, so recognisable things are built from parts. Gemini is asked for 3 to 8 coloured simple shapes (boxes, cylinders, spheres, cones) at real size, and the guardrail scales the whole object down to fit the jaw. Each part gets its own convex collision shape, the tightest dent-free outline around it, which is the form MuJoCo can test for contact quickly; the fingers therefore meet the parts, not one box around the whole object. The parts make one body with several collision shapes in the physics model, its mass is the sum of the parts, and it must pass the same hidden lift test before it appears. The results are toy-size models made of simple parts, not detailed copies, and because Gemini writes a new spec each time, the parts and sizes change from run to run.

Holding a key to talk gets in the way while your hand drives the arm. So the console also has a Talk live button. Press it once and Chrome's speech recognition keeps listening until you press it again. It pauses while RoBuff speaks. Commands the offline grammar knows (stop, gravity names, home) are handled in the browser. Anything else goes through the key server to Gemini 3.8 Flash. It replies in at most 200 characters. It can choose up to 3 actions from a fixed list. Examples are move the arm, pick up, spawn an object, set gravity or paint a skin. A spawn still goes through the guardrail and the lift test. Replies are spoken in the ElevenLabs voice. Once Chrome has turned "stop" into text, the local grammar handles it with no chat call. The arm holds, and RoBuff says "Stopped. The arm holds where it is. Press Resume on screen to go on."

You can also move the arm by voice with phrases such as "move left 5 cm", "pick it up" and "stop". Voice uses the same control path as the hand. Any object can wear a skin drawn by Nano Banana (Google's Gemini image models), a pattern drawn in the browser, or your own image.

To test it, Vitest, a test runner for JavaScript and TypeScript, runs the unit tests in Node against the same MuJoCo WebAssembly build the browser uses. Playwright, a tool that drives a real Chrome browser from a script, runs the browser tests with a scripted hand and a fake camera made from that hand.

### What the tests showed

- Unit tests: 201 of 201 passed in the last independent check (31 files, 2026-11-07 20:03 EST); the builder's own later run, after the end-of-build control changes, passed 226 in 36 files, not yet re-checked.
- Grip: a scripted pick lifted the 20 g test cube 78.2 mm, held it 5.65 s, and the cube fell 0.25 s after the jaw opened. Five of 5 repeats from the same start passed, which shows the run is deterministic, not that it is robust; across 9 cube positions, 6 of 9 picks passed, and the 3 failures were all 8 to 12 cm off the arm's centre line.
- Hand tracking: in the fake-camera test MediaPipe found a hand in 123 of 123 frames, at a median of 11 ms per frame on an RTX 4050 laptop GPU. Inverse kinematics put the gripper within 0.09 to 1.85 mm of every reachable test target.
- Delay and ghost: a command sent at 1.00 s reached the true arm at 2.29 s (1.28 s plus one 10 ms control step). With identical settings the ghost and the true arm stayed within 0.2 mm over a 10 s pick; with the hidden rock mismatch, the rock error reached 1.19 mm during the grasp.
- Objects: the Bennu-like sample passed (rose 77.3 mm); "an asteroid the size of Texas" was rescaled to a 55 mm, 144 g model that rose 76.0 mm; "solid iron, 60 mm" was refused at 562 g; the comet ice shard was refused because it needs friction 0.26 and ice has 0.03.
- Gravity: a cube dropped 0.10 m touched the floor after 0.354 s on the Moon (theory 0.351 s) and 0.144 s on Earth (theory 0.143 s).
- Live services on 2026-11-07: Gemini returned 5 of 5 valid specs, median 3.9 s end to end; ElevenLabs returned audio for 5 of 5 lines, first audio median 176 ms.
- Stop gesture: both hands open latched the stop at 0.40 s, and a 601-frame pinch-and-carry replay never set it off.
- Objects from parts, unit tests: for 4 of 4 test objects the mass MuJoCo compiled equalled the receipt mass (ratio 1.000000): AK-47 (5 parts, 39.2480 g), car (6, 196.0000 g), plane (4, 13.6024 g), mug (2, 196.0000 g). The AK-47 was scaled to fit (ADJUSTED) and in the headless lift test rose 77.5 mm with the jaw turned to 165 degrees, held 2.07 s with both jaws touching.
- Objects from parts, live Gemini: in one final live run (2026-11-08 00:23), 5 of 5 requests were scaled to fit (ADJUSTED) and lifted (table below). Earlier live runs at 23:48 and 00:10 also lifted 5 of 5, with different part counts and sizes, because Gemini writes a new spec each time.
- Talk live, one live run with the real key server and a fake microphone (2026-11-08): a question about Moon gravity got a Gemini reply in 2850 ms in the browser (2841 ms at Gemini) that quoted 1.62 m/s², with the first ElevenLabs audio 530 ms after it; "make me a tennis ball" was refused at 67 mm (234 g, over the 200 g limit), and the follow-up request at 52 mm passed at 195.9 g. "Switch to Mars" and "stop" went to the local grammar with 0 chat calls, and after "stop" the arm's commands did not change over 0.5 simulated s; in an earlier live run their spoken replies started after 183 ms and 473 ms. Another run in the same round failed its check because the lift test dropped the follow-up ball at one random seed; it is reported as is.
- Not measured yet: whether the ghost makes a person faster (0 logged trials), and how the control feels with a real hand on a webcam.

Final live parts run, 2026-11-08 00:23 (all five scaled to fit, all lifted):

| Request | Parts | Size (mm) | Mass (g) | Rise (mm) |
| --- | --- | --- | --- | --- |
| AK-47 | 7 | 149.8 x 38.4 x 9.4 | 42.53 | 76.3 |
| a plane | 7 | 66.1 x 64.3 x 22.7 | 10.45 | 78.3 |
| a Tesla | 6 | 106.2 x 43.8 x 27.1 | 196 | 75.8 |
| a coffee mug | 5 | 52.9 x 41.7 x 48.3 | 196 | 69.2 |
| Minecraft grass block | 5 | 40.3 x 39.9 x 39.4 | 196 | 74.3 |

How each part works, with all its measured numbers: [HOW_IT_WORKS.md](HOW_IT_WORKS.md).

## Try it

Needs Node 22 and Google Chrome.

```bash
cd web
npm install
npm run dev
```

`npm run dev` starts Vite, a development server that builds and serves the app. Then open `http://localhost:5173/?input=webcam` and allow the camera. Without a camera, open `http://localhost:5173/?input=mouse`. The camera only works on `localhost` or over HTTPS. The first hand detection can take about 10 s while the model warms up.

Tests, from `web/`:

```bash
npm test               # unit tests (Vitest)
npx playwright test    # browser tests
```

The browser tests use the installed Google Chrome (Playwright runs with `channel: 'chrome'`), start their own dev server on port 5199 (set `E2E_PORT` to change it) and write screenshots to `web/evidence/` (git-ignored). No photo or download is needed: the hand-model and fake-camera cases in `e2e/s3-hand.spec.ts` paint the scripted hand's 21 points at test time (see [THIRD_PARTY.md](THIRD_PARTY.md)). More detail on running: [RUN.md](RUN.md).

## Modes and keys

| URL or control | What it does |
| --- | --- |
| `?input=webcam` | Your hand drives the arm. Pinch to close the jaw, open to release. With no `?input`, the app starts on the webcam if a camera exists, else on the mouse. If the camera is refused, the page says so and offers the mouse. Your right hand moves the arm to screen right; add `?flip=1` if your camera already mirrors its picture. The hand gain is 1.4, so about 70% of the earlier hand travel covers the same arm range, and a line on screen shows the range. |
| `?input=mouse` | Move the mouse to steer, W and S to reach nearer or farther, left click (or G) to close or open the jaw. Right drag orbits the camera. |
| `?input=synthetic` | A scripted hand picks up the cube by itself. Used by the tests; never counted as a result. |
| `?speed=N` | Runs N simulated seconds per wall second (0.1 to 8). |
| `?hands=2` | Tracks two hands instead of one, which turns on the stop gesture (both hands open, fingers spread, held 0.4 s). |
| Mode buttons, or M | Direct (no delay), Moon with the ghost off, Moon with the ghost on. Switching resets the scene; the delay modes put the 30 mm test rock back by themselves if an object was in the slot. |
| `?trial=1` | Trial mode: the app sets the order, counts down, times each grab and offers the results as CSV. |
| V (hold), or the Hold to talk button | Voice commands, such as "stop", "Moon" or "give me a comet ice shard". The text box does the same. |
| Talk live button (click or Enter) | Hands-free talk in Chrome: RoBuff listens until you press it again and pauses while it speaks. Known commands stay offline; other lines go to Gemini 3.8 Flash and are answered aloud. Browsers without speech recognition show "Talk live (not in this browser)" and a note to type instead. |
| Moving the arm by voice (hold V, Talk live or the text box) | Say a move such as "move left 5 cm", "go up a bit" or "move toward me 3 cm". Left and right are screen left and right. Up and down are straight up and down. Forward and back are away from and toward the arm's base. Toward me and away from me follow the camera along the floor. With no amount a move is 5 cm, "a bit" is 2 cm and "a lot" is 10 cm. The most is 30 cm at a time. "Open", "close", "pick it up", "put it down", "go home" and "stop" work too. Say "give it back", or press Give the arm back to the hand, to return control to your hand. Control comes back only when the camera sees your hand or the mouse moves. Picks and put-downs work only in Direct mode. |
| Skin box (under the object receipt) | Type a look such as "brushed gold" and press Paint, or pick a preset. Choose all parts or one part. Choose High quality (Nano Banana Pro, the default) or Fast (Nano Banana 2 Lite). Upload image takes a PNG, JPEG or WebP up to 15 MB. Remove skin takes it off. By voice, say "paint it gold" or "paint the wheels black". |
| G | Cycles gravity, except with the mouse as input, where G is the grip key (use the gravity menu then). |
| Space | Stops the arm: every joint and the jaw hold. Only the on-screen Resume button clears it. |
| Gravity menu (bottom left) | Earth, Mars, Moon, Bennu, orbit, each with its source. |
| Object panel (top right) | Type a request or pick a preset; the receipt shows every check. |

No API key is needed to run it. With a Gemini key in `web/.env` (names in `web/.env.example`), start the small key server with `node server/index.mjs` and object requests go to Gemini 3.8 Flash; without it, an offline keyword mock answers instead. A badge on screen always says which one answered. The key stays in that server and never reaches the browser.

## Real / simulated / mocked / unfinished

| Part | Status | What that means |
| --- | --- | --- |
| Your hand | Real | Live webcam frames, read by a public hand-pose model on your own machine. |
| Robot arm | Simulated | MuJoCo physics on the public MuJoCo Menagerie SO-ARM100 model. No real robot is connected. |
| Grip and contact | Simulated | Friction contact in MuJoCo. Not validated against any real arm. Unreliable at very low gravity (see Limits). |
| Gravity values | Real data, simulated effect | Earth, Mars and Moon from NASA's fact sheets; Bennu calculated from JPL data with spin ignored; orbit set to 0. |
| Generated objects | Simulated | Procedural meshes made in the browser: space things (asteroid, panel, dish, bus, fragment), everyday things (box, cylinder, sphere, cone), and recognisable things built from 3 to 8 coloured simple parts at toy size, one convex collision shape per part. When a request is a stand-in, the receipt says "Closest shape I can make". Parts objects pass the same lift test (5 of 5 in one final live run); Gemini writes a new spec each time, so parts and sizes vary between runs. Densities from published sample data; rock and iron friction are design values. |
| Object requests | Real AI when a key is set, else mocked | Gemini 3.8 Flash turns the request into a spec under a fixed schema (live check on 2026-11-07: 5 of 5 valid specs, median 3.9 s). Without a key, an offline keyword parser answers, labelled "offline mock". Everyday requests get the closest shape: in the builder's live check before parts were added, "Minecraft grass block" became a green box and "Tesla" a red car-shaped box (3.1 to 5.0 s per request), both then rescaled by the guardrail. Either way, code decides what may spawn. |
| Lift test | Simulated | A headless pick on a second copy of the same simulated arm. |
| Mouse and synthetic hand | Simulated input | Labelled on screen; never counted in results. |
| Earth-Moon delay and ghost arm | Simulated | Built and checked in unit and browser tests. The delay is a constant, modelled 1.28 s each way; the ghost and the true arm are two MuJoCo simulations of the same arm. |
| Trial logger and results | Built, not yet run | The logger and the scoring scripts work on synthetic test data, which is never counted. No real trials have been logged. |
| Voice | Real when keys are set; offline otherwise | Hold-to-talk with the browser's speech recognition and an offline command grammar. Spoken replies use ElevenLabs (`eleven_flash_v2_5`) through the local key server when its key is set: in the live check on 2026-11-07, 5 of 5 lines returned audio with no errors, first audio median 176 ms. Without a key the browser's own voice speaks, labelled offline. Captions always. Talk live (hands-free, Chrome only) sends lines the grammar does not know to Gemini 3.8 Flash through the key server; in one live run with a fake microphone a reply took 2850 ms and its first audio 530 ms. Stop is always handled offline. |
| Moving the arm by voice | Simulated arm, browser speech to text, offline grammar, Gemini when live | Speech to text is the browser's speech recognition, which sends audio to the browser's speech service and needs the network. Once a line is text, an offline grammar in the browser runs common commands with no network call. These are moves, grip, pick it up, put it down, home, hand back and stop. A looser line goes to Gemini 3.8 Flash through the key server, but only when Gemini is live. Offline, RoBuff says it did not understand. The arm it moves is the simulated SO-ARM100. Every measured run fed typed transcripts into a fake speech recognizer, not a real microphone. |
| Skins | Live pictures when a key is set, procedural otherwise | Nano Banana pictures are live, paid calls through the key server, made only when it has a Gemini key. With no key, or when a call fails, the browser draws a procedural pattern instead. A badge on screen says which, for example "skin: Nano Banana 2 Lite (live)" or "skin: procedural (offline)". An uploaded image stays in the browser. A skin changes only the look. Mass, friction and collision shapes stay the same. |
| Stop gesture | Built | Both hands open, held 0.4 s, freezes the arm (needs `?hands=2`); the Space key always works. Tested on replayed and synthetic hands; a real-hand try has not been logged. |
| Hand control feel | Tried, not measured | The author steered the arm with his own hand on a laptop webcam and it worked; the try was not timed and no numbers were logged. Every measured number comes from the scripted, photo and fake-camera tests. |
| Scene look | Simulated, drawn by our code | A procedural lunar floor, a small procedural Earth and an original RoBuff mission patch on the arm (no agency marks). Builder-tested only: about 236 frames per second headless with the new scene. |
| Hosting | Local only | Runs on your own machine from `npm run dev`. Not deployed to Vultr or any other server. |
| Demo video | The author's own recording | The submission video is the author's own recording of the app. The repo's `web/e2e/demo-path.spec.ts` recording is an automated browser test with scripted input, not the submission video. |

## Results

Ghost benefit: not yet measured (0 logged trials). The ghost test is one operator's logged grabs with the ghost on and off at 2.56 s delay, with its pass rule written down before any data; it has not been run. Everything measured so far is an engineering check of the parts (tracking time, pick height, lift tests, gravity drops, live service checks), summarised under "What the tests showed" above and listed in full in [HOW_IT_WORKS.md](HOW_IT_WORKS.md).

I added voice motion and skins on 2026-11-08. An independent re-check passed voice motion at 03:54 EST and skins at 04:09 EST. These numbers come from the independent verifier's runs unless a line says otherwise. The voice unit numbers come from the 03:54 re-check. The voice browser-test numbers come from the verifier's earlier browser run at 03:20 EST. The voice live numbers come from the verifier's live run at 03:47 EST.

- Voice move, unit test: "move left" by 5 cm moved the target 50.00 mm along screen left and 0.00 mm across. The gripper moved 49.74 mm in 0.94 s, at a peak of 0.092 m/s.
- Voice move, browser test: "move left 5 cm" moved the gripper 49.4 mm along screen left and 0.3 mm across. "Go up a bit" raised it 19.4 mm. "Close" took the jaw gap from 15.8 mm to 4.3 mm.
- Voice stop: in the unit test the gripper moved at most 0.99 mm in the 0.5 s after a stop. In the browser test, a stop in the middle of a move let it drift 0.4 mm over about 0.5 s.
- Voice pick: the test cube rose 78.5 mm with both jaws on it. Put down left its lowest point at -0.1 mm. Builder-tested only: in a Node physics test a 5-part AK-47 rose 77.2 mm.
- Voice in Moon mode with the ghost on: after a move, the ghost moved 2 mm at +0.43 s. The true arm moved at +1.69 s.
- Voice, live run with real Gemini and ElevenLabs: "move left five centimetres" and "go up a bit" used the grammar with 0 chat calls. They moved the arm 49.5 mm left and 19.5 mm up. "Could you grab the cube and lift it a little higher" went to Gemini. It answered in 4591 ms with a pick and a 2 cm move up. The cube rose 98 mm. RoBuff's first audio came 73 to 492 ms after a grammar line and 4716 ms after the chat line.
- Skins, live: a fresh Fast picture took 3515 ms on the key server (3577.5 ms in the browser), at 1024x1024. A repeat from the disk cache took 39.8 to 207.7 ms in the browser and paid for no new picture.
- Skins on every part: the galaxy Tesla got all 6 parts painted, and two AK-47s got all 6 and all 7. Skinned objects still lifted: the Tesla rose 76 mm and 75.3 mm, and the Pro gold AK-47 rose 77 mm.
- Procedural skins: the unit test runs in Node and keeps the fastest of 3 draws. A 1024x1024 pattern took 31 ms (gold), 47 ms (wood) and 78 ms (galaxy) of CPU time.
- Tests: at the 04:09 re-check the full unit suite passed 378 tests in 46 files, and the key server tests passed 24 of 24. On the final commit `c40ec1e`, an agent that did not write the code tested a fresh copy of the repository with no keys. It passed 381 unit tests in 46 files and 27 of 27 key server tests. Its pick, voice-motion and skins browser tests passed too.
- Builder-tested only: six fresh Fast pictures took 3.1 to 4.5 s. Three fresh High quality (Pro) pictures took 12.1, 12.5 and 12.9 s. In two builder runs, a typed command started the arm moving after 237 to 290 ms (medians 274 and 283 ms, in Direct mode). The integration run used both features and live keys, and it was not separately re-checked. In it, "pick it up" lifted a Gemini-built galaxy Tesla 76.3 mm. "Move it left five centimetres" carried it 47.9 mm. "Put it down" left it at -0.1 mm.

## Limits

The ghost test will have one operator, who built the system and knows the task, so learning and expectation can favour either condition and the result will not generalise to other people. The ghost and the true arm will run the same physics engine and arm model, so the only prediction error will be the mass and friction mismatch we chose, which is far smaller and simpler than the calibration, model and contact errors that real predictive displays face. There is no hardware, network jitter or video compression: the delay will be a constant 2.56 s, so the numbers describe this interface in simulation and nothing about any flight system.

Other limits, all measured: at Bennu gravity a 5 cm/s sideways push lifted the resting cube 46.9 mm, which is a solver artefact, not real physics; scripted picks failed at 3 of 9 cube positions, all 8 to 12 cm off the arm's centre line; the pinch thresholds were set from test images and the scripted hand, not yet tuned on a real operator's pinch. Everyday objects are stand-ins: a single shape, or 3 to 8 simple coloured parts at toy size, never a detailed model. Parts results vary per Gemini run, since Gemini writes a new spec each time. An assembly's mass sums its parts' volumes, so where parts overlap that volume counts twice (the receipt says the mass is the sum of the parts' volumes). Talk live needs the browser's speech recognition, which in practice means Chrome; other browsers get a note to type instead. Its replies are capped at 200 characters, and while RoBuff is speaking it does not listen, so a spoken "stop" waits until the line ends; the Space key, the stop gesture and the typed command still stop the arm at once. The control changes made at the end (the 1.4 hand gain, faster smoothing, mouse click to grip, the automatic test rock) were tested by their builder, with no separate check yet.

Voice motion passed its re-check, but two of its checks passed only on a second run. In 1 of 4 live chat runs, the chat route went past its 10 s limit and returned a 504. Commit `b70db06` raised that limit to 20 s. A line that goes to Gemini is silent for about 5 to 7 s while Gemini answers. Picks and put-downs by voice work only in Direct mode, and the Moon modes refuse them. Before commit `c40ec1e`, voice could wrongly say it was already holding the object after a scene reset. That commit clears the hold after a reset or a new object. The hold fix passed a separate re-check at 04:59 EST. The 20 s limit passed the key server tests in an independent fresh-copy test of `c40ec1e`. Not measured yet: a real microphone, or handing control back to a real hand on a webcam. The time from a command to the first motion was measured by its builder only. Voice motion was not measured on any machine but mine.

Each new Nano Banana picture is a paid call. Google's pricing page, read on November 8, lists about 3.4 cents a picture for `gemini-3.1-flash-lite-image` and about 13.4 cents for `gemini-3-pro-image` at this size. These are list prices, not billed amounts. The key server keeps each picture in a disk cache, keyed by the model and the text. It cleans the text first. It lowercases it, collapses spaces, and drops end punctuation and one leading "a", "an" or "the". So the same look at the same quality is not paid for twice, but other wordings of one look still are. The server also caps pictures at 100 units a day. A Fast picture costs 1 unit and a High quality picture 4, so the cap is 100 Fast or 25 High quality pictures. The counts are kept in memory, so they reset at midnight and when the server restarts. A picture from the cache says "(cached)" on its badge. The first material word in the text sets the finish. So "brushed gold" looks metal, and a galaxy "with tiny gold stars" stays dull. The text cleaning, the 100-unit cap, the "(cached)" badge and the finish rule came in commits `b70db06` and `c40ec1e`. The badge, the finish rule and the browser's text cleaning passed a separate re-check at 04:59 EST. The cap and the server's text cleaning passed the key server tests in an independent fresh-copy test of `c40ec1e`. One case was not seen live after that, the "(live)" badge on a fresh High quality picture. A browser test with a stand-in server covers it. Brushed gold from the Fast model looks a bit like wood grain up close, which is a judgement from screenshots. The Moon modes put the test rock back, so the object and its skin are gone. The fallback after a failed call was tested only against a stand-in server that fakes the failure. The picture is projected from a box, so it can show seams on round parts. How often was not measured.

No camera frames leave the laptop. Hand tracking runs on device. Gemini receives only text, and only when a key is configured. That text is the typed or transcribed request. For Talk live it also gets the recent turns and the app's state. The state is the mode, gravity, last object and whether the arm is stopped. It also has the object's name and part names, whether the arm holds it, and the gripper position. Chrome's speech recognition, used by both voice buttons, needs the network.

Nano Banana receives only the skin description. An uploaded skin image never leaves the browser.

## Who this is for

Designed for students and science-centre visitors who want to feel why space robotics is hard, using only a laptop webcam. Nobody has used it yet, and no users are implied. Light takes 2.56 s to go from the Earth to the Moon and back (mean distance 384,400 km, [NASA NSSDC Moon fact sheet](https://nssdc.gsfc.nasa.gov/planetary/factsheet/moonfact.html), retrieved 2026-11-07).

Also for anyone who wants to try a delay-display experiment without a robot or a lab. Predictive displays have cut completion times for free motion at 1 to 3 s delays ([Sheridan 1984, NTRS 19850006202](https://ntrs.nasa.gov/citations/19850006202); [Richter et al. 2019, IEEE ICRA](https://arxiv.org/abs/1809.08627), 49.2 s with the display against 60.6 s without at 1 s; both retrieved 2026-11-07), and DLR flew one on the ROTEX arm in 1993 at a 5 to 7 s delay ([DLR](https://www.dlr.de/en/rm/research/robotic-systems/history/rotex-1988-1993), retrieved 2026-11-07). Those studies are small (most had 4 to 20 people) and each needed a robot. RoBuff is not new in idea: predictive displays date from the 1980s JPL and MIT work. It is uncommon at hackathons: in a keyword scan of 755 saved UB Hacking entries we found none that put an arm in a physics simulation, checked generated objects for pickup, or modelled light delay (full text for Fall 2025, titles and taglines for older editions, so the scan can miss entries). Hand tracking is common there, and RoBuff does not claim it as new.

It is not operator training, it does not model Canadarm3 or any flight system, and the ghost does not solve delay.

## Provenance and disclosure

### Built during UB Hacking 2026

Every line of application code in this repository: the app in `web/src`, its tests, its scripts, and these docs. The repository's first commit is at 1:43 PM EST on November 7, 2026, after hacking opened at 1:30 PM; the commit history shows the rest.

I built two more features during the hackathon and committed them at 04:24 EST on November 8. Voice motion is in `024d7cf` and skins are in `a9c997d`. The key server's skin route, its daily cap and the chat route's arm actions are in `96ac77a`. The wiring that joins them to the app is in `6e7d66b`.

### Existed before

- The robot model: MuJoCo Menagerie's SO-ARM100 (`trs_so_arm100`, Apache-2.0), itself derived from The Robot Studio's SO-ARM100.
- Libraries: MuJoCo 4.0.0 (WASM), MediaPipe Tasks Vision, three.js, Vite, Vitest, Playwright, TypeScript.
- The public MediaPipe hand landmarker model.
- Data: NASA NSSDC gravity and distance values, JPL's Bennu values, published asteroid sample densities, and Engineering ToolBox friction values.
- Two ideas from my earlier EmberHacks project, voice control and generated images. EmberHacks had a voice assistant on Gemini Live, Google's live voice API, plus a typed one on Gemini Flash. It ran robot tasks and created and decorated objects. It also used a Gemini Flash-lite image model to print generated labels on part faces. None of that code is here. RoBuff's voice motion and skins are new code, written during this hackathon (see the next section).

Versions, sources and licences for all of these are in [THIRD_PARTY.md](THIRD_PARTY.md).

### Related earlier projects by the same author

These are different projects, and no code from them is reused here. During planning, their repositories were read for facts only (arm limits, package names, what overlapped), never copied.

- WorkCell series: simulated SO-ARM100 robot-learning projects.
- EmberHacks "The cell": a voice-instructed simulated robot cell with Gemini, kinematic only (no physics), submitted to another event. It also had a hold-to-talk voice assistant on Gemini Live, Google's live voice API. Through tool calls it ran robot tasks and created and decorated objects. It also had a typed assistant on Gemini Flash. It used a Gemini Flash-lite image model to print generated labels on part faces.
- HandSignal: hand-gesture safety signals with MediaPipe.
- FleetLine: a console for a simulated robot fleet.

What they share with RoBuff: the same public arm model (WorkCell and EmberHacks), the same hand-tracking library (HandSignal and EmberHacks), and the author's experience.

RoBuff's voice motion and skins share two ideas with EmberHacks, not its code. Both are new code, written during this hackathon, and they work differently. In RoBuff a voice move enters the same control path as the hand. So the stop, the reach limit, the Moon delay and the ghost apply to voice moves too. A skin can cover every part of an object built from parts, instead of a label printed on part faces. RoBuff's Fast skins use a Flash-lite image model too. RoBuff's chat replies use Gemini Flash too.

### AI tools used and how

- Anthropic's Claude, through Claude Code (the Fable and Opus models), planned the build, summarised research, and wrote and tested code and drafts under Ahmed's direction and review.
- Gemini 3.8 Flash turns spoken or typed object requests into specs inside the product, through the local key server, when a key is configured. Its live check passed on 2026-11-07 (5 of 5 valid specs, median 3.9 s). It also writes the part lists for objects built from parts, and the Talk live replies with up to 3 chosen actions. Code checks both before anything happens. Those actions can now move the arm, pick up, put down and paint a skin. Gemini can never stop or resume the arm.
- Nano Banana, Google's Gemini image models, draws skins inside the product through the key server when a Gemini key is set. Fast uses `gemini-3.1-flash-lite-image` (shown as Nano Banana 2 Lite). High quality uses `gemini-3-pro-image` (shown as Nano Banana Pro). Its pictures are AI-made and carry SynthID, Google's invisible mark for AI images. Only the short description is sent, wrapped in a fixed prompt. The prompt asks for a flat texture that tiles with no visible edges. It also asks for no objects, text or logos.
- ElevenLabs speaks the console's lines when its key is set on the machine running the key server (live check: 5 of 5 lines, first audio median 176 ms). It is not deployed anywhere, so a judge's own copy needs its own key or uses the labelled browser voice.
- The MediaPipe hand landmarker reads your hand, on device.

### Simulated and mocked data

- Both arms, the gravity, the contact and the light delay are simulated.
- Object specs come from the offline keyword mock when no Gemini key is present; the on-screen badge says which source answered.
- The voice uses the browser's own voice when no ElevenLabs key is present, labelled offline.
- The tests use a scripted synthetic hand and a fake camera made from that hand's painted points.
- Skins are procedural patterns drawn in the browser when no Gemini key is present or a Nano Banana call fails. The badge says which.
- The voice-motion tests and live runs fed typed transcripts into a fake speech recognizer. No real microphone was used. Gemini and ElevenLabs were real in the live runs.
- The demo video is the author's own recording, in his own words. The `demo-path` browser test also records a video, with scripted input; it is a test, not the submission video.

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
