import { describe, expect, it } from 'vitest';
import { createFollowupQueueSlice, followupSessionAliases, isFollowupFlushBlocked, resolveFollowupSessionRef, type FollowupItem } from '../../stores/followup-queue-slice';

function draft(text: string): Omit<FollowupItem, 'id' | 'createdAt'> {
  return {
    text,
    editorJson: { type: 'doc', content: [] },
    skills: [],
    sessionRefs: [],
    agentMentions: [],
    attachedFiles: [],
    quotes: [],
    docContextAttached: false,
    doc: null,
  };
}

describe('followup queue slice', () => {
  it('enqueues, edits, peeks, and removes per session path', () => {
    let state = createFollowupQueueSlice((partial) => {
      const next = typeof partial === 'function' ? partial(state) : partial;
      state = { ...state, ...next };
    }, () => state);

    const first = state.enqueueFollowup('/s/a.jsonl', draft('one'));
    state.enqueueFollowup('/s/a.jsonl', draft('two'));
    state.enqueueFollowup('/s/b.jsonl', draft('other'));

    expect(state.peekFollowup('/s/a.jsonl')?.text).toBe('one');
    expect(state.followupsBySession['/s/a.jsonl']).toHaveLength(2);

    state.updateFollowup('/s/a.jsonl', first.id, { text: 'one-edited' });
    expect(state.peekFollowup('/s/a.jsonl')?.text).toBe('one-edited');
    expect(state.peekFollowup('/s/a.jsonl')?.id).toBe(first.id);
    expect(state.peekFollowup('/s/a.jsonl')?.revision).toBe(1);
    state.reorderFollowup('/s/a.jsonl', first.id, 1);
    expect(state.followupsBySession['/s/a.jsonl'].find((item) => item.id === first.id)?.revision).toBe(1);
    state.reorderFollowup('/s/a.jsonl', first.id, 0);

    expect(state.removeFollowup('/s/a.jsonl', first.id)?.text).toBe('one-edited');
    expect(state.peekFollowup('/s/a.jsonl')?.text).toBe('two');
    expect(state.followupsBySession['/s/b.jsonl'][0].text).toBe('other');

    state.enqueueFollowup('/s/a.jsonl', draft('three'));
    state.enqueueFollowup('/s/a.jsonl', draft('four'));
    const last = state.followupsBySession['/s/a.jsonl'][2];
    state.reorderFollowup('/s/a.jsonl', last.id, 0);
    expect(state.followupsBySession['/s/a.jsonl'].map((item) => item.text)).toEqual(['four', 'two', 'three']);
    state.reorderFollowup('/s/a.jsonl', last.id, 99);
    expect(state.followupsBySession['/s/a.jsonl'].map((item) => item.text)).toEqual(['two', 'three', 'four']);

    state.clearFollowups('/s/a.jsonl');
    expect(state.peekFollowup('/s/a.jsonl')).toBeNull();
    expect(state.followupsBySession['/s/b.jsonl']).toHaveLength(1);
  });

  it('peeks a path-keyed queue from the session id used by streamingSessions', () => {
    let state = createFollowupQueueSlice((partial) => {
      const next = typeof partial === 'function' ? partial(state) : partial;
      state = { ...state, ...next };
    }, () => state);

    state.enqueueFollowup('/s/a.jsonl', draft('queued'));
    Object.assign(state, {
      currentSessionPath: '/s/a.jsonl',
      currentSessionId: 'sess_0mtgqlpyz',
      sessions: [{ path: '/s/a.jsonl', sessionId: 'sess_0mtgqlpyz' }],
      sessionLocatorsById: { sess_0mtgqlpyz: { path: '/s/a.jsonl' } },
    });

    expect(state.followupsBySession['/s/a.jsonl']).toHaveLength(1);
    expect(state.peekFollowup('sess_0mtgqlpyz')?.text).toBe('queued');
    const queued = state.peekFollowup('sess_0mtgqlpyz')!;
    Object.assign(state, { currentSessionId: 'sess_b', currentSessionPath: '/s/b.jsonl' });
    expect(state.removeFollowup('sess_0mtgqlpyz', queued.id)?.text).toBe('queued');
    expect(state.peekFollowup('sess_0mtgqlpyz')).toBeNull();
    expect(state.followupsBySession['/s/a.jsonl']).toBeUndefined();
  });

  it('does not treat a different focused session as a queue alias or blocker', () => {
    const state = {
      currentSessionPath: '/s/b.jsonl', currentSessionId: 'sess_b',
      sessions: [
        { path: '/s/a.jsonl', sessionId: 'sess_a', agentId: 'agent-a' },
        { path: '/s/b.jsonl', sessionId: 'sess_b', agentId: 'agent-b' },
      ],
      sessionLocatorsById: { sess_a: { path: '/s/a.jsonl' }, sess_b: { path: '/s/b.jsonl' } },
      streamingSessions: ['sess_b'],
      capabilityRefreshingSessions: ['sess_b'],
      compactingSessions: ['sess_b'],
    };
    expect(followupSessionAliases(state, 'sess_a')).toEqual(['sess_a', '/s/a.jsonl']);
    expect(isFollowupFlushBlocked(state, 'sess_a')).toBe(false);
    expect(isFollowupFlushBlocked(state, '/s/a.jsonl')).toBe(false);
    expect(isFollowupFlushBlocked(state, 'sess_b')).toBe(true);
  });

  it('resolves the queue owner without borrowing the focused agent or session', () => {
    const state = {
      currentSessionPath: '/s/b.jsonl', currentSessionId: 'sess_b', currentAgentId: 'agent-b',
      sessions: [
        { path: '/s/a.jsonl', sessionId: 'sess_a', agentId: 'agent-a' },
        { path: '/s/b.jsonl', sessionId: 'sess_b', agentId: 'agent-b' },
      ],
      sessionLocatorsById: { sess_a: { path: '/s/a.jsonl' }, sess_b: { path: '/s/b.jsonl' } },
    };
    const expected = { sessionId: 'sess_a', sessionPath: '/s/a.jsonl', agentId: 'agent-a' };
    expect(resolveFollowupSessionRef(state, 'sess_a')).toEqual(expected);
    expect(resolveFollowupSessionRef(state, '/s/a.jsonl')).toEqual(expected);
    expect(Object.isFrozen(resolveFollowupSessionRef(state, 'sess_a'))).toBe(true);
    expect(resolveFollowupSessionRef(state, 'sess_unknown')).toBeNull();
    expect(resolveFollowupSessionRef(state, '/s/missing.jsonl')).toBeNull();
    expect(resolveFollowupSessionRef({ ...state, sessions: [], sessionLocatorsById: {} }, 'sess_a')).toBeNull();
    expect(resolveFollowupSessionRef({ ...state, sessionLocatorsById: { sess_a: { path: null } } }, 'sess_a')).toBeNull();
  });

  it('blocks flush while the session is compacting or refreshing', () => {
    const state = {
      currentSessionPath: '/s/a.jsonl',
      currentSessionId: 'sess_0mtgqlpyz',
      sessions: [{ path: '/s/a.jsonl', sessionId: 'sess_0mtgqlpyz' }],
      sessionLocatorsById: { sess_0mtgqlpyz: { path: '/s/a.jsonl' } },
      streamingSessions: [],
      capabilityRefreshingSessions: [],
      compactingSessions: ['sess_0mtgqlpyz'],
    };

    expect(isFollowupFlushBlocked(state, 'sess_0mtgqlpyz')).toBe(true);
    expect(isFollowupFlushBlocked({ ...state, compactingSessions: [], capabilityRefreshingSessions: ['sess_0mtgqlpyz'] }, '/s/a.jsonl')).toBe(true);
    expect(isFollowupFlushBlocked({ ...state, compactingSessions: [], capabilityRefreshingSessions: [] }, 'sess_0mtgqlpyz')).toBe(false);
  });
});
