import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

process.env.BROWSERSLIST_IGNORE_OLD_DATA ??= "1";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const viteEnvModulePath = path.resolve(__dirname, "node_modules", "vite", "dist", "client", "env.mjs");

function shouldPatchViteEnv(value) {
  const id = String(value ?? "");
  return id.includes("vite/dist/client/env.mjs") || id.includes("@vite/env");
}

function patchViteEnvDefines(code) {
  return code.replace(/__DEFINES__/g, "{}");
}

function fixViteEnvDefines() {
  return {
    name: "fix-vite-env-defines",
    enforce: "pre",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!shouldPatchViteEnv(req.url)) {
          next();
          return;
        }

        let code = fs.readFileSync(viteEnvModulePath, "utf8");
        if (code.includes("__DEFINES__")) {
          code = patchViteEnvDefines(code);
        }

        res.statusCode = 200;
        res.setHeader("Content-Type", "application/javascript");
        res.end(code);
      });
    },
    transform(code, id) {
      if (shouldPatchViteEnv(id) && code.includes("__DEFINES__")) {
        return patchViteEnvDefines(code);
      }
      return null;
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  publicDir: "static",
  server: {
    host: "127.0.0.1",
    // Keep the dev server on Tauri's usual port to avoid common clashes on 8080
    // causing the desktop shell to point at the wrong server (or nothing at all).
    port: 1420,
    strictPort: true,
    hmr: {
      overlay: false,
    },
  },
  plugins: [fixViteEnvDefines(), react()].filter(Boolean),
  define: {
    __DEFINES__: {},
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("@tauri-apps")) return "tauri";
          if (id.includes("framer-motion")) return "motion";
          if (id.includes("@radix-ui")) return "radix";
          if (id.includes("react-router")) return "router";
          return "vendor";
        },
      },
    },
  },
}));
