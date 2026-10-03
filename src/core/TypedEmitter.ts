import EventEmitter from "eventemitter3";

/**
 * Shape used to describe typed events: `{ eventName: [arg1, arg2, ...] }`.
 * Args are always a tuple — use `[]` for events with no payload.
 */
export type EventMap = Record<PropertyKey, any[]>;

/**
 * Minimal typed event emitter — exposes only `on`/`off`/`once` publicly,
 * keeps `emit` as `protected` so only the owning class can fire its own events.
 *
 * The inner `eventemitter3` instance is allocated lazily on the first `on`/`once`,
 * so classes that extend `TypedEmitter` but never get a subscriber cost only
 * one reference slot per instance.
 */
export class TypedEmitter<T extends EventMap = {}> {
	private _ee?: EventEmitter;

	on<K extends keyof T & (string | symbol)>(
		event: K,
		fn: (...args: T[K]) => void,
		context?: any,
	): this {
		(this._ee ??= new EventEmitter()).on(event as any, fn as any, context);
		return this;
	}

	once<K extends keyof T & (string | symbol)>(
		event: K,
		fn: (...args: T[K]) => void,
		context?: any,
	): this {
		(this._ee ??= new EventEmitter()).once(event as any, fn as any, context);
		return this;
	}

	off<K extends keyof T & (string | symbol)>(
		event: K,
		fn?: (...args: T[K]) => void,
		context?: any,
		once?: boolean,
	): this {
		this._ee?.off(event as any, fn as any, context, once);
		return this;
	}

	protected emit<K extends keyof T & (string | symbol)>(
		event: K,
		...args: T[K]
	): boolean {
		return this._ee?.emit(event as any, ...args) ?? false;
	}

	/**
	 * @internal Like `emit`, but a listener that throws is handed to `onError` and the
	 * rest still run. Args are positional (up to three), so a dispatch allocates nothing.
	 * Walks eventemitter3's listener storage the same way its own `emit` does.
	 */
	protected _emitIsolated<K extends keyof T & (string | symbol)>(
		event: K,
		onError: ListenerErrorHandler,
		a?: T[K][0],
		b?: T[K][1],
		c?: T[K][2]
	): boolean {
		const ee = this._ee as InternalEmitter | undefined;
		if (!ee) return false;
		const slot = ee._events[EE_PREFIX ? EE_PREFIX + (event as string) : event];
		if (!slot) return false;

		// Forward exactly as many args as the caller passed, like eventemitter3 does.
		// biome-ignore lint/complexity/noArguments: arity read only, `arguments` is never materialized.
		const argc = arguments.length - 2;
		if (Array.isArray(slot)) {
			// Removal rebuilds the array and additions append past the cached length, so
			// listeners added or removed mid-dispatch don't affect this pass.
			for (let i = 0, n = slot.length; i < n; i++) {
				callListener(ee, event, slot[i], onError, argc, a, b, c);
			}
		} else {
			callListener(ee, event, slot, onError, argc, a, b, c);
		}
		return true;
	}

	/** @internal */
	_removeAllListeners(): void {
		this._ee?.removeAllListeners();
	}
}

/** @internal Receives a listener that threw during an isolated emit. */
export type ListenerErrorHandler = (
	error: unknown,
	event: string | symbol,
	fn: (...args: unknown[]) => unknown,
	context: unknown
) => void;

/** eventemitter3 listener record (`EE` in its source). */
interface Listener {
	fn: (...args: unknown[]) => unknown;
	context: unknown;
	once: boolean;
}

/** eventemitter3 keeps one record per event, or an array once there are several. */
type InternalEmitter = EventEmitter & {
	_events: Record<string | symbol, Listener | Listener[] | undefined>;
};

const EE_PREFIX = EventEmitter.prefixed as string | false;

function callListener(
	ee: InternalEmitter,
	event: string | symbol,
	l: Listener,
	onError: ListenerErrorHandler,
	argc: number,
	a: unknown,
	b: unknown,
	c: unknown
) {
	if (l.once) ee.removeListener(event, l.fn, undefined, true);
	try {
		switch (argc) {
			case 0:
				l.fn.call(l.context);
				break;
			case 1:
				l.fn.call(l.context, a);
				break;
			case 2:
				l.fn.call(l.context, a, b);
				break;
			default:
				l.fn.call(l.context, a, b, c);
		}
	} catch (error) {
		onError(error, event, l.fn, l.context);
	}
}
