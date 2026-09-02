// The two paths into state, and the undo stack that only one of them touches.
//
// SOUS_PLAN.md §2 is unambiguous about this, so it is enforced structurally rather
// than remembered:
//   1. THE TICK PATH — the interval below — calls commit() straight. No snapshot.
//   2. THE MUTATION PATH — run() — snapshots, then calls commit().
// A three-minute demo is ~180 ticks; if ticks snapshotted, undo_edit would rewind one
// minute of simulation instead of the agent's last action.
//
// Snapshots hold domain state only. Restoring one keeps the CURRENT clock, so undo
// rewinds the board without travelling back in time — and because every timestamp in
// the model is absolute, the restored party's timers recompute correctly against
// whatever minute it now is (§2, rule 3).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { conflictKey, rawConflicts } from './conflicts.ts';
import { clearSession, readSession, writeSession } from './layouts.ts';
import { restore, snapshot } from './mutations.ts';
import type { Actor, Result, Snapshot } from './mutations.ts';
import { seedState } from './seed.ts';
import { advanceTo, tick } from './sim.ts';
import type { Conflict, Shift, SousState } from './types.ts';

/** Deep enough to reflow the whole room and take it back; short enough to stay cheap. */
const UNDO_CAP = 50;
/** The activity rail scrolls; nobody reads past this. */
const LOG_CAP = 50;
/**
 * Autosave coalescing window. The tick path commits a fresh state every frame — 16 ms at
 * 60x — and localStorage.setItem is synchronous, so writing on every commit would put a
 * whole-board serialise on the critical path of the simulation. Nothing outside this file
 * ever reads the blob mid-session, so anything under about a second is invisible.
 */
const SAVE_MS = 400;

/**
 * One line per mutation, for the agent activity rail (§5). Deliberately NOT part of
 * SousState: Snapshot is Omit<SousState,'shift'>, so a log inside state would be
 * snapshotted and undo would erase the very lines proving what happened.
 */
export interface LogLine {
  n: number;
  /** Shift-minute the call landed. */
  at: number;
  by: Actor;
  ok: boolean;
  message: string;
}

// ponytail: undo is a whole-state snapshot, so it rewinds the board to the minute the
// edit was made — every tick since goes with it. Ceiling: undo an edit an hour of shift
// time later and you lose that hour of service; in a three-minute demo the gap is
// seconds, which is why SOUS_PLAN.md §5 chose snapshots. Upgrade is a per-mutation
// inverse (seatParty -> clearTable and so on) applied to the live state instead.

export interface Sous {
  state: SousState;
  /** What the board is raising. Overridden conflicts are already filtered out. */
  conflicts: Conflict[];
  /** The ones a human has accepted, still true but no longer raised. */
  overridden: Conflict[];
  /**
   * The ONLY path that pushes undo. Discards the draft whole if the mutation refuses.
   * `by` stamps the activity rail; the day-5 tool wrapper passes 'agent' and gets its
   * lines — including its refusals — with no extra wiring.
   */
  run: <T>(fn: (draft: SousState) => Result<T>, by?: Actor) => Result<T>;
  log: LogLine[];
  /**
   * Put a line on the rail without touching domain state. For the things that are real
   * actions but not mutations — saving a layout to localStorage, say — so they are still
   * accounted for on screen.
   */
  say: (by: Actor, ok: boolean, message: string) => void;
  setShift: (patch: Partial<Shift>) => void;
  jumpTo: (minute: number) => void;
  reset: () => void;
  undo: () => boolean;
  redo: () => boolean;
  canUndo: boolean;
  canRedo: boolean;
  /** Live mirror for the day-5 tool implementations, which cannot read React state. */
  ref: RefObject<SousState>;
}

export function useSous(): Sous {
  // Boot from whatever this browser was last looking at. There is no backend, so the
  // autosave IS the persistence story (SOUS_PLAN.md §6) — and it is why the seeded book
  // is dealt cooperatively: a restored night already has its reservations, and openTheBook
  // stays out of a board that has any (sim.ts).
  const [state, setState] = useState<SousState>(() => readSession() ?? seedState());
  const ref = useRef<SousState>(state);
  const past = useRef<Snapshot[]>([]);
  const future = useRef<Snapshot[]>([]);
  const [depth, setDepth] = useState({ past: 0, future: 0 });
  const [log, setLog] = useState<LogLine[]>([]);

  const say = useCallback((by: Actor, ok: boolean, message: string) => {
    setLog((l) => [{ n: (l[0]?.n ?? 0) + 1, at: ref.current.shift.clock, by, ok, message }, ...l].slice(0, LOG_CAP));
  }, []);

  useEffect(() => {
    ref.current = state;
  }, [state]);

  // AUTOSAVE. Every commit, from either path, debounced. Deliberately outside run(), so
  // that a tick, an undo and a tool call are all saved by the same line — a save wired
  // into the mutation path only would persist the room and lose the night.
  useEffect(() => {
    const id = setTimeout(() => writeSession(state), SAVE_MS);
    return () => clearTimeout(id);
  }, [state]);

  const commit = useCallback((next: SousState) => {
    ref.current = next;
    setState(next);
  }, []);

  // THE TICK PATH. Reads the mirror rather than a closed-over state, so a tool call
  // landing between a tick and its render cannot roll the clock back a minute.
  useEffect(() => {
    if (!state.shift.running) return;
    const id = setInterval(() => commit(tick(ref.current)), Math.max(16, 1000 / state.shift.speed));
    return () => clearInterval(id);
  }, [state.shift.running, state.shift.speed, commit]);

  const run = useCallback<Sous['run']>(
    (fn, by = 'human') => {
      const before = snapshot(ref.current);
      const draft = structuredClone(ref.current);
      const result = fn(draft);
      say(by, result.ok, result.message);
      if (!result.ok) return result; // nothing committed, nothing snapshotted
      past.current = [...past.current, before].slice(-UNDO_CAP);
      future.current = [];
      commit(draft);
      setDepth({ past: past.current.length, future: 0 });
      return result;
    },
    [commit, say],
  );

  const step = useCallback(
    (from: RefObject<Snapshot[]>, to: RefObject<Snapshot[]>) => {
      const target = from.current.pop();
      if (!target) return false;
      say('human', true, from === past ? 'Undid the last edit.' : 'Redid it.');
      to.current.push(snapshot(ref.current));
      commit(restore(target, ref.current));
      setDepth({ past: past.current.length, future: future.current.length });
      return true;
    },
    [commit, say],
  );

  const undo = useCallback(() => step(past, future), [step]);
  const redo = useCallback(() => step(future, past), [step]);

  // Transport. The clock is not domain state, so none of this snapshots (§2, rule 2).
  const setShift = useCallback(
    (patch: Partial<Shift>) => commit({ ...ref.current, shift: { ...ref.current.shift, ...patch } }),
    [commit],
  );
  const jumpTo = useCallback(
    (minute: number) =>
      commit(
        advanceTo(
          { ...ref.current, shift: { ...ref.current.shift, mode: 'service', running: false } },
          minute,
        ),
      ),
    [commit],
  );
  // The one way back to the seed scenario, which is what makes the autosave safe to
  // leave on: the board persists until somebody says otherwise, here.
  const reset = useCallback(() => {
    clearSession();
    past.current = [];
    future.current = [];
    setDepth({ past: 0, future: 0 });
    setLog([]);
    commit(seedState());
  }, [commit]);

  const { conflicts, overridden } = useMemo(() => {
    const scope = state.shift.mode === 'design' ? 'design' : 'all';
    const raw = rawConflicts(state, scope);
    const off = new Set(state.overrides);
    return {
      conflicts: raw.filter((c) => !off.has(conflictKey(c))),
      overridden: raw.filter((c) => off.has(conflictKey(c))),
    };
  }, [state]);

  return {
    state, conflicts, overridden, log, say, run, setShift, jumpTo, reset, undo, redo,
    canUndo: depth.past > 0,
    canRedo: depth.future > 0,
    ref,
  };
}
