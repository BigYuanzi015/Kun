# QGIS MCP Plugin

A Claude Code compatible plugin for QGIS spatial analysis via MCP.

## Plugin Structure

```
qgis-mcp-plugin/
├── plugin.json          # Plugin manifest
├── commands/            # Custom slash commands
│   └── qgis-analyze.md  # /qgis-analyze command
├── skills/              # Skill packages
│   └── qgis-analysis/   # QGIS analysis skill
│       └── SKILL.md
├── mcp.json            # MCP server configuration
└── README.md
```

## Installation

1. Open Kun
2. Go to Settings → Plugins → "Plugins" tab
3. Click "Install from folder"
4. Select this directory
5. After installation, restart runtime

## Requirements

- Python 3.10+
- `uv` package manager
- QGIS desktop installed
- `qgis-mcp` project at `D:/qgis-mcp`
