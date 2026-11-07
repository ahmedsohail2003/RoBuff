import { describe, expect, it } from 'vitest';
import { chooseInputKind, handBanner, statusLine, trackerLine } from './states';

describe('start input (M1 step 8)', () => {
  const cams = async () => [{ kind: 'audioinput' as const }, { kind: 'videoinput' as const }];
  const none = async () => [{ kind: 'audioinput' as const }];
  it('uses the webcam when a camera is listed, the mouse when none is', async () => {
    expect(await chooseInputKind('', cams)).toEqual({ kind: 'webcam', why: 'a camera was found' });
    expect(await chooseInputKind('?speed=2', none)).toEqual({ kind: 'mouse', why: 'no camera found' });
    expect(await chooseInputKind('', () => Promise.reject(new Error('blocked')))).toEqual({ kind: 'mouse', why: 'cameras could not be listed' });
  });
  it('lets ?input= override the camera check', async () => {
    expect((await chooseInputKind('?input=mouse', cams)).kind).toBe('mouse');
    expect((await chooseInputKind('?input=synthetic', cams)).kind).toBe('synthetic');
    expect((await chooseInputKind('?input=webcam', none)).kind).toBe('webcam');
    expect((await chooseInputKind('?input=bogus', cams)).kind).toBe('webcam');
  });
});

describe('hand lost line (M1 step 4)', () => {
  const hand = (confidence: number) => ({ palm: [0.5, 0.5, 0.5] as [number, number, number], pinch: 0, confidence, tMs: 0 });
  it('says so when the webcam is running and the hand is gone', () => {
    expect(handBanner('webcam', 'running', null)).toBe('show one hand to the camera');
    expect(handBanner('webcam', 'running', hand(0))).toBe('hand lost, arm holding');
    expect(handBanner('webcam', 'running', hand(0.9))).toBeNull();
  });
  it('says nothing for other sources or before the camera runs', () => {
    expect(handBanner('mouse', null, null)).toBeNull();
    expect(handBanner('synthetic', null, hand(0))).toBeNull();
    expect(handBanner('webcam', 'idle', null)).toBeNull();
  });
});

describe('status strip (M1 step 3) and warm-up line (step 2)', () => {
  it('lists tracking ms, physics ms, fps, input and grip', () => {
    const line = statusLine({ version: 'MuJoCo 3', input: 'input: webcam, running', trackingMs: 11.4, physicsMs: 0.34, fps: 59.7, grip: 'closed', stopped: false });
    expect(line).toBe('MuJoCo 3 | input: webcam, running | tracking 11 ms | physics 0.3 ms | 60 fps | grip closed');
    const stopped = statusLine({ version: 'v', input: 'input: mouse', trackingMs: null, physicsMs: 1, fps: 0, grip: 'open', stopped: true });
    expect(stopped).toBe('v | input: mouse | tracking - | physics 1.0 ms | 0 fps | grip open | STOPPED');
  });
  it('reports the warm-up', () => {
    expect(trackerLine('loading', null)).toContain('loading');
    expect(trackerLine('warming-up', null)).toContain('warming up');
    expect(trackerLine('warm', 8912)).toBe('Hand tracking: tracking warm (first run took 8.9 s)');
    expect(trackerLine('failed', null)).toContain('mouse');
  });
});
