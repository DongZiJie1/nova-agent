<p align="center">
  <img src="assets/nova.png" alt="Nova" width="100%" />
</p>
<p align="center">
  <a href="https://www.npmjs.com/package/@dongzijie1/nova"><img alt="npm" src="https://img.shields.io/npm/v/@dongzijie1/nova?style=flat-square" /></a>
  <a href="https://github.com/DongZiJie1/pi-mutant/blob/main/LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" /></a>
</p>

<p align="center">
  <a href="./README.zh-CN.md">中文文档</a>
</p>

# Nova - AI Coding Agent

Nova is an open-source AI coding agent that supports multiple LLM providers (OpenAI, Anthropic, Google, DeepSeek, etc.), providing an interactive terminal interface with built-in tools for code reading, writing, execution, and search.

## Installation

```bash
npm install -g @dongzijie1/nova
```

## Usage

```bash
# Interactive mode
nova

# Non-interactive mode (process and exit)
nova -p "List all .ts files in the current directory"

# Use a specific model
nova --model openai/gpt-4o "Help me refactor this code"

# Continue previous session
nova --continue
```

## Features

- **Multi-model support** — OpenAI, Anthropic, Google Gemini, DeepSeek, Groq, and more
- **Built-in tools** — File read/write, code editing, Bash execution, content search
- **Session management** — Auto-save sessions, resume and fork support
- **Extension system** — Customize tools and behavior via TypeScript extensions
- **RPC mode** — JSON-RPC protocol support for Web frontend integration

## Project Structure

```
packages/
  ai/              - Unified LLM API with multi-provider support
  agent/           - Agent core, tool calling and state management
  nova/            - Main CLI app (the nova command)
  tui/             - Terminal UI library
  server/          - Multi-instance server
  evals/           - LLM quality evaluation suite
  storage/
    sqlite-node/   - Session storage
```

## Development

```bash
npm install --ignore-scripts
npm run build
npm run check
./test.sh
./pi-test.sh         # Run from source
```

## Roadmap

- [ ] Multi-agent orchestration — Spawn sub-agents with independent contexts and tool sets for parallel task execution
- [ ] Visual web interface — A modern web UI for conversation, code diff viewing, and session management via RPC mode
- [ ] Web search tool — Real-time information retrieval during coding sessions
- [ ] More built-in tools — HTTP requests, Git enhancements, data processing, and more

## Acknowledgments

Nova is forked from [Pi Agent](https://github.com/earendil-works/pi) by Earendil Works. We are grateful for their excellent work in building the original coding agent harness.

## License

MIT
