
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buffer += d;
  let idx;
  while ((idx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    respond(msg);
  }
});

function respond(msg) {
  if (!msg || msg.id === undefined) return;
  let result = {};
  if (msg.method === "initialize") {
    result = {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "fake", version: "1.0.0" },
    };
  } else if (msg.method === "tools/list") {
    result = {
      tools: [
        {
          name: "echo",
          description: "Echo back text",
          inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        },
        { name: "fail", description: "Always errors", inputSchema: { type: "object", properties: {} } },
      ],
    };
  } else if (msg.method === "tools/call") {
    if (msg.params?.name === "echo") {
      result = { content: [{ type: "text", text: `echo:${msg.params.arguments?.text}` }] };
    } else {
      result = { content: [{ type: "text", text: "boom" }], isError: true };
    }
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
}
