# Architecture

The bridge connects harness clients to a live Pi session over private files.

## Components

- `claude-bridge` is the Pi extension; `pi-bridge-mcp.js` is the shared harness client.
- `workflow-modes` owns plan state; `discussion-notes` owns notes.

## Data flow

- A client writes a request file; Pi claims it, runs it, and writes a processed answer and a response.
