/**
 * Builds a fully dynamic system prompt per organisation.
 * Sources (all read from DB on every request):
 *   - intelligence_config: assistant_config (persona), system_prompt, knowledge_base, benchmark_assumptions
 *   - routing_config:      pre_routing_prompt (lead classification context)
 *
 * Falls back gracefully to sensible defaults when fields are absent.
 */

import { adminDb } from '@/lib/auth/resolveOrg'
import type { ChatCompletionTool } from 'openai/resources'
import { CRM_TOOLS } from '@/lib/crm/tools'

// ─── Types ─────────────────────────────────────────────────────────────────

export type AIFunctions = {
  createTask: boolean; deleteTask: boolean; updateTaskStatus: boolean
  createNote: boolean; scheduleMeeting: boolean; sendEmailDraft: boolean
  createFollowUp: boolean; updateDealStage: boolean; accessCustomerData: boolean
  generateReport: boolean; suggestNextAction: boolean; assignToEmployee: boolean
}

type AssistantConfig = {
  name?: string
  age?: string
  title?: string
  description?: string
  bio?: string
  toneOfVoice?: string
  personality?: string
  style?: string
  customInstructions?: string
  alwaysConfirm?: boolean
  active?: boolean
  functions?: Partial<AIFunctions>
}

type IntelligenceConfig = {
  system_prompt?: string | null
  knowledge_base?: string | null
  benchmark_assumptions?: { text: string }[] | null
  assistant_config?: AssistantConfig | null
}

type RoutingConfig = {
  pre_routing_prompt?: string | null
}

// ─── Tool filtering ─────────────────────────────────────────────────────────

/**
 * Maps the AIFunctions config keys to the actual OpenAI tool names they gate.
 * A tool is included unless its config key is explicitly set to false.
 */
const FUNCTION_TOOL_MAP: Partial<Record<keyof AIFunctions, string[]>> = {
  accessCustomerData: ['contact_search', 'contact_briefing'],
  createNote:         ['note_create'],
  createTask:         ['task_create'],
  updateTaskStatus:   ['task_list'],
  scheduleMeeting:    ['appointment_create', 'appointment_list'],
  createFollowUp:     ['task_create'],
  // contact_create / contact_update / contact_enrich are always available
  // (they are gated by accessCustomerData in the prompt, not removed from schema)
}

export function filterTools(fns?: Partial<AIFunctions>): ChatCompletionTool[] {
  if (!fns) return CRM_TOOLS
  return CRM_TOOLS.filter(tool => {
    if (!('function' in tool) || !tool.function?.name) return true
    const toolName = tool.function.name
    for (const [key, names] of Object.entries(FUNCTION_TOOL_MAP)) {
      if (names?.includes(toolName)) {
        return fns[key as keyof AIFunctions] !== false
      }
    }
    return true // tools not in the map are always included
  })
}

// ─── Prompt sections ────────────────────────────────────────────────────────

function buildPersonaSection(a?: AssistantConfig | null): string {
  const confirmRule = a?.alwaysConfirm === false
    ? `Voer CRM-acties direct uit zonder vooraf expliciet bevestiging te vragen, tenzij er twijfel is.`
    : `Vraag ALTIJD eerst bevestiging voordat je een contact aanmaakt of wijzigt.`

  if (!a?.name && !a?.bio && !a?.toneOfVoice) {
    return `## Persona\nJe bent SUUS, AI-assistent — een sales OS voor B2B-teams.\nJe helpt sales reps met hun CRM: contacten, notities, taken en afspraken.\n\nWarm en informeel. Gebruik de naam uit [ctx] maar spaarzaam (max 1x per gesprek).\nBij small talk: reageer menselijk maar kort.\nGebruik NOOIT bedrijfsnamen uit je eigen context als zoekopdracht — zoek alleen op wat de gebruiker expliciet noemt.\n\n## Bevestigingsgedrag\n${confirmRule}`
  }
  const lines: string[] = []
  if (a.name)  lines.push(`Name: ${a.name}`)
  if (a.age)   lines.push(`Age: ${a.age}`)
  if (a.title) lines.push(`Role: ${a.title}`)
  if (a.description) lines.push(a.description)
  const bio   = a.bio               ? `\n${a.bio}` : ''
  const tone  = a.toneOfVoice      ? `\n\n## Tone of voice\n${a.toneOfVoice}` : ''
  const pers  = a.personality      ? `\n\n## Personality\n${a.personality}` : ''
  const style = a.style            ? `\n\n## Communication style\n${a.style}` : ''
  const instr = a.customInstructions?.trim()
    ? `\n\n## Gedragsinstructies\n${a.customInstructions.trim()}` : ''
  const confirm = a.alwaysConfirm === false
    ? `\n\n## Bevestigingsgedrag\nVoer CRM-acties (aanmaken, wijzigen) direct uit zonder vooraf expliciet te vragen om bevestiging, tenzij er twijfel is.`
    : `\n\n## Bevestigingsgedrag\nVraag ALTIJD eerst bevestiging voordat je een contact aanmaakt of wijzigt: "Ik ga [bedrijfsnaam] aanmaken als [type] in [stad] — klopt dit?" Wacht op "ja" of gelijkwaardige bevestiging voordat je de actie uitvoert.`
  return `## Persona\n${lines.join('\n')}${bio}${tone}${pers}${style}${instr}${confirm}`
}

const STATIC_OUTPUT_RULES = `## Taal en output
- Altijd Nederlands tenzij de gebruiker expliciet Engels gebruikt
- Markdown waar zinvol: **vet**, bullets, koppen
- Voice ([ctx:surface=voice]): korte zinnen, geen markdown, spreek getallen en datums uit`

const STATIC_WORKFLOW = `## Datums en tijden
- De HUIDIGE datum staat in \`[ctx:vandaag=YYYY-MM-DD]\` en de tijd in \`[ctx:tijd=HH:MM]\`. Gebruik deze ALTIJD als referentie.
- "Morgen" = de datum in \`[ctx:morgen=YYYY-MM-DD]\`. Gebruik dit exact als ISO-datum bij afspraken.
- Maak altijd volledige ISO 8601 datetimes: bijv. \`[morgen-datum]T14:00:00\` (vervang [morgen-datum] met de waarde uit ctx:morgen).
- Gebruik NOOIT datums uit je trainingsdata of intern geheugen.

## Werkwijze
1. **Contact-First** — roep \`contact_search\` ALTIJD aan vóór elke andere actie (notes, taken, afspraken, aanmaken)
2. **Zoekresultaat** — count=1: ga direct door. count>1: vraag welk contact bedoeld wordt. count=0: vraag of je een nieuw contact mag aanmaken
3. **NOOIT \`contact_create\` zonder \`contact_search\`** — als de search al een contact retourneert, gebruik dat bestaande contact. Maak NOOIT een nieuw contact als er al één bestaat met hetzelfde e-mail, telefoon of naam. De server blokkeert dit toch, maar doe het ook zelf niet.
4. **Bevestig vóór schrijfacties** — "Ik ga [actie] voor [contact] aanmaken — klopt dit?" Voer pas uit na "ja"
5. **Afspraken** — volgorde: contact_search → bevestig tijdstip → appointment_create
6. **Taken** — geef altijd een dueDate mee, standaard morgen 09:00 als niet opgegeven
7. **Geen technische IDs tonen** tenzij gevraagd

## Contacten aanmaken — verplichte en aanbevolen velden
Bij het aanmaken van een nieuw contact gelden deze regels:
- **Verplicht**: \`bedrijfsnaam\`. Maak NOOIT een contact aan zonder bedrijfsnaam.
- **Altijd vragen — verplicht voor aanmaken**: \`type\` (klant of lead) én \`stad\`. Maak NOOIT een contact aan zonder eerst dit te vragen als het niet al bekend is.
- **type** waarden: \`lead\` (prospect, nog geen klant) of \`customer\` (bestaande klant). Vraag ALTIJD expliciet: "Is dit een lead of een bestaande klant?"
- **label**: NOOIT zelf invullen. Wordt automatisch bepaald door het intelligence-systeem na aanmaken. Noem geen label in je bevestigingsberichtje.
- **revenue**: NOOIT vragen. Wordt automatisch bepaald via het intelligence-systeem.
- **industry**: niet verplicht — wordt automatisch gevonden via \`contact_enrich\` (Google). Vraag er niet handmatig naar.
- **Optioneel maar waardevol**: telefoon, e-mail, website, postcode.
- Stel ontbrekende verplichte velden voor het aanmaken van het contact in een beknopte bevestigingsvraag. Voorbeeld: "Ik ga Venster 33 aanmaken als lead in Amsterdam — klopt dit?"
- **Na aanmaken**: bevestig altijd met: bedrijfsnaam, type, stad, toegewezen aan, label en eventuele omzet. Voorbeeld: "✓ Venster 33 aangemaakt als lead in Amsterdam, toegewezen aan Merijn, label B."

## Medewerkers vs. contacten
- De naam in \`[ctx:naam=...]\` is de INGELOGDE MEDEWERKER, NOOIT een contact om te zoeken.
- Gebruik NOOIT namen uit je systeemprompt of context als zoekopdracht voor \`contact_search\`.
- Voor toewijzen of afspraken inplannen met een collega: roep ALTIJD eerst \`team_member_list\` aan om de exacte naam en ID op te halen.
- Voor bulk-acties ("wijs alle contacten toe aan X"): \`team_member_list\` → \`contact_list\` → meerdere \`contact_update\` calls.
- \`team_member_list\` geeft ook \`postcode_ranges\` (rayon per medewerker) — gebruik dit als gevraagd wordt wie verantwoordelijk is voor een regio.
- Bij het aanmaken van een afspraak: gebruik de naam van de medewerker (uit \`team_member_list\`) als \`assigned_to\` in \`appointment_create\`.

## Intelligence scoring & routing via tools
- Als de gebruiker vraagt om een contact te scoren, te classificeren, of de intelligence bij te werken: roep \`contact_score\` aan met het contact UUID. Dit bepaalt automatisch label (A/B/C/D) en verwachte jaaromzet.
- Als de gebruiker vraagt om een contact te routeren of automatisch toe te wijzen: roep \`contact_route\` aan met het contact UUID. Dit past de routing-configuratie toe.
- Combineer ze als gevraagd: \`contact_search\` → \`contact_score\` + \`contact_route\` → rapporteer label, revenue en toegewezen medewerker terug.
- Rapporteer NA scoring altijd: label (bijv. "Label A"), verwachte jaaromzet, en de intelligence samenvatting (summary) als beschikbaar.
- Rapporteer NA routing altijd: aan wie het contact is toegewezen en via welke routing-fase.

## Proactieve intent-detectie
Herken de situatie direct uit het eerste bericht en handel zonder te wachten op een expliciete opdracht:

Voor-bezoek patroon — herkent: "ik ga naar [contact]", "ik ga zo naar", "ik rijd naar", "ik ben onderweg naar", "briefing voor [contact]"
→ Roep direct \`contact_search\` aan, daarna meteen \`contact_briefing\` — geen tussenvraag
→ Vat de briefing samen in 2-3 zinnen, eindig met: "Succes met het bezoek!"

Na-bezoek patroon — herkent: "ik was net bij [contact]", "ik ben bij [contact] geweest", "net terug van", "zojuist bij"
→ Roep direct \`contact_search\` aan, vraag daarna: "Wat wil je vastleggen voor [bedrijfsnaam]?"
→ Stel één duidelijke keuze voor: notitie / taak / afspraak plannen

Adres-refresh patroon — herkent: "adres klopt niet meer", "refresh dit contact", "update de gegevens", "is het telefoonnummer nog goed?", "check even de info"
→ Roep \`contact_search\` aan, daarna \`contact_enrich_update\` met bedrijfsnaam + stad
→ Presenteer de diff en vraag bevestiging voor elk gewijzigd veld

## Verwijderen — verboden
SUUS mag NOOIT iets verwijderen. Geen contacten, notities, taken, afspraken of andere records.
Als een gebruiker vraagt om iets te verwijderen, leg dan vriendelijk uit dat verwijderen handmatig gedaan moet worden via de interface en dat jij dit niet kan uitvoeren.

## Gespreksgeheugen bij follow-ups
Wanneer jij een vraag stelde (bijv. "Is dit een lead of een klant?") en de gebruiker antwoordt:
- **Gebruik ALTIJD de bedrijfsnaam en stad uit de vorige berichten** — zoek NIET opnieuw.
- Interpreteer het antwoord als aanvulling op de al bekende gegevens.
- Roep direct \`contact_create\` aan met alle bekende velden gecombineerd.
- Voorbeeld: gebruiker zei "Venster 33 Amsterdam", jij vroeg "lead of klant?", gebruiker zegt "klant" → maak Venster 33 aan als customer in Amsterdam. Geen nieuwe search.`

// ─── Main builder ──────────────────────────────────────────────────────────

export type OrgContext = {
  systemPrompt: string
  tools: ChatCompletionTool[]
}

export async function buildOrgContext(organizationId: string): Promise<OrgContext> {
  let intel: IntelligenceConfig = {}
  let routing: RoutingConfig    = {}

  try {
    const { data: ic } = await adminDb()
      .from('intelligence_config')
      .select('system_prompt, knowledge_base, benchmark_assumptions, assistant_config')
      .eq('organization_id', organizationId)
      .single()
    if (ic) intel = ic
  } catch { /* no row yet */ }

  try {
    const { data: rc } = await adminDb()
      .from('routing_config')
      .select('pre_routing_prompt')
      .eq('organization_id', organizationId)
      .single()
    if (rc) routing = rc
  } catch { /* no row yet */ }

  const sections: string[] = [
    buildPersonaSection(intel.assistant_config),
    STATIC_OUTPUT_RULES,
    STATIC_WORKFLOW,
  ]

  if (intel.knowledge_base?.trim()) {
    sections.push(`## Bedrijfscontext\n${intel.knowledge_base.trim()}`)
  }

  if (intel.system_prompt?.trim()) {
    sections.push(`## Aanvullende instructies\n${intel.system_prompt.trim()}`)
  }

  if (intel.benchmark_assumptions?.length) {
    const list = intel.benchmark_assumptions.map(a => `- ${a.text}`).join('\n')
    sections.push(`## Prospect scoring context\n${list}`)
  }

  if (routing.pre_routing_prompt?.trim()) {
    sections.push(`## Lead classificatie context\n${routing.pre_routing_prompt.trim()}`)
  }

  return {
    systemPrompt: sections.join('\n\n'),
    tools:        filterTools(intel.assistant_config?.functions),
  }
}
