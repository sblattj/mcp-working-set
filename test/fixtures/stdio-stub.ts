// A stdio MCP server exposing the same STUB_TOOLS, for the stdio upstream test.
// Run: bun run test/fixtures/stdio-stub.ts
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { stubServer } from "./stub-upstream.ts";

await stubServer().connect(new StdioServerTransport());
