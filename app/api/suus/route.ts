export const runtime = 'edge'

export async function POST() {
  const encoder = new TextEncoder()
  const stream  = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('Gebruik de **Bellen** knop rechtsbovenin om een gesprek te starten met Suus.'))
      controller.close()
    },
  })
  return new Response(stream, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' },
  })
}
