import { z } from 'zod'

export const ChatRequestSchema = z.object({
  message:    z.string().optional(),
  session_id: z.string().optional(),
  images:     z.array(z.object({ base64: z.string(), mimeType: z.string() })).optional(),
})
