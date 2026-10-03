import type { ContextModule } from "../ContextModule";
import type { Object3DBehaviour } from "../Object3DBehaviour";
import type { LifecycleHook, ThreeContextEvents } from "../ThreeContext";

const LIFECYCLE_HOOKS: ReadonlySet<string> = new Set<LifecycleHook>([
	"onAwake",
	"onStart",
	"onEnable",
	"onDisable",
	"onDestroy",
	"onUpdate",
	"onBeforeRender",
	"onAfterRender",
]);

/**
 * @internal Call a lifecycle hook of a behaviour or module. If it throws, the error is
 * reported through the owner's ctx (`ThreeContextEvents.Error`) instead of propagating.
 */
export function callHook<T extends Object3DBehaviour | ContextModule>(
	source: T,
	hook: LifecycleHook & keyof T
): void {
	try {
		(source[hook] as unknown as () => void).call(source);
	} catch (error) {
		const ctx = source._ctx;
		if (ctx) ctx._reportError(error, source, hook);
		else logError(error, source, hook);
	}
}

/** @internal `console.error` fallback for an error nobody listens to. */
export function logError(
	error: unknown,
	source: Object3DBehaviour | ContextModule | null,
	hook: LifecycleHook | ThreeContextEvents
): void {
	const owner = source ? source.constructor.name : "";
	const where = LIFECYCLE_HOOKS.has(hook)
		? `${owner || "<unknown>"}.${hook}`
		: `A "${hook}" listener${owner ? ` of ${owner}` : ""}`;
	console.error(`[three-start] ${where} threw:`, error);
}
