import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// base "./" lets the build run from any sub-path (GitHub Pages project sites, Render, plain static hosts).
export default defineConfig({ base: "./", plugins: [svelte()] });
