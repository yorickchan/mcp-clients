// OpenAI SDK

import fs from 'node:fs'
// MCP Client
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import cors from 'cors'
import dotenv from 'dotenv'
import type { RequestHandler } from 'express'
// Express
import express from 'express'
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
  private mcpClients: Map<string, Client> = new Map()
  private llm: OpenAI
  private transports: Map<string, StdioClientTransport> = new Map()
  public tools: ChatCompletionTool[] = []

  constructor() {
    this.llm = new OpenAI({
      apiKey: OPENAI_API_KEY,
      baseURL: baseUrl,
    })
  }

  async connectToAllConfiguredServers() {
    const serverNames = Object.keys(mcpConfig.mcpServers)
    console.log(`Connecting to ${serverNames.length} MCP servers: ${serverNames.join(', ')}`)

    const connectionPromises = serverNames.map(async (serverName) => {
      try {
        const serverConfig = mcpConfig.mcpServers[serverName]
        console.log(`Connecting to MCP server: ${serverName}`)

        const client = new Client({ name: `mcp-client-${serverName}`, version: '1.0.0' })
        const transport = new StdioClientTransport({
          command: serverConfig.command,
          args: serverConfig.args || [],
          env: serverConfig.env || {},
        })

        await client.connect(transport)
        this.mcpClients.set(serverName, client)
        this.transports.set(serverName, transport)

        const toolsResult = await client.listTools()
        const serverTools = toolsResult.tools.map((tool) => {
          return {
            type: 'function' as const,
            function: {
              name: `${serverName}.${tool.name}`,
              description: `[${serverName}] ${tool.description}`,
              parameters: tool.inputSchema,
            },
          }
        })
        
        this.tools.push(...serverTools)
        console.log(
          `Connected to ${serverName} with tools:`,
          serverTools.map((tool) => tool.function.name)
        )
        console.log(`Successfully connected to MCP server: ${serverName}`)
        
        return { serverName, success: true, toolCount: serverTools.length }
      } catch (e) {
        console.log(`Failed to connect to MCP server ${serverName}:`, e)
        return { serverName, success: false, error: e }
      }
    })

    const results = await Promise.allSettled(connectionPromises)
    const successfulConnections = results
      .filter((result) => result.status === 'fulfilled' && result.value.success)
      .map((result) => (result as PromiseFulfilledResult<any>).value)
    
    const failedConnections = results
      .filter((result) => result.status === 'fulfilled' && !result.value.success)
      .map((result) => (result as PromiseFulfilledResult<any>).value)

    console.log(`\nConnection Summary:`)
    console.log(`✅ Successfully connected: ${successfulConnections.length} servers`)
    successfulConnections.forEach(conn => {
      console.log(`   - ${conn.serverName} (${conn.toolCount} tools)`)
    })
    
    if (failedConnections.length > 0) {
      console.log(`❌ Failed connections: ${failedConnections.length} servers`)
      failedConnections.forEach(conn => {
        console.log(`   - ${conn.serverName}: ${conn.error?.message || 'Unknown error'}`)
      })
    }
    
    console.log(`\nTotal tools available: ${this.tools.length}`)
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

          // Parse server name and actual tool name
          const [serverName, actualToolName] = toolName.includes('.') 
            ? toolName.split('.', 2)
            : [Array.from(this.mcpClients.keys())[0], toolName]

          const client = this.mcpClients.get(serverName)
          if (!client) {
            throw new Error(`MCP client for server '${serverName}' not found`)
          }

          const result = await client.callTool({
            name: actualToolName,
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
    const closePromises = Array.from(this.mcpClients.values()).map(client => client.close())
    await Promise.allSettled(closePromises)
    this.mcpClients.clear()
    this.transports.clear()
  }
}

async function main() {
  console.log('Starting MCP Client Server...')
  console.log(
    'Available configured servers:',
    Object.keys(mcpConfig.mcpServers).join(', ')
  )

  const app = express()
  const port = process.env.PORT || 3000

  // Middleware
  app.use(cors())
  app.use(express.json())

  const mcpClient = new MCPClient()

  try {
    // Connect to all configured servers
    await mcpClient.connectToAllConfiguredServers()

    // Health check endpoint
    const healthCheck: RequestHandler = (_req, res) => {
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
// Usage: npm start or node build/index.js
// The server will automatically connect to all MCP servers configured in mcpserver.json
