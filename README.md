# AIGE — AI-native Game Engine

**Unity and Blender in one, designed so an AI can build games and 3D models by itself.**

AIGE is a TypeScript/Three.js game engine and procedural 3D modeler. Every action, whether it comes from a human in the editor, Claude over MCP, or a local model through Ollama, goes through one typed command bus. That bus gives you undo/redo, a replayable log, and auto-generated tool definitions. The AI can check its own work with screenshots, headless play-tests and type-checking.

![Sky Coins, a game built entirely through AIGE's AI tools](examples/coin-platformer/screenshots/web-build.png)

*[Sky Coins](examples/coin-platformer): a floating-island platformer built entirely through AIGE's tools. It includes a custom SDF island recipe, 12 coins, a hazard, a goal and a custom timer script. The AI play-tested it to a 12/12 win and exported it.*

## Why it is AI-first
- **One command surface.** The editor UI, the MCP server and the in-editor agent all call the same 46 tools.
- **Everything is text.**
  - Scenes, prefabs and materials are canonical JSON.
  - Models are TypeScript *recipes*: primitives, extrude, booleans, SDF sculpting.
  - Game logic is TypeScript.
- **Closed feedback loop.** The AI can use:
  - multi-angle contact-sheet screenshots;
  - headless play-tests with scripted input (score, errors, win/lose, trajectories, in-game screenshots);
  - mesh validation;
  - TypeScript diagnostics.
- **Errors say how to fix them**, e.g. `Entity 'Playr' not found. Did you mean 'Player'?`
- **Works with Claude and local models.**
  - Claude Code and Claude Desktop connect over MCP, and attach live to the running editor.
  - The in-editor agent supports the Anthropic API and Ollama.

## Getting started
Requires Node 24 or newer.

```bash
npm install
npx playwright-core install chromium-headless-shell   # headless renderer for screenshots and play-test captures
node apps/cli/bin/aige.mjs doctor                      # check GPU rendering + Ollama
node apps/cli/bin/aige.mjs editor                      # open the editor (built on first run)
```

### The editor
`aige editor` (or `npm run editor` for hot-reload development) opens an Electron editor with:
- **Viewport:** gizmos, focus, selection, play mode.
- **Hierarchy:** search, rename and drag-to-reparent.
- **Inspector:** fields generated from each component's schema.
- **Project assets:** model thumbnails.
- **Console**, a **Monaco script editor** with type-checked saves, and a **modeling workspace** (recipe editor, parameter sliders, live preview).
- **AI Assistant panel:** Claude or a local Ollama model, with tool-call cards, a plan checklist, approvals, a cost meter and "Undo AI turn".
- **Toolbar:** Screenshot, Play-test and Export buttons.

When the editor is running, `aige mcp` attaches to it automatically, so you watch Claude Code build your game live.

### Use it from Claude Code (MCP)
Inside this repo, the bundled `.mcp.json` registers the server automatically. Anywhere else, register it once:

```bash
claude mcp add aige -- node <path-to-repo>/apps/cli/bin/aige.mjs mcp
```

Then ask Claude something like *"Create an AIGE project called coin-quest and build a small 3D platformer where a fox collects coins on floating islands."* Projects go in `~/AigeProjects` (change it with `--workspace <dir>`).

**Claude Desktop:** add the same command to `claude_desktop_config.json` under `mcpServers`:

```json
{ "mcpServers": { "aige": { "command": "node", "args": ["<path-to-repo>/apps/cli/bin/aige.mjs", "mcp"] } } }
```

### Use it with a local model (Ollama) or the Claude API
Use the editor's AI Assistant panel, or run the agent headlessly:

```bash
aige agent "Build a coin platformer with 5 coins and a goal flag" -p my-game --provider ollama --model qwen3.8:27b
aige agent "Build a coin platformer with 5 coins and a goal flag" -p my-game --provider anthropic   # needs ANTHROPIC_API_KEY
```

See [`examples/coin-platformer-qwen`](examples/coin-platformer-qwen). A local `qwen3.8:27b` built that game autonomously, and it wins its play-test.

## CLI
```bash
aige new my-game                                  # scaffold a project
aige call model_from_template '{"template":"creature"}' -p my-game --out fox.png
aige screenshot -p my-game --views camera,iso --out shot.png
aige call game_run_headless '{"seconds":10,"inputs":[{"at":0,"axis":"move_y","value":1}]}' -p my-game
aige call export_web '{}' -p my-game              # playable build in my-game/dist/
aige tools                                        # list all tools
```

## How an AI builds a game
| Step | Tools |
|---|---|
| Inspect | `scene_tree`, `project_info`, `api_docs` |
| Model | `model_from_template` (23 templates, including organic creatures, plants and terrain), `model_create` (TypeScript recipes), `model_preview` |
| Build | `entity_create`, `batch`, `entity_duplicate`, `prefab_*`, `material_*`, `texture_generate` |
| Code | `script_write` (type-checked against the runtime API), built-in behaviours (PlayerController, FollowCamera, Collectible, Goal, Hazard…) |
| Verify | `render_screenshot`, `scene_validate`, `game_run_headless` |
| Ship | `export_web` (static build, smoke-tested in a headless browser) |

## Packages
| Package | What it does |
|---|---|
| `@aige/core` | Schemas, components, command bus (undo/redo, transactions, replay) |
| `@aige/modeling` | Procedural modeling: PolyMesh kernel, booleans (manifold-3d), SDF sculpting with a manifold mesher, sculpt brushes, terrain/plant generators, glTF, recipes, templates |
| `@aige/runtime` | World, Behaviour scripting API, Rapier physics + character controller, input, audio, HUD, built-ins, headless runner |
| `@aige/render` | Three.js scene renderer, textures, labeled contact sheets |
| `@aige/host` | Project host: IO, sandboxed recipe/script compilation, model cache, headless renderer, play-tests, web export, local API, tools |
| `@aige/agent` | AI agent loop with Anthropic and OpenAI-compatible (Ollama / LM Studio) providers |
| `@aige/mcp` | MCP server for Claude Code and Claude Desktop |
| `@aige/player` | Browser player for exported games |
| `apps/cli` | The `aige` command |
| `apps/editor` | Electron + React editor |

## Development
```bash
npm run check                          # biome + typecheck (TS 7) + 207 unit/integration tests
npm run test:render                    # headless GPU/SwiftShader render tests
node scripts/e2e-mcp.ts                # drive the MCP server over stdio like Claude Code
npm run build -w @aige/editor && node apps/editor/test/smoke.e2e.ts   # Electron end-to-end
```

## Roadmap (v0.1)
- [x] M0 Scaffold (monorepo, tooling, CI)
- [x] M1 Core (schemas, command bus, undo/redo, replay)
- [x] M2 Modeling kernel + recipes + templates (now 23, including organic SDF creatures and plants)
- [x] M3 Rendering + headless screenshots (GPU via ANGLE, SwiftShader fallback)
- [x] M4 MCP server + CLI
- [x] M5 Runtime (Rapier physics, scripting API, built-in behaviours, headless play-tests)
- [x] M6 Editor (Electron + React, live MCP attach)
- [x] M7 In-editor agent (Claude and Ollama) + chat panel
- [x] M8 Web export + modeling workspace
- [x] M9 Acceptance: [Sky Coins](examples/coin-platformer) built through AI tools, and [a game built by a local model](examples/coin-platformer-qwen)

**Next:** skeletal animation, particles, audio clips, a 2D module, nested prefabs, WebGPU, and packaged installers.

## License
MIT
