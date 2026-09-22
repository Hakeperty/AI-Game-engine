# AIGE: notes for AI agents working on the engine itself

AIGE is an AI-native game engine and 3D modeler (TypeScript, Three.js). This file is for agents **developing the engine**. Agents **using** the engine to make games should read `docs/ai/` or the `aige://docs/*` MCP resources.

## Layout
- `packages/core`: isomorphic (no DOM, no Node). Zod schemas, component registry, `CommandBus` (undo/redo, transactions, replay log), canonical JSON.
- `packages/modeling`: isomorphic procedural modeling kernel (PolyMesh, ops, booleans via manifold-3d, SDF, UVs, glTF IO, recipes, templates).
- `packages/runtime`: game runtime (World, Behaviour lifecycle, Rapier physics, input, audio, UI). It runs headless in Node and in the browser.
- `packages/render`: browser-only Three.js renderer, camera presets, contact sheets.
- `packages/host`: Node `ProjectHost`, the authority. It handles project IO, asset pipeline, sandbox, headless runner, render backends and the full tool registry.
- `packages/agent`: in-editor agent. Anthropic provider (official SDK) plus an OpenAI-compatible provider for Ollama and LM Studio.
- `packages/mcp`: MCP server adapter over the tool registry.
- `apps/cli`: the `aige` command (`new`, `mcp`, `run`, `screenshot`, `build-web`, `replay`).
- `apps/editor`: Electron + React editor.

## Conventions
- **Source-first packages.** Each `package.json` exports `./src/index.ts`. Node 24 runs `.ts` directly through type stripping, so there is no build step for Node code. Only the editor renderer and web exports are bundled.
- **Erasable TypeScript only** (`erasableSyntaxOnly`). No enums, no parameter properties, no namespaces. Relative imports use the `.ts` extension.
- **All state changes go through commands** (`defineCommand`). Never mutate `ProjectState` directly. Use `ctx.update(draft => ...)` and `ctx.writeFile(...)` so undo, replay and live replicas keep working.
- **Command descriptions are prompts.** Write them for an AI reader and include one `Example: {...}` input. Errors should be `AigeError` with a `hint` that says how to fix the problem.
- **Tool input schemas** stay flat. Use `[x,y,z]` tuples and `'#rrggbb'` colors, and give every optional field a default. Use `patchOf(schema)` for partial updates (zod's `.partial()` fills in defaults).
- **Files AIGE writes** go through `canonicalJson`.

## Commands
- `npm run check` runs Biome, type-checking (TS 7, one `tsc -p` per package) and vitest.
- `npm run format` applies Biome fixes.
- `npm run aige -- <args>` runs the CLI from source.
