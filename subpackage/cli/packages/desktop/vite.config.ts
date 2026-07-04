import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [tailwindcss()],
	// Tailwind v4 is handled by `@tailwindcss/vite` and does not use PostCSS.
	// Vite auto-discovers PostCSS config by walking up the file tree, which
	// on monorepo CI builds hits the repo-root postcss.config.mjs (Tailwind v3)
	// and fails to load `tailwindcss` from this package's node_modules. Disable
	// discovery so the v4 pipeline is the only CSS path.
	css: {
		postcss: {},
	},
	clearScreen: false,
	server: {
		port: 1420,
		strictPort: true,
		watch: {
			ignored: ["**/src-tauri/**"],
		},
	},
});
