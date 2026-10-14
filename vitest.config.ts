import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

// Tests run inside a real Chromium: WebGPU, requestAnimationFrame and canvas don't exist in Node.
// Standalone on purpose — vite.config.ts carries the TanStack Start site plugins.
export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
		browser: {
			enabled: true,
			headless: true,
			provider: playwright({
				launchOptions: { args: ["--enable-unsafe-webgpu", "--enable-gpu"] },
			}),
			instances: [{ browser: "chromium" }],
		},
		// Integration tests measure real frames for a second or two each.
		testTimeout: 30_000,
		// One file at a time: each runs in its own iframe, and a background one gets no rAF.
		fileParallelism: false,
	},
});
