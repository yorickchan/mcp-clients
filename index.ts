// OpenAI SDK

// MCP Client
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import cors from 'cors'
import dotenv from 'dotenv'
import type { RequestHandler } from 'express'
// Express
import express from 'express'
import fs from 'fs'
import OpenAI from 'openai'
import {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions'

dotenv.config()

const OPENAI_API_KEY = process.env.OPENAI_API_KEY
const baseUrl = process.env.OPENAI_BASE_URL
const model = process.env.OPENAI_MODEL || 'gpt-4o'
if (!OPENAI_API_KEY) {
  throw new Error('OPENAI_API_KEY is not set')
}

// Load MCP server configuration
const mcpConfig = JSON.parse(fs.readFileSync('./mcpserver.json', 'utf8'))

class MCPClient {
  private mcp: Client
  private llm: OpenAI
  private transport: StdioClientTransport | null = null
  public tools: ChatCompletionTool[] = []

  constructor() {
    this.llm = new OpenAI({
      apiKey: OPENAI_API_KEY,
      baseURL: baseUrl,
    })
    this.mcp = new Client({ name: 'mcp-client-cli', version: '1.0.0' })
  }

  async connectToConfiguredServer(serverName: string) {
    try {
      const serverConfig = mcpConfig.mcpServers[serverName]
      if (!serverConfig) {
        throw new Error(`Server '${serverName}' not found in mcpserver.json`)
      }

      console.log(`Connecting to configured MCP server: ${serverName}`)

      this.transport = new StdioClientTransport({
        command: serverConfig.command,
        args: serverConfig.args || [],
        env: serverConfig.env || {},
      })

      await this.mcp.connect(this.transport)

      const toolsResult = await this.mcp.listTools()
      this.tools = toolsResult.tools.map((tool) => {
        return {
          type: 'function' as const,
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          },
        }
      })
      console.log(
        'Connected to server with tools:',
        this.tools.map((tool) => tool.function.name)
      )
      console.log(
        `Successfully connected to configured MCP server: ${serverName}`
      )
    } catch (e) {
      console.log('Failed to connect to MCP server: ', e)
      throw e
    }
  }

  async processQuery(query: string) {
    const messages: ChatCompletionMessageParam[] = [
      {
        role: 'user',
        content: query,
      },
    ]

    const response = await this.llm.chat.completions.create({
      model,
      max_tokens: 1000,
      messages,
      tools: this.tools,
    })

    const finalText = []
    const toolResults = []
    const choice = response.choices[0]
    console.log('22222222', choice.message)

    if (choice.message.content) {
      finalText.push(choice.message.content)
    }

    if (choice.message.tool_calls) {
      for (const toolCall of choice.message.tool_calls) {
        if (toolCall.type === 'function') {
          const toolName = toolCall.function.name
          const toolArgs = JSON.parse(toolCall.function.arguments)

          const result = await this.mcp.callTool({
            name: toolName,
            arguments: toolArgs,
          })
          console.log('11111111', result.content)
          toolResults.push(result)
          finalText.push(
            `[Calling tool ${toolName} with args ${JSON.stringify(toolArgs)}]`
          )

          messages.push({
            role: 'assistant',
            content: '',
            tool_calls: [toolCall],
          })

          messages.push({
            role: 'tool',
            content:
              typeof result.content === 'string'
                ? result.content
                : JSON.stringify(result.content),
            tool_call_id: toolCall.id,
          })

          const followUpResponse = await this.llm.chat.completions.create({
            model,
            max_tokens: 1000,
            messages,
          })

          const followUpChoice = followUpResponse.choices[0]
          if (followUpChoice.message.content) {
            finalText.push(followUpChoice.message.content)
          }
        }
      }
    }

    return finalText.join('\n')
  }

  async cleanup() {
    await this.mcp.close()
  }
}

async function main() {
  if (process.argv.length < 3) {
    console.log(`Received ${process.argv.length} arguments`)
    console.log(
      'Usage: node index.ts <server_name_from_config | path_to_server_script>'
    )
    console.log(
      'Available configured servers:',
      Object.keys(mcpConfig.mcpServers).join(', ')
    )
    return
  }

  process.argv.forEach(function (val, index, array) {
    console.log(index + ': ' + val)
  })

  const app = express()
  const port = process.env.PORT || 3000

  // Middleware
  app.use(cors())
  app.use(express.json())

  const mcpClient = new MCPClient()

  try {
    const serverArg = process.argv[2]

    // Check if the argument is a configured server name
    if (mcpConfig.mcpServers[serverArg]) {
      await mcpClient.connectToConfiguredServer(serverArg)
    }

    // Health check endpoint
    const healthCheck: RequestHandler = (req, res) => {
      res.json({
        status: 'ok',
        tools: mcpClient.tools.map((t) => t.function.name),
      })
    }
    app.get('/health', healthCheck)

    // LLM interaction endpoint
    const chatHandler: RequestHandler = async (req, res) => {
      try {
        const { query } = req.body
        if (!query) {
          res.status(400).json({ error: 'Query is required' })
          return
        }

        const response = await mcpClient.processQuery(query)
        res.json({ response })
      } catch (error) {
        console.error('Error processing query:', error)
        res.status(500).json({ error: 'Failed to process query' })
      }
    }
    app.post('/chat', chatHandler)

    app.listen(port, () => {
      console.log(`Server running on port ${port}`)
      console.log(`Health check: http://localhost:${port}/health`)
      console.log(`Chat endpoint: http://localhost:${port}/chat`)
    })

    // Handle graceful shutdown
    process.on('SIGTERM', async () => {
      console.log('SIGTERM received. Shutting down gracefully...')
      await mcpClient.cleanup()
      process.exit(0)
    })
  } catch (error) {
    console.error('Failed to start server:', error)
    process.exit(1)
  }
}

main()
// node build/index.js D:\project\PycharmProjects\mcp_getting_started\web_search.py
