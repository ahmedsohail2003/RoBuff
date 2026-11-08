# Ghost gate: trial protocol

Written down on 2026-11-07, before any trial was run. **No trial has been run yet.** When the
trials run, the CSV goes next to this file and the scored table goes in `ghost-gate.md`
(`node scripts/results-table.mjs <csv>`). Everything here is a simulation: both arms are MuJoCo
simulations and the delay is a constant, modelled 1.28 s each way. There is no robot.

## What is being tested

Can a predictive "ghost" arm help an operator pick up a rock through the Earth-Moon light
delay (1.28 s each way, 2.56 s round trip)? The ghost runs every hand command at once, on its
own copy of the scene; the true arm runs it 1.28 s later and the operator sees the true arm
another 1.28 s after that. The ghost does not know the rock's true mass: the true rock is
2.3 g/cm³ with friction 0.6, the ghost's copy 1.6 g/cm³ with friction 0.8. If the ghost were
an exact copy, a deterministic engine would make it a perfect predictor and the test would
prove nothing.

## Fixed for every trial

- Delay: 1,280 ms each way in both delay conditions; none in Direct.
- Gravity: Moon, 1.62 m/s² (NASA NSSDC Moon fact sheet), also in the Direct warm-ups.
- One rock: the arena's 30 mm block (`arena-block-30mm`, no generator, so seed 0), the same
  start pose, 62.1 g true (2.3 g/cm³) and 43.2 g as the ghost assumes (1.6 g/cm³). The
  block's contact uses its own friction (geom priority 1); without that MuJoCo would take
  the pads' and floor's larger friction of 1.0 and the friction mismatch would do nothing.
- Ahmed's real hand through the webcam, same seat, light and camera position. Mouse and
  synthetic runs only check that the logger works and are never counted (the scorer prints
  "NOT GATE DATA" unless every counted row is operator `ahmed` with input `webcam`).
- The same hand mapping and the same hold rule (a lost hand holds the arm) in all conditions.

## Order

The app makes the order and shows it ("Trial 9/20: GHOST ON"); nobody picks it by hand.

1. 4 trials in Direct, no delay (`practice=1`, block `warmup`): the no-delay baseline.
2. 2 practice trials per delay condition, alternating off, on, off, on (`practice=1`, block `practice`).
3. Logged trials: off, on, on, off, repeated 3 times (default, 20 trials in all) or 4 times
   (`?blocks=4`, 24 in all), blocks numbered 1 to 4.

An excluded trial is repeated at the end of the order.

## One trial

- **Start:** the Start button sets the condition, then a 3-2-1 countdown. At **GO** the scene
  resets: arm at home, rock at its start pose, the clock at zero. `t_go` is that moment.
- **Stable lift (success):** on the *true* arm's state, on the simulated clock: the rock's
  lowest point at least 30 mm above the floor and both jaw pads touching it, unbroken for
  2.0 s. `t_lift` is the start of that window. The operator sees it 1.28 s later in the delay
  conditions; that offset is the same in both.
- **Cutoff:** 90 s simulated after GO; then the trial is a failure. A drop does not end the trial.
- **Exclusions:** only technical faults. The app excludes a trial on its own when the hand is
  lost for more than 5 s in one stretch (`excluded=1`, the reason in `exclude_reason`). An app
  crash leaves no row; the trial is run again.

## Measurements (one CSV row per trial)

- `completion_s` = `t_lift - t_go`. Empty on failure, never the cutoff.
- `reach_s`: GO until the true jaw centre (midpoint of the two jaw pad tips) is within 15 mm of
  the rock centre. `grasp_s`: the first close command until `t_lift`. Both empty on failure.
- `grasp_attempts`: how many times the command went from open to closed (grip at or above 0.5).
- `drops`: the rock was held (both pads, lowest point at least 10 mm up), then ended on the
  floor (lowest point under 5 mm, no pad contact).
- `reversals`: direction changes of the commanded gripper target on x, y and z, at least 10 mm
  of travel between changes, summed over the axes.
- `pauses`: stretches of 0.5 s or more with the commanded target moving under 10 mm/s (a lost
  hand counts as not moving).
- `max_ghost_err_mm`, `mean_ghost_err_mm` (ghost-on trials only): the meter's gripper error,
  which compares the true arm *as seen now* with the ghost *as it was 2.56 s ago*, when the
  commands behind what is seen were sent. Both are known at the operator's end.
- `hand_lost_ms`: time with no usable hand (none, or confidence under 0.5).
- `render_fps_median`, `build_id`, and the settings above.

Columns, in this order (`web/src/trials/logger.ts`, read by `scripts/trials-verdict.mjs`):

`session_id, trial_idx, block, condition, practice, excluded, exclude_reason, operator, input_source, delay_oneway_ms, gravity_mps2, rock_spec_id, rock_seed, rock_size_mm, rock_mass_true_g, rock_mass_ghost_g, friction_true, friction_ghost, cutoff_s, t_go_iso, completion_s, success, reach_s, grasp_s, grasp_attempts, drops, reversals, pauses, max_ghost_err_mm, mean_ghost_err_mm, hand_lost_ms, render_fps_median, build_id`

`condition` is `direct`, `ghost_off` or `ghost_on`. The app downloads `ghost-gate-<session>.csv`
and a sidecar `ghost-gate-<session>.json` with the settings, the order and the pass rule. Rows
are also kept in the browser's localStorage, so a reload does not lose a sitting.

## Pass rule (fixed before the data)

- **GO:** median(on) ≤ 0.75 × median(off) **and** successes(on) ≥ successes(off).
- **AMBIGUOUS:** a ratio of 0.75-0.90 with successes no lower.
- **NO-GO:** a ratio above 0.90, **or** fewer successes with the ghost.
- **Sanity check:** if median(off) is under 1.5 × the Direct median, the task is too easy;
  make it harder once (a smaller rock or a tighter placement) and run again.
- Also reported, not used to decide: wins within each off/on pair and the exact sign-test p.
- Why 0.75: Richter measured 0.81 at 1 s; Sheridan's 1-3 s summary implies 0.40-0.67 under its
  most plausible reading. 0.75 sits between them. It is a judgment call, not a standard, and
  it does not change after the data. How failures enter the median is fixed in
  `scripts/lib/gate.mjs`: a failure ranks slower than every success.

## Limits

One operator runs every trial, and he built the system and knows the task, so the result
will not generalise to other people. The ghost and the true arm run the same physics engine
and arm model, so the only prediction error is the mass and friction mismatch chosen above,
far smaller and simpler than what real predictive displays face. There is no hardware,
network jitter or video compression: the delay is a constant 2.56 s round trip, so the
numbers describe this interface in simulation and nothing about any flight system.

A measurement made while building (synthetic hand, not gate data): over a scripted pick the
ghost's error against the true arm peaked at 1.2 mm at Moon gravity (2.2 mm in a run at Earth
gravity), green throughout. A likely reason,
not tested: a firm two-pad grip at Moon gravity hides most of a 19 g mass difference. Whether
the error grows during hand-flown grasps is something only the real trials will show.
