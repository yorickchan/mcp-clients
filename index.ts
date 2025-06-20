// OpenAI SDK
import OpenAI from "openai";
import {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

// MCP Client
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Express
import express from "express";
import type { RequestHandler } from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const baseUrl = process.env.OPENAI_BASE_URL;
const model = process.env.OPENAI_MODEL || "gpt-4o";
const wereadCookie = process.env.WEREAD_COOKIE;
if (!OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY is not set");
}

class MCPClient {
  private mcp: Client;
  private llm: OpenAI;
  private transport: StdioClientTransport | null = null;
  public tools: ChatCompletionTool[] = [];

  constructor() {
    this.llm = new OpenAI({
      apiKey: OPENAI_API_KEY,
      baseURL: baseUrl,
    });
    this.mcp = new Client({ name: "mcp-client-cli", version: "1.0.0" });
  }

  async connectToServer(serverScriptPath: string) {
    try {
      const isJs = serverScriptPath.endsWith(".js");
      const isPy = serverScriptPath.endsWith(".py");
      if (!isJs && !isPy) {
        throw new Error("Server script must be a .js or .py file");
      }

      let command: string;
      let args: string[];
      let cwd: string | undefined;
      let env: Record<string, string> | undefined;

      if (isPy) {
        // Python MCP server
        command = "uv";
        args = ["run", "python", serverScriptPath];
        cwd = require("path").dirname(serverScriptPath);
      } else if (isJs) {
        // JavaScript MCP server
        command = "node";
        args = [serverScriptPath];
        cwd = require("path").dirname(serverScriptPath);
        // 为 JavaScript MCP server 传递环境变量
        env = {
          WEREAD_COOKIE: wereadCookie || "",
        };
      } else {
        throw new Error("Unsupported server script type");
      }

      this.transport = new StdioClientTransport({
        command,
        args,
        cwd,
        ...(env && { env }),
      });

      await this.mcp.connect(this.transport);

      const toolsResult = await this.mcp.listTools();
      this.tools = toolsResult.tools.map((tool) => {
        return {
          type: "function" as const,
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          },
        };
      });
      console.log(
        "Connected to server with tools:",
        this.tools.map((tool) => tool.function.name)
      );
      console.log(
        `Successfully connected to ${
          isPy ? "Python" : "JavaScript"
        } MCP server: ${serverScriptPath}`
      );

      if (isJs && wereadCookie) {
        console.log(
          "WEREAD_COOKIE environment variable passed to JavaScript MCP server"
        );
      }
    } catch (e) {
      console.log("Failed to connect to MCP server: ", e);
      throw e;
    }
  }

  async processQuery(query: string) {
    const messages: ChatCompletionMessageParam[] = [
      {
        role: "user",
        content: query,
      },
    ];

    const response = await this.llm.chat.completions.create({
      model,
      max_tokens: 1000,
      messages,
      tools: this.tools,
    });

    const finalText = [];
    const toolResults = [];
    const choice = response.choices[0];
    console.log("22222222", choice.message);

    if (choice.message.content) {
      finalText.push(choice.message.content);
    }

    if (choice.message.tool_calls) {
      for (const toolCall of choice.message.tool_calls) {
        if (toolCall.type === "function") {
          const toolName = toolCall.function.name;
          const toolArgs = JSON.parse(toolCall.function.arguments);

          const result = await this.mcp.callTool({
            name: toolName,
            arguments: toolArgs,
          });
          console.log("11111111", result.content);
          toolResults.push(result);
          finalText.push(
            `[Calling tool ${toolName} with args ${JSON.stringify(toolArgs)}]`
          );

          messages.push({
            role: "assistant",
            content: "",
            tool_calls: [toolCall],
          });

          messages.push({
            role: "tool",
            content:
              typeof result.content === "string"
                ? result.content
                : JSON.stringify(result.content),
            tool_call_id: toolCall.id,
          });

          const followUpResponse = await this.llm.chat.completions.create({
            model,
            max_tokens: 1000,
            messages,
          });

          const followUpChoice = followUpResponse.choices[0];
          if (followUpChoice.message.content) {
            finalText.push(followUpChoice.message.content);
          }
        }
      }
    }

    return finalText.join("\n");
  }

  async cleanup() {
    await this.mcp.close();
  }
}

async function main() {
  if (process.argv.length < 3) {
    console.log("Usage: node index.ts <path_to_server_script>");
    return;
  }

  const app = express();
  const port = process.env.PORT || 3000;

  // Middleware
  app.use(cors());
  app.use(express.json());

  const mcpClient = new MCPClient();

  try {
    await mcpClient.connectToServer(process.argv[2]);

    // Health check endpoint
    const healthCheck: RequestHandler = (req, res) => {
      res.json({
        status: "ok",
        tools: mcpClient.tools.map((t) => t.function.name),
      });
    };
    app.get("/health", healthCheck);

    // LLM interaction endpoint
    const chatHandler: RequestHandler = async (req, res) => {
      try {
        const { query } = req.body;
        if (!query) {
          res.status(400).json({ error: "Query is required" });
          return;
        }

        const response = await mcpClient.processQuery(query);
        res.json({ response });
      } catch (error) {
        console.error("Error processing query:", error);
        res.status(500).json({ error: "Failed to process query" });
      }
    };
    app.post("/chat", chatHandler);

    app.listen(port, () => {
      console.log(`Server running on port ${port}`);
      console.log(`Health check: http://localhost:${port}/health`);
      console.log(`Chat endpoint: http://localhost:${port}/chat`);
    });

    // Handle graceful shutdown
    process.on("SIGTERM", async () => {
      console.log("SIGTERM received. Shutting down gracefully...");
      await mcpClient.cleanup();
      process.exit(0);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

main();
// node build/index.js D:\project\PycharmProjects\mcp_getting_started\web_search.py
