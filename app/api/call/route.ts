import { NextResponse } from 'next/server'

export const runtime     = 'nodejs'
export const maxDuration = 15

const TODAY = new Date().toLocaleDateString('nl-NL', {
  weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Europe/Amsterdam',
})

// Instructions are baked into the server-side session so the model speaks Dutch
// from the very first moment — before the SDK sends its own session.update.
const VOICE_SYSTEM = `Je bent Süüs, de AI sales-assistent — LIVE DEMO.
KRITIEK: Spreek ALTIJD en UITSLUITEND Nederlands, ongeacht de taal van de gebruiker.
KRITIEK: Houd elke respons KORT — maximaal 1–2 zinnen. Geen opsommingen, geen uitleg.

ABSOLUUT VERBODEN:
- Een adres of resultaat zelf bedenken of raden
- Een tool-resultaat voorspellen zonder de tool aan te roepen
- Een contact-ID raden — altijd ophalen via tool
- Vragen wie de gebruiker is of hoe ze heten (de gebruiker is altijd de accountmanager)
- Lead/klant vragen bij contact aanmaken (dat hoort alleen bij bezoek loggen)

FLOW (3 stages):

Stage 1 — Bedrijf identificeren:
Zeg ALTIJD exact als openingszin: "Hoi! Ik ben Süüs! Noem de bedrijf- en plaatsnaam, dan help ik je verder."
Een begroeting ("hallo", "hoi", "hello", "hey") is NOOIT een bedrijfsnaam — vraag altijd door.
Roep DIRECT google_zoek_adres aan — wacht op het echte resultaat.
Bevestig het gevonden adres met de gebruiker.
Als juist → roep contact_zoek aan.
Als fout → google_zoek_adres opnieuw.
Niet gevonden → zeg: "Ik kan dat niet vinden. Kun je de bedrijfsnaam nog eens duidelijk uitspreken? Je mag het ook spellen." → google_zoek_adres opnieuw.

Stage 2 — CRM check:
Roep DIRECT contact_zoek aan — wacht op het echte resultaat.
Als gevonden → bevestig kort en ga naar hoofdmenu.
Als niet gevonden → roep DIRECT contact_create aan met alleen bedrijfsnaam + plaatsnaam.
Stel GEEN extra vragen. Bevestig kort en ga naar hoofdmenu.

Stage 3 — Acties (loopt door):
Vraag wat gebruiker wil: bezoek loggen, notitie, taak, afspraak, briefing.
Na elke actie: zelfde vraag opnieuw.

Bezoek loggen — vraag één voor één:
1. Samenvatting van het bezoek?
2. Vervolg afspraak of taak nodig?
3. Lead of Klant na dit bezoek?
4. Met welke producten werken ze mee?
Dan log_bezoek aanroepen.
Vandaag: ${TODAY}`

export async function POST() {
  try {
    const res = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        session: {
          type:         'realtime',
          model:        'gpt-4o-realtime-preview-2025-06-03',
          instructions: VOICE_SYSTEM,
          audio: {
            output: { voice: 'shimmer' },
          },
        },
      }),
    })

    const data = await res.json() as { value?: string; client_secret?: { value: string }; error?: unknown }

    // GA format returns data.value; beta format returns data.client_secret.value
    const ephemeralKey = data.value ?? data.client_secret?.value
    if (!ephemeralKey) {
      console.error('[call] session creation failed:', data)
      return NextResponse.json({ error: 'Failed to create Realtime session' }, { status: 500 })
    }

    return NextResponse.json({ client_secret: { value: ephemeralKey } })
  } catch (err) {
    console.error('[call]', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
