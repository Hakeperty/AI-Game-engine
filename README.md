# AIGE — AI-native Game Engine

**Unity and Blender in one, designed so an AI can build games and 3D models by itself.**

AIGE is a TypeScript/Three.js game engine and procedural 3D modeler. Every action, whether it comes from a human in the editor, Claude over MCP, or a local model through Ollama, goes through one typed command bus. That bus gives you undo/redo, a replayable log, and auto-generated tool definitions. The AI can check its own work with screenshots, headless play-tests and type-checking.

> Status: **v0.1 in development.** See the roadmap below.

## Why it is AI-first
- **One command surface.** The editor UI, the MCP server and the in-editor agent all call the same tools.
- **Everything is text.** Scenes, prefabs and materials are canonical JSON. Models are TypeScript *recipes*. Game logic is TypeScript.
- **Closed feedback loop.** The AI can use:
  - multi-angle contact-sheet screenshots;
  - headless game runs with scripted input;
  - mesh validation;
  - TypeScript diagnostics.
- **Errors say how to fix them**, e.g. `Entity 'Playr' not found. Did you mean 'Player'?`
- **Works with Claude and local models.** Claude Code and Claude Desktop connect over MCP; the in-editor agent supports the Anthropic API and Ollama (OpenAI-compatible).

## Packages
| Package | What it does |
|---|---|
| `@aige/core` | Schemas, components, command bus (undo/redo, transactions, replay) |
| `@aige/modeling` | Procedural modeling kernel, booleans, SDF, UVs, glTF, recipes |
| `@aige/runtime` | World, behaviours, Rapier physics, input, audio, UI |
| `@aige/render` | Three.js renderer, contact sheets |
| `@aige/host` | Project host: IO, asset pipeline, headless runner, tool registry |
| `@aige/agent` | In-editor AI agent (Claude and Ollama) |
| `@aige/mcp` | MCP server for Claude Code and Claude Desktop |
| `apps/cli` | The `aige` command |
| `apps/editor` | Electron editor |

## Quick start
```bash
npm install
npm run check          # lint + typecheck + tests
```

## Roadmap (v0.1)
- [x] M0 Scaffold (monorepo, tooling, CI)
- [x] M1 Core (schemas, command bus, undo/redo, replay)
- [ ] M2 Modeling kernel + recipes
- [ ] M3 Rendering + headless screenshots
- [ ] M4 MCP server
- [ ] M5 Runtime (physics, scripting, headless play-tests)
- [ ] M6 Editor
- [ ] M7 In-editor agent (Claude and Ollama)
- [ ] M8 Modeling workspace + web export
- [ ] M9 Acceptance: an AI builds a 3D coin platformer from a single prompt

## License
MIT
