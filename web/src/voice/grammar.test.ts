import { describe, expect, it } from 'vitest';
import { parseCommand, type VoiceAction } from './grammar';

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
