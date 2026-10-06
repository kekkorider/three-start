import * as THREE from "three/webgpu";
import { createReadonlyView, defineProps, readOnly } from "./utils/define-props";
import { pass } from "three/tsl";
import type { ContextModule, ThreeStartModules } from "./ContextModule";
import type { Object3DBehaviour } from "./Object3DBehaviour";
import type { ThreeStartOptions } from "./ThreeStart";
import { type ListenerErrorHandler, TypedEmitter } from "./TypedEmitter";
import { logError } from "./utils/lifecycle-errors";

// three-start

/**
 * The shared runtime of a [`ThreeStart`](/docs/api/three-start) instance — renderer,
 * active scene, camera, animation loop, timer, render pipeline, event bus, and
 * [`ContextModule`](/docs/api/context-module) registry. Exposed to every
 * [`Object3DBehaviour`](/docs/api/object3d-behaviour) and module as `this.ctx`.
 */
export class ThreeContext extends TypedEmitter<ThreeContextEventMap> {
	public readonly isThreeContext!: true;

	/** The Three.js renderer owned by this context. Sealed at construction. */
	public readonly renderer!: THREE.Renderer;

	/**
	 * The scene currently being rendered. Always the active scene of the owning
	 * [`ThreeStart`](/docs/api/three-start). Reassigning throws — switch with
	 * [`setScene`](/docs/api/three-start).
	 */
	get scene(): THREE.Scene {
		return this._scene;
	}

	/** The render pipeline used by the default render function. Sealed at construction. */
	public readonly renderPipeline!: THREE.RenderPipeline;

	/** The scene pass node fed into `renderPipeline`. Bound to the active scene and camera; attach post-processing effects to it via TSL. */
	public readonly scenePass!: THREE.PassNode;

	/** Registered [`ContextModule`](/docs/api/context-module) instances, keyed by name. Read-only at runtime — mutations throw. Populate via `starter.addModules()` before `start()`. */
	public readonly modules!: ThreeStartModules;

	/** @internal Backing store for `modules`. `_registerModule` is the only way to add to it. */
	private readonly _modules: Record<string, ContextModule> = {};

	/**
	 * The active camera, typed as perspective for the common case. Reassigning it swaps the
	 * camera used by the active scene's pass and fires `CameraChanged`. Each registered scene
	 * keeps its own camera — this assignment updates only the scene currently in `scene`.
	 * If an orthographic camera is active, this returns it too: check `isOrtho` and use
	 * `ortho` in orthographic scenes.
	 */
	public get camera(): THREE.PerspectiveCamera {
		return this._camera as THREE.PerspectiveCamera;
	}
	public set camera(value: THREE.PerspectiveCamera) {
		this.setCamera(value);
	}

	/** The active camera typed as orthographic — `camera` for orthographic scenes. Same camera, same setter semantics. */
	public get ortho(): THREE.OrthographicCamera {
		return this._camera as THREE.OrthographicCamera;
	}
	public set ortho(value: THREE.OrthographicCamera) {
		this.setCamera(value);
	}

	/** `true` when the active camera is orthographic — then read it through `ortho`, otherwise through `camera`. */
	public get isOrtho(): boolean {
		return !!(this._camera as THREE.OrthographicCamera).isOrthographicCamera;
	}

	/** The HTML element the renderer canvas is currently mounted into, or `null` if not mounted. */
	public get canvasContainer(): HTMLDivElement | null {
		return this._canvasContainer;
	}

	/** `true` while the renderer canvas is attached to a container (between `mount()` and `unmount()`). */
	public get isMounted(): boolean {
		return this._isMounted;
	}

	/** `true` while the animation loop is running (between `runLoop()` and `stopLoop()`). */
	public get isLoopRunning(): boolean {
		return this._isLoopRunning;
	}

	/**
	 * @internal While `true`, `Object3DExtension.addComponent` defers component
	 * activation. Set by `ThreeStart.start()` during module bootstrap so that
	 * components created inside a module's `onAwake`/`onStart` don't subscribe
	 * to ctx events before modules themselves subscribe.
	 */
	_isBootstrapping = false;

	private readonly _timer: THREE.Timer;
	private _scene: THREE.Scene;
	private _camera: ThreeStartCamera;
	/** Per-scene camera. The active scene's entry is kept in sync by `setCamera`. */
	private readonly _sceneCameras = new Map<THREE.Scene, ThreeStartCamera>();
	private _canvasContainer: HTMLDivElement | null = null;
	private _resizeObserver: ResizeObserver | null = null;
	private _isMounted = false;
	private _isLoopRunning = false;

	/** Seconds elapsed since the previous tick, scaled by `timescale`. Use inside per-frame methods. */
	getDeltaTime = () => this._timer.getDelta();

	/** Total elapsed time in seconds since the loop started, scaled by `timescale`. */
	getTime = () => this._timer.getElapsed();

	/** Current time-scaling factor. `1` = realtime, `0` = paused, `2` = 2× speed. */
	getTimescale = () => this._timer.getTimescale();

	/** Change the time-scaling factor applied to `getDeltaTime` / `getTime`. `1` = realtime, `0` = paused. */
	setTimescale = (value: number): this => {
		this._timer.setTimescale(value);
		return this;
	};

	private _srcRenderFn = () => {
		if (!this.renderer.initialized) return;
		this.renderPipeline.render();
	};
	private _renderFn = this._srcRenderFn;

	constructor(readonly options: ThreeStartOptions) {
		super();

		const renderer =
			options.renderer ?? new THREE.WebGPURenderer({ antialias: true });
		if (options.autoInitRenderer ?? true) {
			renderer.init();
		}
		this._timer = new THREE.Timer();
		this._scene = options.scene ?? new THREE.Scene();
		this._camera = options.camera ?? new THREE.PerspectiveCamera();
		if (!this._camera.parent) {
			this._scene.add(this._camera);
		}
		this._sceneCameras.set(this._scene, this._camera);
		const scenePass = pass(this._scene, this._camera);
		const renderPipeline = new THREE.RenderPipeline(renderer, scenePass);

		defineProps(this, {
			isThreeContext: readOnly(true),
			modules: readOnly(createReadonlyView(this._modules, "ctx.modules")),
			renderer: readOnly(renderer),
			scenePass: readOnly(scenePass),
			renderPipeline: readOnly(renderPipeline),
		});
	}

	/** @internal Register a module. Called by `ThreeStart.addModules()` before `start()`. Returns `false` if the key already exists. */
	_registerModule(key: string, instance: ContextModule): boolean {
		if (this._modules[key]) return false;
		this._modules[key] = instance;
		return true;
	}

	/** @internal Record a scene's camera. Called by `ThreeStart.addScene()`. */
	_registerScene(scene: THREE.Scene, camera: ThreeStartCamera): void {
		this._sceneCameras.set(scene, camera);
	}

	/** @internal Camera last associated with `scene` via `addScene` or `ctx.camera =`. */
	_cameraForScene(scene: THREE.Scene): ThreeStartCamera | undefined {
		return this._sceneCameras.get(scene);
	}

	/** @internal Scene that already owns `camera`, if any. */
	_sceneForCamera(camera: ThreeStartCamera): THREE.Scene | undefined {
		for (const [scene, cam] of this._sceneCameras) {
			if (cam === camera) return scene;
		}
		return undefined;
	}

	/**
	 * @internal Point the render pipeline at `scene` / `camera`. Does not fire events
	 * or render — `ThreeStart.setScene()` does that after lifecycle.
	 */
	_bindScene(scene: THREE.Scene, camera: ThreeStartCamera): void {
		this._scene = scene;
		this._camera = camera;
		this.scenePass.scene = scene;
		this.scenePass.camera = camera;
		if (!camera.parent) scene.add(camera);

		const root = this._canvasContainer;
		if (root) {
			fitCameraToAspect(camera, root.offsetWidth / root.offsetHeight);
		} else {
			camera.updateProjectionMatrix();
		}
	}

	/**
	 * @internal `CameraChanged` then `SceneChanged`, then a redraw. Called by
	 * `ThreeStart.setScene()` after the new scene's components are running.
	 */
	_notifySceneChanged(
		newScene: THREE.Scene,
		prevScene: THREE.Scene,
		newCamera: ThreeStartCamera,
		prevCamera: ThreeStartCamera
	): void {
		this._emitIsolated(
			ThreeContextEvents.CameraChanged,
			this._onListenerError,
			newCamera as THREE.PerspectiveCamera,
			prevCamera as THREE.PerspectiveCamera
		);
		this._emitIsolated(
			ThreeContextEvents.SceneChanged,
			this._onListenerError,
			newScene,
			prevScene
		);
		this.render();
	}

	/**
	 * @internal Use `starter.mount(container)` instead.
	 * Appends the renderer canvas, initializes event listeners and resize observer, fires `Mount`.
	 */
	mount = (container: HTMLDivElement): void => {
		if (this._isMounted) return;
		this._isMounted = true;

		const canvas = this.renderer.domElement;

		this._canvasContainer = container;
		container.append(canvas);
		// Focusable so the canvas can receive keyboard events, and never ringed:
		// the focus outline would frame the whole scene once focus returns to it.
		canvas.tabIndex = 0;
		canvas.style.outline = "none";
		canvas.style.touchAction = "none";

		this._emitIsolated(ThreeContextEvents.Mount, this._onListenerError, container);

		this._resizeObserver = new ResizeObserver(this.resizeHandler);
		this._resizeObserver.observe(container);
		this.resizeHandler();

		if (!this.options.manageLoopManually) {
			this.runLoop();
		}
	};

	/**
	 * @internal Use `starter.unmount()` instead.
	 * Removes the canvas from DOM, disconnects the resize observer, fires `Unmount`.
	 */
	unmount = (): void => {
		if (!this._isMounted) return;
		this._isMounted = false;

		this._resizeObserver?.disconnect();
		this._resizeObserver = null;
		this.renderer.domElement.remove();

		this._emitIsolated(ThreeContextEvents.Unmount, this._onListenerError);

		if (!this.options.manageLoopManually) {
			this.stopLoop();
		}
	};

	/**
	 * @internal Use `starter.runLoop()` instead.
	 * Starts the render loop; re-runnable after `stopLoop()`.
	 */
	runLoop = (): void => {
		if (this._isLoopRunning) return;
		this._isLoopRunning = true;

		this._timer.connect(document);
		// Reset on start, not on stop: the first tick then measures from this call,
		// so time spent with the loop stopped never lands in `getDeltaTime()`.
		this._timer.reset();
		let isFirstTick = true;

		this.renderer.setAnimationLoop((timestamp) => {
			// `reset()` reads `performance.now()`, while a rAF timestamp is the frame's
			// vsync and may predate this call — the first tick uses the same clock so
			// its delta can't go negative.
			this._timer.update(isFirstTick ? undefined : timestamp);
			isFirstTick = false;
			this._emitIsolated(ThreeContextEvents.Update, this._onListenerError);
			this.render();
		});
		this._emitIsolated(ThreeContextEvents.LoopRun, this._onListenerError);
	};

	/**
	 * @internal Use `starter.stopLoop()` instead.
	 * Stops the render loop; resumable via `runLoop()`.
	 */
	stopLoop = (): void => {
		if (!this._isLoopRunning) return;
		this._isLoopRunning = false;

		this._timer.disconnect();

		this.renderer.setAnimationLoop(null);
		this._emitIsolated(ThreeContextEvents.LoopStop, this._onListenerError);
	};

	/**
	 * @internal Use `starter.dispose()` instead.
	 * Tears down the context: unmount, stop loop, dispose renderer and timer.
	 */
	dispose = (): void => {
		this.unmount();
		this.stopLoop();
		this.renderer.dispose();
		this._removeAllListeners();
		this._timer.disconnect();
		this._timer.dispose();
	};

	/** Render once using the current render function. Fires `RenderBefore` / `RenderAfter`. */
	render = (): void => {
		this._emitIsolated(ThreeContextEvents.RenderBefore, this._onListenerError);
		this._renderFn();
		this._emitIsolated(ThreeContextEvents.RenderAfter, this._onListenerError);
	};

	/** Replace the render function with a custom implementation. Restore via `resetRender()`. */
	overrideRender = (fn: () => void): this => {
		this._renderFn = fn;
		return this;
	};

	/** Restore the default render function (undoes `overrideRender`). */
	resetRender = (): this => {
		this._renderFn = this._srcRenderFn;
		return this;
	};

	/**
	 * @internal Report an error thrown by user code: fires `Error`, or logs it with
	 * `console.error` when nobody listens. Never throws.
	 */
	_reportError(
		error: unknown,
		source: Object3DBehaviour | ContextModule | null,
		hook: LifecycleHook | ThreeContextEvents
	): void {
		const heard = this._emitIsolated(
			ThreeContextEvents.Error,
			logErrorListenerFailure,
			error,
			source,
			hook
		);
		if (!heard) logError(error, source, hook);
	}

	/** Attributes a throwing ctx listener to its behaviour/module, then reports it. */
	private _onListenerError: ListenerErrorHandler = (error, event, fn, context) => {
		const frameHook = FRAME_HOOKS[event as ThreeContextEvents];
		const owner = context as Partial<Record<LifecycleHook, unknown>> | null;
		if (frameHook && owner?.[frameHook] === fn) {
			this._reportError(
				error,
				owner as Object3DBehaviour | ContextModule,
				frameHook
			);
			return;
		}
		this._reportError(
			error,
			this._asErrorSource(context),
			event as ThreeContextEvents
		);
	};

	/** The behaviour or registered module a listener was bound to, if any. Error path only. */
	private _asErrorSource(context: unknown): Object3DBehaviour | ContextModule | null {
		if ((context as Object3DBehaviour | null)?.isObject3DBehaviour === true) {
			return context as Object3DBehaviour;
		}
		const modules = Object.values(this._modules);
		return modules.includes(context as ContextModule)
			? (context as ContextModule)
			: null;
	}

	private resizeHandler = () => {
		const container = this._canvasContainer;
		if (!container) return;

		const width = container.offsetWidth;
		const height = container.offsetHeight;

		fitCameraToAspect(this._camera, width / height);

		this.renderer.setSize(width, height);
		this._emitIsolated(
			ThreeContextEvents.Resized,
			this._onListenerError,
			width,
			height
		);
		this.render();
	};

	private setCamera(newCamera: ThreeStartCamera) {
		const prevCamera = this._camera;
		this._camera = newCamera;
		this._sceneCameras.set(this._scene, newCamera);
		// Rebind the scene pass to the new camera so the render pipeline picks it up.
		this.scenePass.camera = newCamera;
		// Attach to the scene if the camera is floating (matches constructor behaviour).
		if (!newCamera.parent) this.scene.add(newCamera);

		const root = this._canvasContainer;
		if (root) {
			fitCameraToAspect(newCamera, root.offsetWidth / root.offsetHeight);
		} else {
			newCamera.updateProjectionMatrix();
		}

		// Typed as perspective for the listeners' convenience, like `ctx.camera`.
		this._emitIsolated(
			ThreeContextEvents.CameraChanged,
			this._onListenerError,
			newCamera as THREE.PerspectiveCamera,
			prevCamera as THREE.PerspectiveCamera
		);
		this.render();
	}
}

/** A camera `ThreeContext` can render with. */
export type ThreeStartCamera = THREE.PerspectiveCamera | THREE.OrthographicCamera;

/**
 * Perspective: sets `aspect`. Orthographic: keeps the vertical extent and the center,
 * widens or narrows `left`/`right` to the aspect so the image isn't stretched.
 */
function fitCameraToAspect(camera: ThreeStartCamera, aspect: number) {
	if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
		const ortho = camera as THREE.OrthographicCamera;
		const halfWidth = ((ortho.top - ortho.bottom) / 2) * aspect;
		const centerX = (ortho.left + ortho.right) / 2;
		ortho.left = centerX - halfWidth;
		ortho.right = centerX + halfWidth;
	} else {
		(camera as THREE.PerspectiveCamera).aspect = aspect;
	}
	camera.updateProjectionMatrix();
}

export enum ThreeContextEvents {
	/** Fired once per animation frame, before `RenderBefore` and rendering. Driver of all per-frame logic. */
	Update = "update",
	/** Fired once per animation frame, just before the scene is rendered. Use to mutate state right before draw. */
	RenderBefore = "renderbefore",
	/** Fired once per animation frame, immediately after the scene is rendered. */
	RenderAfter = "renderafter",
	/** Fired when `starter.mount(container)` succeeds. Carries the container element. */
	Mount = "mount",
	/** Fired when `starter.unmount()` runs. */
	Unmount = "unmount",
	/** Fired when `ctx.camera` is reassigned, including when `starter.setScene()` restores a scene's camera. Carries the new and previous cameras. */
	CameraChanged = "camerachanged",
	/** Fired when `starter.setScene()` switches the active scene. Carries the new and previous scenes. */
	SceneChanged = "scenechanged",
	/** Fired when the canvas container resizes (and once on first mount). Carries the new pixel dimensions. */
	Resized = "resized",
	/** Fired when `starter.runLoop()` starts the animation loop. */
	LoopRun = "looprun",
	/** Fired when `starter.stopLoop()` halts the animation loop. */
	LoopStop = "loopstop",
	/**
	 * Fired when user code throws: a lifecycle method of a behaviour or module, or a listener
	 * of another ctx event. Carries the error, the behaviour/module (or `null`) and the method
	 * or event name. The failed call is skipped, everything else keeps running. Without a
	 * listener the error goes to `console.error`.
	 */
	Error = "error",
}

export type ThreeContextEventMap = {
	[ThreeContextEvents.Update]: [];
	[ThreeContextEvents.RenderBefore]: [];
	[ThreeContextEvents.RenderAfter]: [];
	[ThreeContextEvents.Mount]: [root: HTMLDivElement];
	[ThreeContextEvents.Unmount]: [];
	[ThreeContextEvents.Resized]: [width: number, height: number];
	[ThreeContextEvents.CameraChanged]: [
		newCamera: THREE.PerspectiveCamera,
		prevCamera: THREE.PerspectiveCamera,
	];
	[ThreeContextEvents.SceneChanged]: [
		newScene: THREE.Scene,
		prevScene: THREE.Scene,
	];
	[ThreeContextEvents.LoopRun]: [];
	[ThreeContextEvents.LoopStop]: [];
	[ThreeContextEvents.Error]: [
		error: unknown,
		source: Object3DBehaviour | ContextModule | null,
		hook: LifecycleHook | ThreeContextEvents,
	];
};

/** Lifecycle methods three-start calls on an [`Object3DBehaviour`](/docs/api/object3d-behaviour) or a [`ContextModule`](/docs/api/context-module). */
export type LifecycleHook =
	| "onAwake"
	| "onStart"
	| "onEnable"
	| "onDisable"
	| "onDestroy"
	| "onUpdate"
	| "onBeforeRender"
	| "onAfterRender";

/** Per-frame events and the lifecycle method subscribed to each. */
const FRAME_HOOKS: Partial<Record<ThreeContextEvents, LifecycleHook>> = {
	[ThreeContextEvents.Update]: "onUpdate",
	[ThreeContextEvents.RenderBefore]: "onBeforeRender",
	[ThreeContextEvents.RenderAfter]: "onAfterRender",
};

/** An `Error` listener that throws is logged, never re-reported (no recursion). */
const logErrorListenerFailure: ListenerErrorHandler = (error) =>
	logError(error, null, ThreeContextEvents.Error);
