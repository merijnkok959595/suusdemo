import OpenAI from 'openai'
import type { ChatCompletionTool } from 'openai/resources'
import {
  searchContacts, searchContactsTrgm, createContact, updateContact, findContactDuplicates,
  createNote, createTask, listOpenTasks,
  createAppointment, listUpcomingAppointments, getContactBriefingData,
  adminSb,
  type CrmContext,
  type Contact,
} from './client'
import {
  parseSearchQuery, googleSpellingCorrection, enrichFromGoogle,
  normalizeSearchQuery, interpretSearchQuery,
} from './google'

export type { CrmContext }

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

// ─── OpenAI tool definitions ───────────────────────────────────────────────

export const CRM_TOOLS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'contact_search',
      description: 'Zoek een contact in de CRM op naam, bedrijf, e-mail of telefoonnummer. Roep dit ALTIJD aan vóór notes, taken of afspraken. Fuzzy matching + automatische spellingcorrectie via Google als niets gevonden.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Ruwe zoekopdracht, bijv. "Merijn Amsterdam" of "Bakkerij Jansen Rotterdam" of "+31612345678"' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'contact_create',
      description: 'Maak een nieuw contact aan. VERPLICHT: roep ALTIJD eerst contact_search aan — als er een bestaand contact gevonden wordt, gebruik dat. Roep contact_enrich aan als je bedrijfsnaam + stad hebt voor adres/telefoon/website vanuit Google. De server blokkeert aanmaken als er al een contact bestaat met hetzelfde e-mailadres of telefoonnummer.',
      parameters: {
        type: 'object',
        properties: {
          firstName:    { type: 'string' },
          lastName:     { type: 'string' },
          email:        { type: 'string' },
          phone:        { type: 'string', description: 'Bijv. +31612345678' },
          companyName:  { type: 'string', description: 'VERPLICHT — bedrijfsnaam' },
          type:         { type: 'string', description: 'VERPLICHT — lead | customer' },
          industry:     { type: 'string', description: 'Bedrijfssegment, bijv. restaurant, groothandel, cateraar, café, bar, hotel' },
          city:         { type: 'string', description: 'Aanbevolen — plaatsnaam verbetert routing en zoekresultaten' },
          label:        { type: 'string', description: 'Prioriteitslabel: A (hoogste) | B | C | D (laagste). Stel in op basis van potentieel.' },
          revenue:      { type: 'number', description: 'Verwachte jaarlijkse omzet in euros, bijv. 12000' },
          address:     { type: 'string' },
          postcode:     { type: 'string' },
          country:      { type: 'string', description: 'Standaard NL' },
          website:      { type: 'string' },
        },
        required: ['companyName', 'type'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'contact_update',
      description: 'Wijzig velden van een bestaand contact. Stuur alleen gewijzigde velden.',
      parameters: {
        type: 'object',
        properties: {
          contactId:   { type: 'string', description: 'Contact ID uit contact_search' },
          firstName:   { type: 'string' },
          lastName:    { type: 'string' },
          email:       { type: 'string' },
          phone:       { type: 'string' },
          companyName: { type: 'string' },
          industry:    { type: 'string', description: 'Bedrijfssegment, bijv. restaurant, groothandel, cateraar, café' },
          type:        { type: 'string', description: 'lead | customer' },
          label:       { type: 'string', description: 'A | B | C | D' },
          revenue:     { type: 'number', description: 'Verwachte jaarlijkse omzet in euros' },
          address:    { type: 'string' },
          city:        { type: 'string' },
          postcode:    { type: 'string' },
          country:     { type: 'string' },
          website:     { type: 'string' },
          status:      { type: 'string', description: 'active | inactive | lead' },
          assignedTo:  { type: 'string', description: 'Naam van de medewerker die verantwoordelijk is (uit team_member_list)' },
        },
        required: ['contactId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'contact_enrich',
      description: 'Zoek bedrijfsgegevens op via Google (adres, telefoon, website, openingstijden). Gebruik dit vóór contact_create als je een bedrijfsnaam + stad hebt. Geeft gestructureerde velden terug klaar voor invullen.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Bedrijfsnaam + stad, bijv. "Bakkerij De Molen Amsterdam"' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'contact_briefing',
      description: 'Genereer een volledige briefing voor een contact: recente notities, open taken, aankomende afspraken en aandachtspunten. Gebruik dit als iemand "vertel me over X" vraagt of voordat een gesprek plaatsvindt.',
      parameters: {
        type: 'object',
        properties: {
          contactId:   { type: 'string', description: 'Contact ID uit contact_search' },
          contactName: { type: 'string', description: 'Naam van het contact (voor weergave)' },
        },
        required: ['contactId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'note_create',
      description: 'Voeg een notitie toe aan een contact.',
      parameters: {
        type: 'object',
        properties: {
          contactId: { type: 'string', description: 'Contact ID uit contact_search' },
          body:      { type: 'string', description: 'Volledige tekst van de notitie' },
        },
        required: ['contactId', 'body'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'task_create',
      description: 'Maak een follow-up taak aan voor een contact.',
      parameters: {
        type: 'object',
        properties: {
          contactId: { type: 'string', description: 'Contact ID uit contact_search' },
          title:     { type: 'string', description: 'Taakomschrijving' },
          body:      { type: 'string', description: 'Optionele toelichting' },
          dueDate:   { type: 'string', description: 'ISO 8601 bijv. 2026-03-10T09:00:00+01:00' },
        },
        required: ['contactId', 'title', 'dueDate'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'task_list',
      description: 'Geef openstaande taken voor dit account.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max aantal (standaard 10)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'appointment_create',
      description: 'Maak een afspraak aan voor een contact.',
      parameters: {
        type: 'object',
        properties: {
          contactId: { type: 'string', description: 'Contact ID uit contact_search' },
          title:     { type: 'string' },
          startTime: { type: 'string', description: 'ISO 8601' },
          endTime:   { type: 'string', description: 'ISO 8601' },
          location:  { type: 'string' },
          notes:     { type: 'string' },
        },
        required: ['contactId', 'title', 'startTime', 'endTime'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'appointment_list',
      description: 'Geef aankomende afspraken voor dit account.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max aantal (standaard 10)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'team_member_list',
      description: 'Geef alle medewerkers / teamleden van dit account. Retourneert naam, functie, email, postcode_ranges (rayon) en calendar_id. Gebruik dit voor: (1) toewijzen van contacten aan een medewerker, (2) inplannen van afspraken met een collega, (3) opzoeken wie verantwoordelijk is voor een bepaald postcodegebied.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'contact_list',
      description: 'Geef een lijst van alle contacten in het account, optioneel gefilterd. Gebruik dit voor bulk-bewerkingen zoals "wijs alle contacten toe aan X".',
      parameters: {
        type: 'object',
        properties: {
          limit:       { type: 'number', description: 'Max aantal (standaard 50)' },
          assigned_to: { type: 'string', description: 'Filter op toegewezen medewerker' },
          type:        { type: 'string', description: 'Filter op lead | customer' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'contact_enrich_update',
      description: 'Haal de meest recente bedrijfsgegevens op via Google (adres, telefoon, website, openingstijden) en vergelijk die met de huidige CRM-data. Retourneert een diff met gewijzigde en ongewijzigde velden. Gebruik dit als iemand zegt "adres klopt niet meer", "refresh dit contact", "update de gegevens" of "is het telefoonnummer nog goed?".',
      parameters: {
        type: 'object',
        properties: {
          contactId:   { type: 'string', description: 'Contact ID uit contact_search' },
          companyName: { type: 'string', description: 'Bedrijfsnaam om op te zoeken in Google' },
          city:        { type: 'string', description: 'Stad — verbetert Google-zoekresultaat' },
        },
        required: ['contactId', 'companyName'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'contact_score',
      description: 'Sla intelligence scoring en enrichment op voor een contact — bepaalt automatisch label (A/B/C/D) en verwachte jaaromzet via AI op basis van bedrijfsinformatie en de geconfigureerde scoring-logica. Gebruik dit als de gebruiker vraagt om een contact te scoren, te classificeren of de intelligence bij te werken.',
      parameters: {
        type: 'object',
        properties: {
          contactId: { type: 'string', description: 'UUID van het contact' },
        },
        required: ['contactId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'contact_route',
      description: 'Pas routing toe op een contact — wijst automatisch de juiste medewerker toe op basis van de routing-configuratie (pre-routing AI + postcode-rayon). Gebruik dit als de gebruiker vraagt om een contact te routeren of automatisch toe te wijzen.',
      parameters: {
        type: 'object',
        properties: {
          contactId: { type: 'string', description: 'UUID van het contact' },
        },
        required: ['contactId'],
      },
    },
  },
]

// ─── Tool executor ─────────────────────────────────────────────────────────

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx:  CrmContext,
): Promise<string> {

  try {
    switch (name) {

      // ── contact_search — 3-tier: ILIKE → pg_trgm → LLM sub-agent ──────────
      case 'contact_search': {
        const raw = String(args.query ?? '')

        // Tier 0: normalize (number words → digits, strip legal forms)
        const { normalized, legalStripped } = normalizeSearchQuery(raw)
        const effectiveQuery = normalized

        // Helper: run ILIKE search with token splitting
        const runIlike = async (q: string): Promise<Contact[]> => {
          const { tokens, cityFilter } = parseSearchQuery(q)
          return searchContacts(ctx, q, 20, tokens.length ? tokens : undefined, cityFilter)
        }

        // Tier 1: ILIKE on normalized query
        let contacts = await runIlike(effectiveQuery)

        // Tier 1b: retry with legalStripped if different and still 0
        if (contacts.length === 0 && legalStripped !== effectiveQuery) {
          contacts = await runIlike(legalStripped)
        }

        // Tier 2: pg_trgm + Google Places in PARALLEL (only on non-email/phone queries)
        // Google Places is the canonical source for Dutch business names — runs alongside trgm
        // so there's no extra latency penalty for the correction path.
        if (contacts.length === 0 && !/[@+\d]{6}/.test(effectiveQuery)) {
          const [trgmResults, googleCorrected] = await Promise.all([
            searchContactsTrgm(ctx, legalStripped, 20),
            googleSpellingCorrection(effectiveQuery).catch(() => null),
          ])

          if (trgmResults.length > 0) {
            contacts = trgmResults
          } else if (googleCorrected && googleCorrected.toLowerCase() !== effectiveQuery.toLowerCase()) {
            // Google returned a corrected business name — try ILIKE first (exact match on corrected name)
            // then trgm. ILIKE is faster and handles "Fenten 33 → Venster 33" cases directly.
            contacts = await runIlike(googleCorrected)
            if (contacts.length === 0) {
              contacts = await searchContactsTrgm(ctx, googleCorrected, 20)
            }
            if (contacts.length > 0) {
              const slim = formatContacts(contacts)
              return JSON.stringify({
                count: slim.length, via_google_correction: true,
                corrected_name: googleCorrected, contacts: slim,
                formatted: renderFormatted(slim, slim.length, true, googleCorrected),
              })
            }
          }
        }

        // Tier 3: LLM interpret sub-agent — only when Tier 1 + Tier 2 + Google all gave 0
        // At this point googleSpellingCorrection already ran in Tier 2 — reuse that result
        if (contacts.length === 0 && !/[@+\d]{6}/.test(effectiveQuery)) {
          const googleHint = await googleSpellingCorrection(effectiveQuery).catch(() => null)
          const interpreted = await interpretSearchQuery(effectiveQuery, googleHint)

          // Build a clean retry query from the interpreted fields
          const retryQuery = [interpreted.companyName, interpreted.firstName, interpreted.city]
            .filter(Boolean).join(' ').trim()

          if (retryQuery && retryQuery.toLowerCase() !== effectiveQuery.toLowerCase()) {
            contacts = await runIlike(retryQuery)
            if (contacts.length === 0) {
              contacts = await searchContactsTrgm(ctx, retryQuery, 20)
            }
          }

          if (contacts.length > 0) {
            const slim = formatContacts(contacts)
            return JSON.stringify({
              count: slim.length, via_google_correction: false,
              corrected_name: interpreted.raw !== raw ? interpreted.raw : null,
              via_interpretation: true,
              contacts: slim,
              formatted: renderFormatted(slim, slim.length, false, null),
            })
          }

          // Truly nothing found — include interpreted query in message
          return JSON.stringify({
            count: 0, via_google_correction: false, corrected_name: null,
            contacts: [],
            formatted: `Niets gevonden voor "${raw}"${interpreted.raw !== raw ? ` (ook gezocht op "${interpreted.raw}")` : ''}. Controleer de naam of probeer een andere zoekterm.`,
          })
        }

        if (!contacts.length) {
          return JSON.stringify({
            count: 0, via_google_correction: false, corrected_name: null,
            contacts: [],
            formatted: `Niets gevonden voor "${raw}". Controleer de naam of probeer een andere zoekterm.`,
          })
        }

        const slim = formatContacts(contacts)
        return JSON.stringify({
          count: slim.length,
          via_google_correction: false,
          corrected_name: null,
          contacts: slim,
          formatted: renderFormatted(slim, slim.length, false, null),
        })
      }

      // ── contact_enrich — Google business profile pre-fill ─────────────────
      case 'contact_enrich': {
        const enrichment = await enrichFromGoogle(String(args.query ?? ''))
        if (!enrichment) {
          return JSON.stringify({ found: false, message: 'Geen resultaat gevonden via Google.' })
        }
        return JSON.stringify({ found: true, ...enrichment })
      }

      // ── contact_briefing — parallel fetch + AI summary ────────────────────
      case 'contact_briefing': {
        const data = await getContactBriefingData(ctx, String(args.contactId))
        const name = args.contactName as string
          ?? [data.contact?.first_name, data.contact?.last_name].filter(Boolean).join(' ')
          ?? data.contact?.company_name
          ?? 'Contact'

        const fmt = (d: string) => new Date(d).toLocaleDateString('nl-NL', {
          day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Amsterdam',
        })
        const fmtTime = (d: string) => new Date(d).toLocaleTimeString('nl-NL', {
          hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam',
        })

        const notesText = data.notes.length
          ? data.notes.map(n => `- ${fmt(n.created_at)} — ${n.body}`).join('\n')
          : 'Geen notities gevonden.'

        const tasksText = data.openTasks.length
          ? data.openTasks.map(t => `- ${t.due_date ? fmt(t.due_date) : 'geen datum'} — ${t.title}${t.body ? ': ' + t.body : ''}`).join('\n')
          : 'Geen open taken.'

        const apptText = data.appointments.length
          ? data.appointments.map(a => `- ${fmt(a.start_time)} ${fmtTime(a.start_time)} — ${a.title}${a.location ? ' (' + a.location + ')' : ''}`).join('\n')
          : 'Geen geplande afspraken.'

        // Use OpenAI to generate the briefing summary
        const prompt = `Contact: ${name}\n\nNotities:\n${notesText}\n\nTaken:\n${tasksText}\n\nAfspraken:\n${apptText}`

        const resp = await openai.chat.completions.create({
          model:       'gpt-4.1',
          temperature: 0,
          max_tokens:  800,
          messages: [
            {
              role:    'system',
              content: `Je bent een briefing-assistent voor sales reps.
Je ontvangt CRM data over een contact en geeft een briefing in dit formaat:

## 📋 Briefing: [naam]

### 📝 Recente notities
Max 5, nieuwste eerst. Formaat: [datum] — [inhoud]
Geen: "Geen notities gevonden."

### ✅ Open taken
Alleen incomplete taken. Formaat: [datum] — [titel]: [omschrijving]
Geen: "Geen open taken."

### 📅 Aankomende afspraken
Komende 14 dagen. Formaat: [datum] [tijd] — [titel]
Geen: "Geen geplande afspraken."

### 💡 Aandachtspunten
Precies 2-3 bullets. Openstaande zaken, recente activiteit of inactiviteit, urgente taken.

Regels: altijd Nederlands · geen interne IDs · datums uitschrijven`,
            },
            { role: 'user', content: prompt },
          ],
        })

        return resp.choices[0].message.content ?? 'Briefing niet beschikbaar.'
      }

      // ── contact_create ────────────────────────────────────────────────────
      case 'contact_create': {
        // Hard duplicate guard — check before insert
        const dupes = await findContactDuplicates(ctx, {
          email:        args.email       ? String(args.email)       : null,
          phone:        args.phone       ? String(args.phone)       : null,
          first_name:   args.firstName   ? String(args.firstName)   : null,
          last_name:    args.lastName    ? String(args.lastName)    : null,
          company_name: args.companyName ? String(args.companyName) : null,
          city:         args.city        ? String(args.city)        : null,
        })
        if (dupes.length > 0) {
          const list = formatContacts(dupes)
          return JSON.stringify({
            success:   false,
            duplicate: true,
            message:   `Er bestaat al een contact met dit e-mailadres, telefoonnummer of deze naam. Gebruik het bestaande contact of vraag de gebruiker om bevestiging voordat je een nieuw contact aanmaakt.`,
            existing:  list,
          })
        }

        const contact = await createContact(ctx, {
          first_name:   args.firstName   ? String(args.firstName)   : undefined,
          last_name:    args.lastName    ? String(args.lastName)    : undefined,
          email:        args.email       ? String(args.email)       : undefined,
          phone:        args.phone       ? String(args.phone)       : undefined,
          company_name: args.companyName ? String(args.companyName) : undefined,
          industry:     args.industry    ? String(args.industry)    : undefined,
          type:         args.type        ? String(args.type)        : 'lead',
          label:        args.label       ? String(args.label)       : undefined,
          revenue:      args.revenue     ? Number(args.revenue)     : undefined,
          city:         args.city        ? String(args.city)        : undefined,
          postcode:     args.postcode    ? String(args.postcode)    : undefined,
          country:      String(args.country ?? 'NL'),
          assigned_to:  ctx.userNaam,
        })

        // Fire-and-forget: intelligence scoring + routing in parallel after contact creation
        const baseUrl = process.env.NEXT_PUBLIC_WEBSITE_URL ?? 'http://localhost:3000'
        const firePost = (path: string, body: object) =>
          fetch(`${baseUrl}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }).catch(() => {})

        firePost('/api/intelligence/enrich', { contact_id: contact.id, organization_id: ctx.organizationId })
        firePost('/api/routing/apply',       { contact_id: contact.id, organization_id: ctx.organizationId })

        return JSON.stringify({
          success:     true,
          id:          contact.id,
          naam:        [contact.first_name, contact.last_name].filter(Boolean).join(' ') || contact.company_name,
          assigned_to: contact.assigned_to,
          label:       contact.label ?? '(wordt bepaald door intelligence)',
          revenue:     contact.revenue ?? '(wordt bepaald door intelligence)',
          type:        contact.type,
        })
      }

      // ── contact_update ────────────────────────────────────────────────────
      case 'contact_update': {
        const contact = await updateContact(ctx, String(args.contactId), {
          first_name:   args.firstName   ? String(args.firstName)   : undefined,
          last_name:    args.lastName    ? String(args.lastName)    : undefined,
          email:        args.email       ? String(args.email)       : undefined,
          phone:        args.phone       ? String(args.phone)       : undefined,
          company_name: args.companyName ? String(args.companyName) : undefined,
          industry:     args.industry    ? String(args.industry)    : undefined,
          type:         args.type        ? String(args.type)        : undefined,
          label:        args.label       ? String(args.label)       : undefined,
          revenue:      args.revenue     ? Number(args.revenue)     : undefined,
          city:         args.city        ? String(args.city)        : undefined,
          postcode:     args.postcode    ? String(args.postcode)    : undefined,
          country:      args.country     ? String(args.country)     : undefined,
          website:      args.website     ? String(args.website)     : undefined,
          status:       args.status      ? String(args.status)      : undefined,
          assigned_to:  args.assignedTo  ? String(args.assignedTo)  : undefined,
        })
        return JSON.stringify({ success: true, id: contact.id, assigned_to: contact.assigned_to })
      }

      // ── note_create ───────────────────────────────────────────────────────
      case 'note_create': {
        const note = await createNote(ctx, String(args.contactId), String(args.body))
        return JSON.stringify({ success: true, id: note.id })
      }

      // ── task_create ───────────────────────────────────────────────────────
      case 'task_create': {
        const task = await createTask(ctx, String(args.contactId), String(args.title), String(args.body ?? ''), String(args.dueDate))
        return JSON.stringify({ success: true, id: task.id })
      }

      // ── task_list ─────────────────────────────────────────────────────────
      case 'task_list': {
        const tasks = await listOpenTasks(ctx, Number(args.limit ?? 10))
        if (!tasks.length) return 'Geen openstaande taken.'
        return JSON.stringify({ count: tasks.length, tasks: tasks.map(t => ({
          id: t.id, title: t.title, due_date: t.due_date,
          contact: t.contacts ? [t.contacts.first_name, t.contacts.last_name].filter(Boolean).join(' ') || t.contacts.company_name : null,
        })) })
      }

      // ── appointment_create ────────────────────────────────────────────────
      case 'appointment_create': {
        const appt = await createAppointment(ctx, String(args.contactId), String(args.title), String(args.startTime), String(args.endTime), args.location ? String(args.location) : undefined, args.notes ? String(args.notes) : undefined)
        return JSON.stringify({ success: true, id: appt.id })
      }

      // ── appointment_list ──────────────────────────────────────────────────
      case 'appointment_list': {
        const { data: appts, error: apptErr } = await adminSb()
          .from('appointments')
          .select('id, contact_id, title, start_time, end_time, status, location, notes')
          .eq('organization_id', ctx.organizationId)
          .gte('start_time', new Date().toISOString())
          .order('start_time', { ascending: true })
          .limit(Number(args.limit ?? 10))
        if (apptErr) throw new Error(`appointment_list: ${apptErr.message}`)
        if (!appts?.length) return 'Geen aankomende afspraken.'
        // Enrich with contact names via separate query
        const contactIds = Array.from(new Set(appts.map(a => a.contact_id).filter(Boolean)))
        const { data: contacts } = contactIds.length
          ? await adminSb().from('contacts').select('id, company_name, first_name, last_name').in('id', contactIds)
          : { data: [] }
        const contactMap = Object.fromEntries((contacts ?? []).map(c => [c.id, c]))
        return JSON.stringify({ count: appts.length, appointments: appts.map(a => {
          const c = a.contact_id ? contactMap[a.contact_id] : null
          return { id: a.id, title: a.title, start_time: a.start_time, end_time: a.end_time, location: a.location, status: a.status,
            contact: c ? ([c.first_name, c.last_name].filter(Boolean).join(' ') || c.company_name) : null }
        }) })
      }

      // ── team_member_list ──────────────────────────────────────────────────
      case 'team_member_list': {
        const { data } = await adminSb()
          .from('team_members')
          .select('id, naam, functie, email, postcode_ranges, ghl_calendar_id')
          .eq('organization_id', ctx.organizationId)
          .order('naam')
        return JSON.stringify(data ?? [])
      }

      // ── contact_list ──────────────────────────────────────────────────────
      case 'contact_list': {
        let query = adminSb()
          .from('contacts')
          .select('id, company_name, first_name, last_name, city, type, label, assigned_to')
          .eq('organization_id', ctx.organizationId)
          .not('company_name', 'is', null)
        if (args.assigned_to) query = query.eq('assigned_to', String(args.assigned_to))
        if (args.type)        query = query.eq('type', String(args.type))
        const { data } = await query.order('company_name').limit(Number(args.limit ?? 50))
        return JSON.stringify(data ?? [])
      }

      // ── contact_enrich_update — Google refresh + diff ─────────────────────
      case 'contact_enrich_update': {
        const contactId  = String(args.contactId)
        const searchQ    = [args.companyName, args.city].filter(Boolean).join(' ')

        // Fetch current contact data
        const { data: current, error: fetchErr } = await adminSb()
          .from('contacts')
          .select('company_name, address, city, postcode, country, phone, website')
          .eq('id', contactId)
          .eq('organization_id', ctx.organizationId)
          .single()
        if (fetchErr || !current) {
          return JSON.stringify({ success: false, error: 'Contact niet gevonden.' })
        }

        // Fetch Google enrichment
        const enrichment = await enrichFromGoogle(searchQ).catch(() => null)
        if (!enrichment) {
          return JSON.stringify({ success: false, error: 'Geen Google-resultaat gevonden voor deze bedrijfsnaam.' })
        }

        // Build diff: only fields that have a value in Google AND differ from current
        type DiffEntry = { current: string | null; new: string | null }
        const changed:   Record<string, DiffEntry> = {}
        const unchanged: string[] = []

        const FIELD_MAP: Array<{ key: keyof typeof current; googleKey: keyof typeof enrichment; label: string }> = [
          { key: 'address', googleKey: 'address', label: 'Adres' },
          { key: 'city',     googleKey: 'city',     label: 'Stad' },
          { key: 'postcode', googleKey: 'postalCode', label: 'Postcode' },
          { key: 'country',  googleKey: 'country',  label: 'Land' },
          { key: 'phone',    googleKey: 'phone',    label: 'Telefoon' },
          { key: 'website',  googleKey: 'website',  label: 'Website' },
        ]

        for (const { key, googleKey, label } of FIELD_MAP) {
          const cur = current[key] ?? null
          const nw  = (enrichment[googleKey] as string | null) ?? null
          if (!nw) continue
          if (cur?.toLowerCase().trim() !== nw.toLowerCase().trim()) {
            changed[label] = { current: cur, new: nw }
          } else {
            unchanged.push(label)
          }
        }

        const changedCount = Object.keys(changed).length
        if (changedCount === 0) {
          return JSON.stringify({
            success: true,
            changed: {},
            unchanged,
            message: `Alle gegevens zijn nog up-to-date. Niets gewijzigd.`,
            google_name: enrichment.name,
          })
        }

        // Build a human-readable summary of changes
        const diffLines = Object.entries(changed)
          .map(([label, { current: c, new: n }]) => `${label}: "${c ?? '(leeg)'}" → "${n}"`)
          .join('\n')

        return JSON.stringify({
          success: true,
          changed,
          unchanged,
          changedCount,
          google_name: enrichment.name,
          message: `Google geeft ${changedCount} gewijzigd${changedCount === 1 ? ' veld' : 'e velden'} terug:\n${diffLines}\n\nWil je deze wijzigingen opslaan?`,
        })
      }

      // ── contact_score ─────────────────────────────────────────────────────
      case 'contact_score': {
        const baseUrl = process.env.NEXT_PUBLIC_WEBSITE_URL ?? 'http://localhost:3000'
        const res = await fetch(`${baseUrl}/api/intelligence/enrich`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ contact_id: String(args.contactId), organization_id: ctx.organizationId }),
        })
        if (!res.ok) {
          const e = await res.json().catch(() => ({}))
          return JSON.stringify({ success: false, error: e.error ?? `HTTP ${res.status}` })
        }
        const data = await res.json()
        return JSON.stringify({
          success:   true,
          label:     data.label     ?? null,
          revenue:   data.revenue   ?? null,
          summary:   data.summary   ?? null,
        })
      }

      // ── contact_route ─────────────────────────────────────────────────────
      case 'contact_route': {
        const baseUrl = process.env.NEXT_PUBLIC_WEBSITE_URL ?? 'http://localhost:3000'
        const res = await fetch(`${baseUrl}/api/routing/apply`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ contact_id: String(args.contactId), organization_id: ctx.organizationId }),
        })
        if (!res.ok) {
          const e = await res.json().catch(() => ({}))
          return JSON.stringify({ success: false, error: e.error ?? `HTTP ${res.status}` })
        }
        const data = await res.json()
        return JSON.stringify({
          success:     true,
          assigned_to: data.assigned_to ?? null,
          phase:       data.phase       ?? null,
        })
      }

      default:
        return `Onbekende tool: ${name}`
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[crm] tool error (${name}):`, msg)
    return `Fout bij ${name}: ${msg}`
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function formatContacts(contacts: Awaited<ReturnType<typeof searchContacts>>) {
  return contacts
    .sort((a, b) => {
      const ca = (a.company_name ?? 'zzz').toLowerCase()
      const cb = (b.company_name ?? 'zzz').toLowerCase()
      if (ca !== cb) return ca.localeCompare(cb)
      const fa = (a.first_name ?? '').toLowerCase()
      const fb = (b.first_name ?? '').toLowerCase()
      return fa.localeCompare(fb)
    })
    .map(c => ({
      id:          c.id,
      naam:        [c.first_name, c.last_name].filter(Boolean).join(' ') || null,
      bedrijf:     c.company_name,
      email:       c.email,
      phone:       c.phone,
      stad:        c.city,
      status:      c.status,
    }))
}

function renderFormatted(
  contacts: ReturnType<typeof formatContacts>,
  count:    number,
  viaGoogle: boolean,
  corrected: string | null,
): string {
  const lines = contacts.map(c => {
    const parts = []
    if (c.bedrijf) parts.push(`🏢 ${c.bedrijf}`)
    if (c.naam)    parts.push(c.bedrijf ? `— ${c.naam}` : c.naam)
    if (c.phone)   parts.push(`📞 ${c.phone}`)
    if (c.email)   parts.push(`✉️ ${c.email}`)
    if (c.stad)    parts.push(`📍 ${c.stad}`)
    return parts.join(' | ')
  })

  let result = lines.join('\n') + `\n\nGevonden: ${count} contact${count !== 1 ? 'en' : ''}`
  if (viaGoogle && corrected) {
    result += `\n_(Spelling gecorrigeerd via Google: "${corrected}")_`
  }
  if (count > 20) {
    result += '\nMeer dan 20 resultaten — voeg een stad of bedrijfsnaam toe om te verfijnen.'
  }
  return result
}
