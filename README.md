# sticker-mcp

An MCP Server that allows AI to send expressive stickers based on conversation context, with a built-in MCP App UI for sticker management.

## Features

- **Built-in UI**: Manage your stickers directly from compatible MCP clients (like Claude Desktop) using MCP Apps.
- **AI Contextual Stickers**: AI can evaluate the conversation and pick the most appropriate sticker based on emotions/tags.
- **Simple Storage**: Uses local JSON and filesystem storage. No database required.

## Installation

1. Clone this repository
2. Run `npm install`
3. Run `npm run build` to build the UI
4. Add to your MCP client configuration

### Claude Desktop Configuration

Add the following to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "sticker": {
      "command": "node",
      "args": [
        "path/to/sticker-mcp/node_modules/tsx/dist/cli.mjs",
        "path/to/sticker-mcp/src/index.ts"
      ]
    }
  }
}
```

## Usage

Once installed, the AI will have access to the `send_sticker` tool.
You can open the "Sticker Admin UI" from your client to upload images and assign them emotions or tags (e.g., "happy", "confused", "dog").

When the AI uses the `send_sticker` tool, it will return the sticker image directly in the chat.
