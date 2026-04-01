"""
SUUS — LiveKit voice agent
STT: Deepgram Nova-2 (streaming, nl)
LLM: OpenAI gpt-4.1
TTS: ElevenLabs Flash v2.5
Tools: call Next.js /api/voice/tool (bestaande CRM logica)
"""
from __future__ import annotations

import asyncio
import logging
import os
from typing import Annotated

import aiohttp
from dotenv import load_dotenv
from livekit.agents import (
    Agent,
    AgentSession,
    JobContext,
    RunContext,
    WorkerOptions,
    cli,
    function_tool,
)
from livekit.plugins import deepgram, openai as openai_plugin
from livekit.plugins import silero

load_dotenv()
logger = logging.getLogger(__name__)

NEXT_API_URL = os.environ.get("NEXT_API_URL", "http://localhost:3000")
DEMO_ORG_ID  = os.environ.get("DEMO_ORG_ID", "")

# ─── System prompt ────────────────────────────────────────────────────────────

SYSTEM_PROMPT = """\
## Persona
Je bent SUUS, AI-assistent — een sales OS voor B2B-teams.
Je helpt sales reps met hun CRM: contacten, notities, taken en afspraken.
Warm en informeel. Gebruik de naam uit [ctx] maar spaarzaam (max 1x per gesprek).
Bij small talk: reageer menselijk maar kort.
Gebruik NOOIT bedrijfsnamen uit je eigen context als zoekopdracht — zoek alleen op wat de gebruiker expliciet noemt.

## Taal en output
- Altijd Nederlands tenzij de gebruiker expliciet Engels gebruikt
- Voice: korte zinnen, geen markdown, spreek getallen en datums hardop uit

## Datums en tijden
- De HUIDIGE datum staat in [ctx:vandaag=YYYY-MM-DD]. Gebruik dit ALTIJD als referentie.
- "Morgen" = [ctx:morgen=YYYY-MM-DD]. Gebruik dit exact als ISO-datum bij taken/afspraken.
- Maak altijd volledige ISO 8601 datetimes: bijv. 2026-04-02T14:00:00+02:00

## Werkwijze
1. Contact-First — roep contact_search ALTIJD aan vóór elke andere actie
2. count=1: ga direct door. count>1: vraag welk contact. count=0: vraag om nieuw contact
3. NOOIT contact_create zonder contact_search
4. Bevestig vóór schrijfacties: "Ik ga [actie] voor [contact] aanmaken — klopt dit?"
5. Afspraken: contact_search → bevestig tijdstip → appointment_create
6. Taken: geef altijd dueDate mee, standaard morgen 09:00 als niet opgegeven
7. Geen technische IDs tonen tenzij gevraagd

## Contacten aanmaken
- Verplicht: companyName, type (lead|customer), city
- NOOIT label of revenue zelf invullen — worden automatisch bepaald
- Altijd bevestigen: "Ik ga [bedrijf] aanmaken als [type] in [stad] — klopt dit?"

## Proactieve intent-detectie
Voor-bezoek — herkent: "ik ga naar X", "ik rijd naar", "briefing voor X"
→ contact_search → contact_briefing — geen tussenvraag, vat samen in 2-3 zinnen

Na-bezoek — herkent: "ik was net bij X", "net terug van", "zojuist bij"
→ contact_search → vraag: "Wat wil je vastleggen?"

## Bevestigingsgedrag
Vraag ALTIJD bevestiging voordat je een contact aanmaakt of wijzigt.

## Verwijderen — verboden
SUUS mag NOOIT iets verwijderen.
"""

# ─── CRM tool executor ────────────────────────────────────────────────────────

async def call_crm_tool(
    tool_name: str,
    args: dict,
    org_id: str,
    room_name: str,
) -> str:
    """Call Next.js /api/voice/tool and return the result string."""
    payload = {
        "name":     tool_name,
        "arguments": args,
        "roomName": room_name,
        "call":     {"metadata": {"organization_id": org_id}},
    }
    try:
        timeout = aiohttp.ClientTimeout(total=30)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(
                f"{NEXT_API_URL}/api/voice/tool",
                json=payload,
            ) as resp:
                data = await resp.json()
                return str(data.get("result", ""))
    except Exception as exc:  # noqa: BLE001
        logger.error("call_crm_tool %s failed: %s", tool_name, exc)
        return f'{{"error": "{exc}"}}'


# ─── Tool factory — closures capture org_id + room_name ──────────────────────

def make_tools(org_id: str, room_name: str) -> list:  # noqa: C901
    async def crm(name: str, args: dict) -> str:
        return await call_crm_tool(name, args, org_id, room_name)

    @function_tool
    async def contact_search(
        ctx: RunContext,
        query: Annotated[str, "Ruwe zoekopdracht, bijv. 'Merijn Amsterdam' of '+31612345678'"],
    ) -> str:
        """Zoek een contact in de CRM op naam, bedrijf, e-mail of telefoonnummer. Roep ALTIJD aan vóór notes, taken of afspraken. Fuzzy matching met automatische spellingcorrectie."""
        return await crm("contact_search", {"query": query})

    @function_tool
    async def contact_create(
        ctx: RunContext,
        companyName: Annotated[str, "Bedrijfsnaam — VERPLICHT"],
        type: Annotated[str, "lead | customer — VERPLICHT"],
        city: Annotated[str, "Plaatsnaam — VERPLICHT"],
        firstName: Annotated[str | None, "Voornaam"] = None,
        lastName:  Annotated[str | None, "Achternaam"] = None,
        email:     Annotated[str | None, "E-mailadres"] = None,
        phone:     Annotated[str | None, "Telefoonnummer bijv. +31612345678"] = None,
        website:   Annotated[str | None, "Website"] = None,
        postcode:  Annotated[str | None, "Postcode"] = None,
    ) -> str:
        """Maak een nieuw contact aan. Roep ALTIJD eerst contact_search aan. Verplichte velden: companyName, type, city."""
        args = {k: v for k, v in {
            "companyName": companyName, "type": type, "city": city,
            "firstName": firstName, "lastName": lastName, "email": email,
            "phone": phone, "website": website, "postcode": postcode,
        }.items() if v is not None}
        return await crm("contact_create", args)

    @function_tool
    async def contact_update(
        ctx: RunContext,
        contactId:   Annotated[str, "Contact ID uit contact_search"],
        firstName:   Annotated[str | None, "Voornaam"] = None,
        lastName:    Annotated[str | None, "Achternaam"] = None,
        email:       Annotated[str | None, "E-mail"] = None,
        phone:       Annotated[str | None, "Telefoonnummer"] = None,
        companyName: Annotated[str | None, "Bedrijfsnaam"] = None,
        type:        Annotated[str | None, "lead | customer"] = None,
        city:        Annotated[str | None, "Stad"] = None,
        assignedTo:  Annotated[str | None, "Naam van de medewerker (uit team_member_list)"] = None,
    ) -> str:
        """Wijzig velden van een bestaand contact. Stuur alleen gewijzigde velden."""
        args = {"contactId": contactId}
        for k, v in {"firstName": firstName, "lastName": lastName, "email": email,
                     "phone": phone, "companyName": companyName, "type": type,
                     "city": city, "assignedTo": assignedTo}.items():
            if v is not None:
                args[k] = v
        return await crm("contact_update", args)

    @function_tool
    async def contact_enrich(
        ctx: RunContext,
        query: Annotated[str, "Bedrijfsnaam + stad, bijv. 'Bakkerij De Molen Amsterdam'"],
    ) -> str:
        """Zoek bedrijfsgegevens op via Google (adres, telefoon, website). Gebruik vóór contact_create als je bedrijfsnaam + stad hebt."""
        return await crm("contact_enrich", {"query": query})

    @function_tool
    async def contact_briefing(
        ctx: RunContext,
        contactId:   Annotated[str, "Contact ID uit contact_search"],
        contactName: Annotated[str | None, "Naam van het contact"] = None,
    ) -> str:
        """Genereer een volledige briefing voor een contact: recente notities, open taken, aankomende afspraken. Gebruik als iemand vraagt 'vertel me over X' of vóór een bezoek."""
        args: dict = {"contactId": contactId}
        if contactName:
            args["contactName"] = contactName
        return await crm("contact_briefing", args)

    @function_tool
    async def note_create(
        ctx: RunContext,
        contactId: Annotated[str, "Contact ID uit contact_search"],
        body:      Annotated[str, "Volledige tekst van de notitie"],
    ) -> str:
        """Voeg een notitie toe aan een contact."""
        return await crm("note_create", {"contactId": contactId, "body": body})

    @function_tool
    async def task_create(
        ctx: RunContext,
        contactId: Annotated[str, "Contact ID uit contact_search"],
        title:     Annotated[str, "Taakomschrijving"],
        dueDate:   Annotated[str, "ISO 8601 datum bijv. 2026-04-02T09:00:00+02:00"],
        body:      Annotated[str | None, "Optionele toelichting"] = None,
    ) -> str:
        """Maak een follow-up taak aan voor een contact. Standaard dueDate: morgen 09:00."""
        args: dict = {"contactId": contactId, "title": title, "dueDate": dueDate}
        if body:
            args["body"] = body
        return await crm("task_create", args)

    @function_tool
    async def task_list(
        ctx: RunContext,
        limit: Annotated[int, "Max aantal resultaten"] = 10,
    ) -> str:
        """Geef openstaande taken voor dit account."""
        return await crm("task_list", {"limit": limit})

    @function_tool
    async def appointment_create(
        ctx: RunContext,
        contactId: Annotated[str, "Contact ID uit contact_search"],
        title:     Annotated[str, "Titel van de afspraak"],
        startTime: Annotated[str, "ISO 8601 startdatum"],
        endTime:   Annotated[str, "ISO 8601 einddatum"],
        location:  Annotated[str | None, "Locatie"] = None,
        notes:     Annotated[str | None, "Notities"] = None,
    ) -> str:
        """Maak een afspraak aan voor een contact. Volgorde: contact_search → bevestig tijdstip → appointment_create."""
        args: dict = {"contactId": contactId, "title": title, "startTime": startTime, "endTime": endTime}
        if location: args["location"] = location
        if notes:    args["notes"] = notes
        return await crm("appointment_create", args)

    @function_tool
    async def appointment_list(
        ctx: RunContext,
        limit: Annotated[int, "Max aantal"] = 10,
    ) -> str:
        """Geef aankomende afspraken voor dit account."""
        return await crm("appointment_list", {"limit": limit})

    @function_tool
    async def team_member_list(ctx: RunContext) -> str:
        """Geef alle medewerkers in dit account. Gebruik dit vóór toewijzen of afspraken inplannen met een collega."""
        return await crm("team_member_list", {})

    @function_tool
    async def contact_list(
        ctx: RunContext,
        limit: Annotated[int, "Max aantal (standaard 20)"] = 20,
    ) -> str:
        """Geef een lijst van contacten in dit account."""
        return await crm("contact_list", {"limit": limit})

    @function_tool
    async def contact_score(
        ctx: RunContext,
        contactId: Annotated[str, "Contact ID uit contact_search"],
    ) -> str:
        """Score een contact: bepaal automatisch label (A/B/C/D) en verwachte jaaromzet via intelligence-systeem."""
        return await crm("contact_score", {"contactId": contactId})

    @function_tool
    async def contact_route(
        ctx: RunContext,
        contactId: Annotated[str, "Contact ID uit contact_search"],
    ) -> str:
        """Routeer een contact: wijs automatisch toe aan een medewerker via routing-configuratie."""
        return await crm("contact_route", {"contactId": contactId})

    @function_tool
    async def log_bezoek(
        ctx: RunContext,
        contactId:    Annotated[str, "Contact ID uit contact_search"],
        samenvatting: Annotated[str, "Samenvatting van het bezoek"],
        producten:    Annotated[str | None, "Besproken producten of diensten"] = None,
        klantType:    Annotated[str | None, "lead | klant — update contact type"] = None,
        vervolgActie: Annotated[str | None, "taak | afspraak | geen"] = None,
        vervolgDatum: Annotated[str | None, "ISO 8601 datum voor vervolg"] = None,
    ) -> str:
        """Log een bezoek: sla notitie op, maak optioneel een vervolgtaak of -afspraak aan, en update het contacttype. Gebruik na 'ik was net bij X'."""
        args: dict = {"contactId": contactId, "samenvatting": samenvatting}
        if producten:    args["producten"]    = producten
        if klantType:    args["klantType"]    = klantType
        if vervolgActie: args["vervolgActie"] = vervolgActie
        if vervolgDatum: args["vervolgDatum"] = vervolgDatum
        return await crm("log_bezoek", args)

    return [
        contact_search, contact_create, contact_update, contact_enrich,
        contact_briefing, note_create, task_create, task_list,
        appointment_create, appointment_list, team_member_list,
        contact_list, contact_score, contact_route, log_bezoek,
    ]


# ─── Agent class ──────────────────────────────────────────────────────────────

def build_instructions() -> str:
    """Inject today/tomorrow dates into system prompt at session start."""
    from datetime import datetime, timedelta
    tz   = "Europe/Amsterdam"
    now  = datetime.now()
    today    = now.strftime("%Y-%m-%d")
    tomorrow = (now + timedelta(days=1)).strftime("%Y-%m-%d")
    time_str = now.strftime("%H:%M")
    return (
        SYSTEM_PROMPT
        + f"\n\n## Huidige datum/tijd\n"
        + f"vandaag={today} | morgen={tomorrow} | tijd={time_str} | surface=voice"
    )


class SuusAgent(Agent):
    def __init__(self, tools: list) -> None:
        super().__init__(
            instructions=build_instructions(),
            tools=tools,
        )

    async def on_enter(self) -> None:
        await self.session.say(
            "Hoi! Ik ben SUUS. "
            "Noem de bedrijf- en plaatsnaam, dan zoek ik het contact voor je op."
        )


# ─── Entrypoint ───────────────────────────────────────────────────────────────

async def entrypoint(ctx: JobContext) -> None:
    await ctx.connect()

    org_id    = (ctx.room.metadata or "").strip() or DEMO_ORG_ID
    room_name = ctx.room.name
    logger.info("SUUS agent started  room=%s  org=%s", room_name, org_id)

    tools   = make_tools(org_id, room_name)
    agent   = SuusAgent(tools=tools)

    session = AgentSession(
        vad=silero.VAD.load(),
        stt=deepgram.STT(
            model="nova-2",
            language="nl",
        ),
        llm=openai_plugin.LLM(model="gpt-4.1"),
        tts=openai_plugin.TTS(
            model="tts-1",
            voice="nova",             # warm, natural — works well for Dutch
        ),
    )

    await session.start(
        room=ctx.room,
        agent=agent,
    )

    # Keep the entrypoint alive until the room closes
    await asyncio.sleep(float("inf"))


# ─── Entry ────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))
