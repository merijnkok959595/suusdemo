import OpenAI from 'openai'
import { NextRequest } from 'next/server'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

export async function POST(req: NextRequest) {
  try {
    const fd    = await req.formData()
    const audio = fd.get('audio') as File | null
    if (!audio) return Response.json({ error: 'No audio' }, { status: 400 })

    const result = await openai.audio.transcriptions.create({
      model:    'gpt-4o-transcribe',
      file:     audio,
      language: 'nl',
    })

    return Response.json({ text: result.text })
  } catch (e) {
    console.error('[transcribe]', e)
    return Response.json({ error: 'Transcription failed' }, { status: 500 })
  }
}
