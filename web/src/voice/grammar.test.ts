import { describe, expect, it } from 'vitest';
import { HELP_LINE, normalizeUtterance, parseCommand, type VoiceAction } from './grammar';

const CASES: [string, VoiceAction][] = [
  ['stop', { type: 'stop' }],
  ['STOP!', { type: 'stop' }],
  ['please stop the arm now', { type: 'stop' }],
  ['resume', { type: 'resume' }],
  ['go home', { type: 'home' }],
  ['open the gripper', { type: 'grip', open: true }],
  ['close', { type: 'grip', open: false }],
  ['Earth', { type: 'gravity', id: 'earth' }],
  ['go to Mars', { type: 'gravity', id: 'mars' }],
  ['set gravity to the moon', { type: 'gravity', id: 'moon' }],
  ['Bennu', { type: 'gravity', id: 'bennu' }],
  ['orbit', { type: 'gravity', id: 'orbit' }],
  ['zero gravity', { type: 'gravity', id: 'orbit' }],
  ['delay on', { type: 'delay', on: true }],
  ['turn the delay off', { type: 'delay', on: false }],
  ['ghost on', { type: 'ghost', on: true }],
  ['hide the ghost', { type: 'ghost', on: false }],
  ['give me a shard of comet ice', { type: 'object', text: 'a shard of comet ice' }],
  ['make an asteroid the size of Texas', { type: 'object', text: 'an asteroid the size of texas' }],
  ['spawn a cubesat solar panel', { type: 'object', text: 'a cubesat solar panel' }],
];

const NONSENSE = ['banana telephone', 'the quick brown fox jumps', 'asdf qwerty zxcv'];

describe('offline voice grammar', () => {
  it.each(CASES)('maps %j to its action', (phrase, action) => {
    expect(parseCommand(phrase)).toEqual(action);
  });

  it('covers 20 phrases', () => {
    expect(CASES.length).toBe(20);
  });

  it.each(NONSENSE)('maps nonsense %j to unknown', (phrase) => {
    expect(parseCommand(phrase).type).toBe('unknown');
  });

  it('stops on a stop word anywhere, even inside an object request', () => {
    expect(parseCommand('make it stop')).toEqual({ type: 'stop' });
    expect(parseCommand('make a stop sign')).toEqual({ type: 'stop' });
    expect(parseCommand('no wait, stop stop')).toEqual({ type: 'stop' });
    expect(parseCommand('')).toEqual({ type: 'unknown', text: '' });
  });
});

// ---- The second table: moves, picks, places, skins, numbers and the lines that must not move ----

const mv = (direction: string, cm: number, amount: 'said' | 'small' | 'default' | 'large' = 'said'): VoiceAction => ({ type: 'move', direction, cm, amount }) as VoiceAction;

const MOTION_CASES: [string, VoiceAction][] = [
  ['move left 5 centimetres', mv('left', 5)],
  ['move left five centimetres', mv('left', 5)],
  ['Move left 2.5 cm.', mv('left', 2.5)],
  ['move right 3 cm', mv('right', 3)],
  ['go up a bit', mv('up', 2, 'small')],
  ['go down a little', mv('down', 2, 'small')],
  ['up', mv('up', 5, 'default')],
  ['lower', mv('down', 5, 'default')],
  ['move forward', mv('forward', 5, 'default')],
  ['move back 4 cm', mv('back', 4)],
  ['move it to the left by twenty five millimetres', mv('left', 2.5)],
  ['nudge it right', mv('right', 2, 'small')],
  ['move left a lot', mv('left', 10, 'large')],
  ['move all the way left', mv('left', 30, 'large')],
  ['5 cm left', mv('left', 5)],
  ['move 2 inches up', mv('up', 5.08)],
  ['move left to centimetres', mv('left', 2)],
  ['move up for centimetres', mv('up', 4)],
  ['move half a centimetre left', mv('left', 0.5)],
  ['move one and a half centimetres down', mv('down', 1.5)],
  ['move toward me', mv('toward', 5, 'default')],
  ['come closer', mv('toward', 5, 'default')],
  ['move away from me 3 cm', mv('away', 3)],
  ['go further', mv('away', 5, 'default')],
  ['make it go left', mv('left', 5, 'default')],
  ['could you move the gripper up 10 cm please', mv('up', 10)],
  ['raise it a little', mv('up', 2, 'small')],
  ['lift it a little higher', mv('up', 2, 'small')],
  ['move left 40 cm', mv('left', 40)],
  ['move 7 left', mv('left', 7)],
  ['pick it up', { type: 'pick', target: null }],
  ['pick up the banana', { type: 'pick', target: 'banana' }],
  ['grab the cube', { type: 'pick', target: 'cube' }],
  ['pick the tesla up', { type: 'pick', target: 'tesla' }],
  ['put it down', { type: 'place' }],
  ['set it down', { type: 'place' }],
  ['place it', { type: 'place' }],
  ['drop it', { type: 'grip', open: true }],
  ['release', { type: 'grip', open: true }],
  ['let go', { type: 'grip', open: true }],
  ['let it go', { type: 'grip', open: true }],
  ['close the gripper', { type: 'grip', open: false }],
  ['open it', { type: 'grip', open: true }],
  ['grab it', { type: 'grip', open: false }],
  ['what can you do', { type: 'help' }],
  ['hand control', { type: 'handBack' }],
  ['give it back', { type: 'handBack' }],
  ['your turn', { type: 'handBack' }],
  ['make it gold', { type: 'skin', look: 'gold', part: null }],
  ['paint it gold', { type: 'skin', look: 'gold', part: null }],
  ['paint the wheels black', { type: 'skin', look: 'black', part: 'wheels' }],
  ['give it a galaxy skin', { type: 'skin', look: 'galaxy', part: null }],
  ['make it look like carbon fibre', { type: 'skin', look: 'carbon fibre', part: null }],
  ['paint it in red and white stripes', { type: 'skin', look: 'red and white stripes', part: null }],
  ['remove the skin', { type: 'unskin', part: null }],
  ['take the skin off', { type: 'unskin', part: null }],
  ['remove the skin from the wheels', { type: 'unskin', part: 'wheels' }],
  ['make it bigger', { type: 'object', text: 'it bigger' }],
  ['make a cube', { type: 'object', text: 'a cube' }],
  ['go to the moon', { type: 'gravity', id: 'moon' }],
  ['back home', { type: 'home' }],
  ['make it stop', { type: 'stop' }],
  ['stop moving left', { type: 'stop' }],
];

const MUST_NOT_MOVE = ['right', 'all right', 'go back', 'come back', 'pick a lighter material', 'could you whip up a tennis ball', 'take me to the lunar surface', 'calm down', 'zero'];

describe('the second grammar table: moves, picks, places, skins', () => {
  it.each(MOTION_CASES)('maps %j to its action', (phrase, action) => {
    expect(parseCommand(phrase)).toEqual(action);
  });

  it('has at least 40 phrases', () => {
    expect(MOTION_CASES.length).toBeGreaterThanOrEqual(40);
  });

  it.each(MUST_NOT_MOVE)('does not move the arm for %j', (phrase) => {
    const action = parseCommand(phrase);
    expect(['move', 'pick', 'place']).not.toContain(action.type);
  });

  it('keeps a decimal point between digits and the help line short', () => {
    expect(normalizeUtterance('Move left 2.5 cm.')).toBe('move left 2.5 cm');
    expect(HELP_LINE.length).toBeLessThanOrEqual(160);
  });
});

describe('sentences for the chat brain', () => {
  it('leaves a pick with more in it to Gemini', () => {
    expect(parseCommand('could you grab the cube and lift it a little higher').type).toBe('unknown');
    expect(parseCommand('pick it up and move it left').type).toBe('unknown');
  });
});
