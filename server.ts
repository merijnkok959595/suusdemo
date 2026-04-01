/**
 * Custom Next.js server — adds a WebSocket endpoint for Retell Custom LLM.
 *
 * Route: ws(s)://<host>/api/retell/llm
 *
 * All normal HTTP/Next.js traffic is handled as usual.
 * Run with: tsx server.ts  (development)
 *           NODE_ENV=production tsx server.ts  (production)
 */

import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import next from 'next'
import { handleRetellLLM } from './lib/retell/llm-handler'

const port = parseInt(process.env.PORT ?? '3000', 10)
const dev  = process.env.NODE_ENV !== 'production'
const app  = next({ dev })
const handle = app.getRequestHandler()

app.prepare().then(() => {
  const httpServer = createServer((req, res) => {
    handle(req, res)
  })

  const wss = new WebSocketServer({ noServer: true })

  // Intercept HTTP upgrade requests on the Retell LLM path
  httpServer.on('upgrade', (req, socket, head) => {
    if (req.url?.startsWith('/api/retell/llm')) {
      wss.handleUpgrade(req, socket as never, head, (ws) => {
        handleRetellLLM(ws)
      })
    } else {
      socket.destroy()
    }
  })

  wss.on('error', (err) => {
    console.error('[ws-server] error:', err)
  })

  httpServer.listen(port, () => {
    console.log(`▶  SUUS ready          → http://localhost:${port}`)
    console.log(`▶  Retell Custom LLM   → ws://localhost:${port}/api/retell/llm`)
  })
}).catch((err: unknown) => {
  console.error('Failed to start server:', err)
  process.exit(1)
})
