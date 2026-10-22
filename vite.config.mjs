import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// base "./" lets the build run from any sub-path (GitHub Pages project sites, Render, plain static hosts).
// `npm start` serves dist/ (used when the site runs as a Render Web Service; a Render Static Site does not need it).
export default defineConfig({
  base: "./",
  plugins: [svelte()],
  preview: { host: "0.0.0.0", port: Number(process.env.PORT) || 4173, allowedHosts: true },
});