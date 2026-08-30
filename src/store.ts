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
import { computeConflicts } from './conflicts.ts';
import { restore, snapshot } from './mutations.ts';
import type { Result, Snapshot } from './mutations.ts';
import { seedState } from './seed.ts';
import { advanceTo, tick } from './sim.ts';
import type { Conflict, Shift, SousState } from './types.ts';

/** Deep enough to reflow the whole room and take it back; short enough to stay cheap. */
const UNDO_CAP = 50;

// ponytail: undo is a whole-state snapshot, so it rewinds the board to the minute the
// edit was made — every tick since goes with it. Ceiling: undo an edit an hour of shift
// time later and you lose that hour of service; in a three-minute demo the gap is
// seconds, which is why SOUS_PLAN.md §5 chose snapshots. Upgrade is a per-mutation
// inverse (seatParty -> clearTable and so on) applied to the live state instead.

export interface Sous {
  state: SousState;
  conflicts: Conflict[];
  /** The ONLY path that pushes undo. Discards the draft whole if the mutation refuses. */
  run: <T>(fn: (draft: SousState) => Result<T>) => Result<T>;
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
  const [state, setState] = useState<SousState>(seedState);
  const ref = useRef<SousState>(state);
  const past = useRef<Snapshot[]>([]);
  const future = useRef<Snapshot[]>([]);
  const [depth, setDepth] = useState({ past: 0, future: 0 });

  useEffect(() => {
    ref.current = state;
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
    (fn) => {
      const before = snapshot(ref.current);
      const draft = structuredClone(ref.current);
      const result = fn(draft);
      if (!result.ok) return result; // nothing committed, nothing snapshotted
      past.current = [...past.current, before].slice(-UNDO_CAP);
      future.current = [];
      commit(draft);
      setDepth({ past: past.current.length, future: 0 });
      return result;
    },
    [commit],
  );

  const step = useCallback(
    (from: RefObject<Snapshot[]>, to: RefObject<Snapshot[]>) => {
      const target = from.current.pop();
      if (!target) return false;
      to.current.push(snapshot(ref.current));
      commit(restore(target, ref.current));
      setDepth({ past: past.current.length, future: future.current.length });
      return true;
    },
    [commit],
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
  const reset = useCallback(() => {
    past.current = [];
    future.current = [];
    setDepth({ past: 0, future: 0 });
    commit(seedState());
  }, [commit]);

  const conflicts = useMemo(
    () => computeConflicts(state, state.shift.mode === 'design' ? 'design' : 'all'),
    [state],
  );

  return {
    state, conflicts, run, setShift, jumpTo, reset, undo, redo,
    canUndo: depth.past > 0,
    canRedo: depth.future > 0,
    ref,
  };
}
