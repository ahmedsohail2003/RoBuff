import { describe, expect, it } from 'vitest';
import { stageViews, type LoopReading } from './loopStrip';

const base: LoopReading = {
  input: 'webcam',
  cameraFps: 30,
  trackingMs: 17.4,
  webcamState: 'running',
  handSeen: true,
  handLost: false,
  pinch: 'open',
  pinchRatio: 0.41,
  guardrail: null,
  guardrailBusy: false,
  specSource: 'offline mock (no key)',
  ghostErrorMm: null,
  ghostLevel: null,
  ghostOn: false,
  delayed: false,
  stopped: false,
  stopWhy: null,
  gripperSpeedMmS: 0,
  jaw: 'open',
  jawMoving: false,
  speaking: false,
  lastLine: null,
  voiceMuted: false,
};

describe('loop strip stages', () => {
  it('shows camera fps and tracking ms, lit while a hand is seen', () => {
    const v = stageViews(base);
    expect(v.sense.text).toBe('camera 30 fps · tracking 17 ms · hand seen');
    expect(v.sense.active).toBe(true);
    expect(v.understand.text).toBe('pinch open (0.41) · guardrail - · spec offline mock (no key)');
    expect(v.understand.active).toBe(false);
    expect(v.act.text).toBe('arm still · jaw open · voice quiet');
    expect(v.act.active).toBe(false);
  });

  it('marks a lost hand as holding in Sense and Act', () => {
    const v = stageViews({ ...base, handSeen: false, handLost: true });
    expect(v.sense.state).toBe('holding');
    expect(v.sense.active).toBe(false);
    expect(v.act.text.startsWith('arm holding (hand lost)')).toBe(true);
    expect(v.act.state).toBe('holding');
  });

  it('lights Understand for a pinch change, a guardrail check or a live ghost error', () => {
    expect(stageViews(base, true).understand.active).toBe(true);
    expect(stageViews({ ...base, guardrailBusy: true }).understand.text).toContain('guardrail checking...');
    const ghost = stageViews({ ...base, ghostOn: true, ghostErrorMm: 1.234, delayed: true });
    expect(ghost.understand.active).toBe(true);
    expect(ghost.understand.text).toContain('ghost err 1.2 mm');
    expect(ghost.act.text).toContain('seen 1.28 s late');
  });

  it('lights Act while moving or speaking, never while stopped', () => {
    expect(stageViews({ ...base, gripperSpeedMmS: 42 }).act.text).toContain('arm moving 42 mm/s');
    expect(stageViews({ ...base, gripperSpeedMmS: 42 }).act.active).toBe(true);
    expect(stageViews({ ...base, speaking: true, lastLine: 'PASS' }).act.text).toContain('speaking: "PASS"');
    expect(stageViews({ ...base, speaking: true, lastLine: 'PASS', voiceMuted: true }).act.text).toContain('caption (muted): "PASS"');
    const stopped = stageViews({ ...base, stopped: true, stopWhy: 'space key', gripperSpeedMmS: 42 });
    expect(stopped.act.active).toBe(false);
    expect(stopped.act.state).toBe('stopped');
    expect(stopped.act.text).toBe('ARM STOPPED (space key) · jaw held open');
  });

  it('names synthetic and mouse input plainly', () => {
    expect(stageViews({ ...base, input: 'synthetic' }).sense.text).toContain('synthetic hand (scripted test input)');
    expect(stageViews({ ...base, input: 'mouse' }).sense.text).toBe('mouse pointer (no camera)');
    expect(stageViews({ ...base, webcamState: 'denied', handSeen: false }).sense.text).toBe('camera denied');
  });
});
