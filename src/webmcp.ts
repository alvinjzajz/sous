// WebMCP registration (SOUS_PLAN.md §3), lifted from Fieldwork's pattern in
// SHOWCASE_TEARDOWN.md — the best of the three showcase apps.
//
// THE ONE RULE THAT MATTERS: register ONCE on mount, with an empty dep array. The
// implementations live behind a ref that every render refreshes, so a tool called an
// hour into the shift still sees current state without the effect ever re-running.
// Putting state in the deps would re-register 30 tools on every tick.
import { useEffect, useRef, useState } from 'react';
import type { Impl, ToolDef } from './tools.ts';

export interface Status {
  /** Did the browser offer a modelContext at all? */
  supported: boolean;
  registered: string[];
  errors: string[];
}

/** Chrome's documented ceilings (§12.1). check-tools.ts asserts them; this enforces. */
const MAX_OUTPUT = 1536;

/**
 * Validation at the trust boundary (§12.1). The schema is advisory — the executor is
 * where it is enforced — so this covers only what a schema can express, and every
 * domain rule (does the table exist, does the party fit, is it pinned) stays in
 * mutations.ts where both the button and the tool go through it.
 */
function validate(args: Record<string, unknown>, schema: ToolDef['inputSchema'], name: string): void {
  const props = schema.properties ?? {};
  for (const key of schema.required ?? []) {
    if (args[key] === undefined || args[key] === null) {
      throw new Error(`${name} needs ${key}.`);
    }
  }
  for (const [key, raw] of Object.entries(args)) {
    if (raw === undefined) continue;
    const spec = props[key];
    // additionalProperties:false is on every schema, but an agent can still send extra
    // keys and a permissive host may pass them through. Reject rather than ignore.
    if (!spec) throw new Error(`${name} has no ${key} parameter. It takes ${Object.keys(props).join(', ') || 'nothing'}.`);
    const type = spec.type as string;
    if (type === 'number') {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error(`${key} must be a number, not "${String(raw).slice(0, 40)}".`);
      if (typeof spec.minimum === 'number' && n < spec.minimum) throw new Error(`${key} must be at least ${spec.minimum}.`);
      if (typeof spec.maximum === 'number' && n > spec.maximum) throw new Error(`${key} must be at most ${spec.maximum}.`);
    }
    if (type === 'boolean' && typeof raw !== 'boolean') throw new Error(`${key} must be true or false.`);
    if (type === 'array' && !Array.isArray(raw)) throw new Error(`${key} must be a list.`);
    if (type === 'array' && Array.isArray(raw)) {
      if (typeof spec.maxItems === 'number' && raw.length > spec.maxItems) throw new Error(`${key} takes at most ${spec.maxItems}.`);
      if (typeof spec.minItems === 'number' && raw.length < spec.minItems) throw new Error(`${key} needs at least ${spec.minItems}.`);
    }
    if (type === 'string') {
      if (typeof raw === 'object') throw new Error(`${key} must be text.`);
      const v = String(raw);
      if (typeof spec.maxLength === 'number' && v.length > spec.maxLength) throw new Error(`${key} is longer than ${spec.maxLength} characters.`);
      if (Array.isArray(spec.enum) && !spec.enum.includes(v)) {
        throw new Error(`${key} must be one of ${(spec.enum as string[]).join(', ')}.`);
      }
    }
  }
}

/**
 * Whatever this browser offers, deduped. Presence does not change over the life of the
 * page, so it is safe to read once in a state initialiser rather than in the effect.
 */
function targets() {
  const mc = globalThis as unknown as {
    document?: { modelContext?: { registerTool?: unknown } };
    navigator?: { modelContext?: { registerTool?: unknown } };
  };
  return [mc.document?.modelContext, mc.navigator?.modelContext]
    .filter((m, i, a) => !!(m as { registerTool?: unknown })?.registerTool && a.indexOf(m) === i) as {
      registerTool: (t: unknown, o?: { signal: AbortSignal }) => Promise<void> | void;
    }[];
}

/**
 * Register every tool with whatever the browser offers, once.
 *
 * `impls` is read through a ref rather than a dependency, so App may rebuild the
 * implementation object on every render — it is cheap, and it is what keeps the closures
 * from going stale without re-registering.
 */
export function useWebMCP(defs: ToolDef[], impls: Record<string, Impl>): Status {
  const implRef = useRef(impls);
  // Refreshed after every render, the same way store.ts mirrors state. Not assigned
  // during render: a ref written mid-render is the bug the react lint rule is named for.
  useEffect(() => {
    implRef.current = impls;
  });
  const [status, setStatus] = useState<Status>(() => ({
    supported: targets().length > 0, registered: [], errors: [],
  }));

  useEffect(() => {
    const tools = defs.map((t) => {
      const inputSchema = { ...t.inputSchema, additionalProperties: false };
      // Fail safe: assume it mutates and assume its output is untrusted unless the
      // definition says otherwise. A mutating tool mislabelled readOnly is a security
      // defect, not a metadata typo (§12.1), so the default must be the careful one.
      const annotations = { readOnlyHint: false, untrustedContentHint: true, ...t.annotations };
      return {
        ...t,
        inputSchema,
        annotations,
        execute: async (args: Record<string, unknown> = {}) => {
          validate(args ?? {}, t.inputSchema, t.name);
          let text = implRef.current[t.name](args ?? {});
          if (text.length > MAX_OUTPUT) {
            text = `${text.slice(0, MAX_OUTPUT - 80)}\n… truncated. Narrow the question with a filter.`;
          }
          // Let React paint before the agent gets its result, so a person watching the
          // screen sees the change land before the model starts talking about it.
          if (!annotations.readOnlyHint) await new Promise((r) => setTimeout(r, 0));
          return { content: [{ type: 'text', text }] };
        },
      };
    });

    const ac = new AbortController();
    const registered: string[] = [];
    const errors: string[] = [];

    for (const target of targets()) {
      for (const tool of tools) {
        Promise.resolve()
          .then(() => target.registerTool(tool, { signal: ac.signal }))
          .then(() => {
            if (ac.signal.aborted || registered.includes(tool.name)) return;
            registered.push(tool.name);
            setStatus((s) => ({ ...s, registered: [...registered] }));
          })
          .catch((e: Error) => {
            if (ac.signal.aborted) return;
            errors.push(`${tool.name}: ${e.message}`);
            setStatus((s) => ({ ...s, errors: [...errors] }));
          });
      }
    }

    // The documented escape hatch (§12.2): read/write access to app state for anything
    // on the page. Fine for a demo with no real data, and the README says so out loud
    // rather than leaving it looking like an oversight.
    (globalThis as unknown as { __sous?: unknown }).__sous = {
      listTools: () => tools.map((t) => ({ name: t.name, description: t.description, annotations: t.annotations })),
      invoke: (name: string, args: Record<string, unknown> = {}) => {
        const def = defs.find((d) => d.name === name);
        if (!def) throw new Error(`There is no tool ${name}.`);
        validate(args, def.inputSchema, name);
        return implRef.current[name](args);
      },
    };

    return () => {
      ac.abort();
      delete (globalThis as unknown as { __sous?: unknown }).__sous;
    };
  }, [defs]);

  return status;
}
