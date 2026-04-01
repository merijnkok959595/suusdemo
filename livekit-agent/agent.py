"""
SUUS — LiveKit multi-agent voice assistant
Three focused agents:
  1. SuusRouter   — begroet + intent detectie → hand off naar SUZY
  2. SuzyContact  — contact resolver: search / normalize / Google / confirm / create
  3. SusanneAction — voert CRM actie uit op het opgeloste contact
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Annotated

import aiohttp
from dotenv import load_dotenv
from livekit.agents import (
    Agent,
    AgentSession,
    JobContext,
    RunContext,
    TurnHandlingOptions,
    WorkerOptions,
    cli,
    function_tool,
)
from livekit.plugins import deepgram, openai as openai_plugin, silero

load_dotenv()
logger = logging.getLogger(__name__)

NEXT_API_URL = os.environ.get("NEXT_API_URL", "http://localhost:3000")
DEMO_ORG_ID  = os.environ.get("DEMO_ORG_ID", "")


# ─── Shared call state ────────────────────────────────────────────────────────

@dataclass
class CallState:
    org_id: str
    room_name: str
    intent: str = ""
    contact_id: str = ""
    contact_name: str = ""
    contact_company: str = ""


# ─── CRM HTTP helper ──────────────────────────────────────────────────────────

async def call_crm_tool(tool_name: str, args: dict, state: CallState) -> str:
    payload = {
        "name":      tool_name,
        "arguments": args,
        "roomName":  state.room_name,
        "call":      {"metadata": {"organization_id": state.org_id}},
    }
    try:
        timeout = aiohttp.ClientTimeout(total=30)
        async with aiohttp.ClientSession(timeout=timeout) as http:
            async with http.post(f"{NEXT_API_URL}/api/voice/tool", json=payload) as resp:
                data = await resp.json()
                return str(data.get("result", ""))
    except Exception as exc:  # noqa: BLE001
        logger.error("call_crm_tool %s failed: %s", tool_name, exc)
        return f'{{"error": "{exc}"}}'


# ─── Date context helper ──────────────────────────────────────────────────────

def _date_ctx() -> str:
    now      = datetime.now()
    today    = now.strftime("%Y-%m-%d")
    tomorrow = (now + timedelta(days=1)).strftime("%Y-%m-%d")
    time_str = now.strftime("%H:%M")
    return f"vandaag={today} | morgen={tomorrow} | tijd={time_str}"


# ─── Tool factories ───────────────────────────────────────────────────────────

def make_router_tools(state: CallState) -> list:
    """SUUS router: één tool om intent + bedrijfsnaam te capturen en door te sturen."""

    @function_tool
    async def start_contact_lookup(
        ctx: RunContext,
        intent: Annotated[
            str,
            "pre_bezoek | na_bezoek | notitie | taak | afspraak | briefing | contact_update | nieuw_contact",
        ],
        query: Annotated[str, "Bedrijfsnaam + stad die de gebruiker noemde, bijv. 'Bakkerij De Molen Amsterdam'"],
    ) -> str:
        """
        Roep aan zodra je de intent én bedrijfsnaam hebt herkend.
        Stuurt door naar SUZY voor contact-verificatie.
        """
        state.intent = intent
        logger.info("Router → SUZY  intent=%s  query=%s", intent, query)
        suzy = SuzyContactResolver(state=state, initial_query=query)
        await ctx.session.update_agent(suzy)
        return f"Doorverbonden naar contactzoeker voor: {query}"

    return [start_contact_lookup]


def make_contact_tools(state: CallState) -> list:
    """SUZY: contacten zoeken, verrijken, aanmaken en doorsturen naar SUSANNE."""

    async def crm(name: str, args: dict) -> str:
        return await call_crm_tool(name, args, state)

    @function_tool
    async def contact_search(
        ctx: RunContext,
        query: Annotated[str, "Naam + stad, bijv. 'Bakkerij De Molen Amsterdam'"],
    ) -> str:
        """Zoek een contact op naam, bedrijf, e-mail of telefoon. Altijd als eerste stap."""
        return await crm("contact_search", {"query": query})

    @function_tool
    async def contact_enrich(
        ctx: RunContext,
        query: Annotated[str, "Bedrijfsnaam + stad voor Google-lookup"],
    ) -> str:
        """Haal bedrijfsgegevens op via Google: adres, telefoon, website. Gebruik als contact_search 0 resultaten geeft."""
        return await crm("contact_enrich", {"query": query})

    @function_tool
    async def contact_create(
        ctx: RunContext,
        companyName: Annotated[str, "Bedrijfsnaam — VERPLICHT"],
        type:        Annotated[str, "lead | customer — VERPLICHT"],
        city:        Annotated[str, "Plaatsnaam — VERPLICHT"],
        firstName:   Annotated[str | None, "Voornaam"] = None,
        lastName:    Annotated[str | None, "Achternaam"] = None,
        email:       Annotated[str | None, "E-mail"] = None,
        phone:       Annotated[str | None, "Telefoon bijv. +31612345678"] = None,
        website:     Annotated[str | None, "Website"] = None,
        postcode:    Annotated[str | None, "Postcode"] = None,
    ) -> str:
        """Maak nieuw contact aan. Gebruik ALTIJD contact_enrich vóór aanmaken."""
        args = {k: v for k, v in {
            "companyName": companyName, "type": type, "city": city,
            "firstName": firstName, "lastName": lastName, "email": email,
            "phone": phone, "website": website, "postcode": postcode,
        }.items() if v is not None}
        return await crm("contact_create", args)

    @function_tool
    async def contact_resolved(
        ctx: RunContext,
        contact_id:      Annotated[str, "Contact ID uit contact_search of contact_create"],
        contact_name:    Annotated[str, "Weergavenaam, bijv. 'Bakkerij De Molen'"],
        contact_company: Annotated[str, "Bedrijfsnaam"],
    ) -> str:
        """
        Roep aan zodra de gebruiker het contact bevestigd heeft.
        Slaat de contactgegevens op en geeft door aan SUSANNE voor de gevraagde actie.
        """
        state.contact_id      = contact_id
        state.contact_name    = contact_name
        state.contact_company = contact_company
        logger.info("SUZY → SUSANNE  contact=%s  id=%s  intent=%s", contact_name, contact_id, state.intent)
        susanne = SusanneAction(state=state)
        await ctx.session.update_agent(susanne)
        return f"Contact opgelost: {contact_name}"

    return [contact_search, contact_enrich, contact_create, contact_resolved]


def make_action_tools(state: CallState) -> list:
    """SUSANNE: alle CRM schrijfacties op het al-opgeloste contact."""

    async def crm(name: str, args: dict) -> str:
        return await call_crm_tool(name, args, state)

    @function_tool
    async def contact_briefing(ctx: RunContext) -> str:
        """Genereer een volledige briefing: recente notities, open taken, aankomende afspraken."""
        return await crm("contact_briefing", {"contactId": state.contact_id})

    @function_tool
    async def note_create(
        ctx: RunContext,
        body: Annotated[str, "Volledige tekst van de notitie"],
    ) -> str:
        """Voeg een notitie toe aan het contact."""
        return await crm("note_create", {"contactId": state.contact_id, "body": body})

    @function_tool
    async def task_create(
        ctx: RunContext,
        title:   Annotated[str, "Taakomschrijving"],
        dueDate: Annotated[str, "ISO 8601 datum bijv. 2026-04-02T09:00:00+02:00"],
        body:    Annotated[str | None, "Optionele toelichting"] = None,
    ) -> str:
        """Maak een follow-up taak aan. Standaard dueDate: morgen 09:00."""
        args: dict = {"contactId": state.contact_id, "title": title, "dueDate": dueDate}
        if body:
            args["body"] = body
        return await crm("task_create", args)

    @function_tool
    async def appointment_create(
        ctx: RunContext,
        title:     Annotated[str, "Titel van de afspraak"],
        startTime: Annotated[str, "ISO 8601 start"],
        endTime:   Annotated[str, "ISO 8601 eind"],
        location:  Annotated[str | None, "Locatie"] = None,
        notes:     Annotated[str | None, "Notities"] = None,
    ) -> str:
        """Maak een afspraak aan. Vraag altijd datum + tijdstip vóór aanmaken."""
        args: dict = {
            "contactId": state.contact_id, "title": title,
            "startTime": startTime, "endTime": endTime,
        }
        if location: args["location"] = location
        if notes:    args["notes"]    = notes
        return await crm("appointment_create", args)

    @function_tool
    async def log_bezoek(
        ctx: RunContext,
        samenvatting:  Annotated[str, "Samenvatting van het bezoek"],
        producten:     Annotated[str | None, "Besproken producten of diensten"] = None,
        klantType:     Annotated[str | None, "lead | klant — update contact type"] = None,
        vervolgActie:  Annotated[str | None, "taak | afspraak | geen"] = None,
        vervolgDatum:  Annotated[str | None, "ISO 8601 datum voor vervolg"] = None,
    ) -> str:
        """Log een bezoek: sla notitie op, maak optioneel vervolgtaak/-afspraak, update contacttype."""
        args: dict = {"contactId": state.contact_id, "samenvatting": samenvatting}
        if producten:    args["producten"]    = producten
        if klantType:    args["klantType"]    = klantType
        if vervolgActie: args["vervolgActie"] = vervolgActie
        if vervolgDatum: args["vervolgDatum"] = vervolgDatum
        return await crm("log_bezoek", args)

    @function_tool
    async def contact_update(
        ctx: RunContext,
        firstName:   Annotated[str | None, "Voornaam"] = None,
        lastName:    Annotated[str | None, "Achternaam"] = None,
        email:       Annotated[str | None, "E-mail"] = None,
        phone:       Annotated[str | None, "Telefoonnummer"] = None,
        companyName: Annotated[str | None, "Bedrijfsnaam"] = None,
        type:        Annotated[str | None, "lead | customer"] = None,
        city:        Annotated[str | None, "Stad"] = None,
    ) -> str:
        """Wijzig velden van het contact. Stuur alleen gewijzigde velden."""
        args: dict = {"contactId": state.contact_id}
        for k, v in {
            "firstName": firstName, "lastName": lastName, "email": email,
            "phone": phone, "companyName": companyName, "type": type, "city": city,
        }.items():
            if v is not None:
                args[k] = v
        return await crm("contact_update", args)

    @function_tool
    async def task_list(ctx: RunContext) -> str:
        """Geef openstaande taken voor het contact."""
        return await crm("task_list", {"contactId": state.contact_id, "limit": 10})

    @function_tool
    async def appointment_list(ctx: RunContext) -> str:
        """Geef aankomende afspraken voor het contact."""
        return await crm("appointment_list", {"contactId": state.contact_id, "limit": 10})

    return [
        contact_briefing, note_create, task_create, appointment_create,
        log_bezoek, contact_update, task_list, appointment_list,
    ]


# ─── Prompts ──────────────────────────────────────────────────────────────────

ROUTER_PROMPT = """\
## Rol
Je bent SUUS, vriendelijke AI-assistent voor B2B-sales.
Jouw ENIGE taak: begroet de sales rep, detecteer intent + bedrijfsnaam, stuur door.

## Intent categorieën
- pre_bezoek   → "ik ga naar X", "briefing voor X", "ik rijd naar X"
- na_bezoek    → "ik was bij X", "net terug van X", "zojuist bij X"
- notitie      → "notitie voor X", "zet op dat X"
- taak         → "taak voor X", "herinner me om X"
- afspraak     → "afspraak met X", "inplannen bij X"
- briefing     → "wie is X", "vertel me over X", "info over X"
- contact_update → "adres van X is", "update X"
- nieuw_contact  → "voeg X toe", "nieuw bedrijf X"

## Werkwijze
1. Groet warm en kort.
2. Luister — zodra je bedrijfsnaam + (optioneel) stad herkent → roep start_contact_lookup aan.
3. Vraag bij onduidelijkheid MAXIMAAL één korte vraag: "Welke stad?"
4. Ga NOOIT zelf CRM-acties uitvoeren — dat doet SUZY of SUSANNE.

## Taal
Nederlands. Korte zinnen. Geen technische termen.
"""

CONTACT_RESOLVER_PROMPT = """\
## Rol
Je bent SUZY, contact-resolver voor SUUS.
Jouw ENIGE taak: het juiste contact vinden of aanmaken, dan doorsturen naar SUSANNE.

## Vaste flow (volg ALTIJD deze volgorde)
Stap 1 → contact_search("{initial_query}") — doe dit DIRECT, geen aankondiging
Stap 2A — 1 resultaat  → "Ik heb [naam] bij [bedrijf] gevonden — bedoel je die?"
Stap 2B — 2+ resultaten → "Welk contact bedoel je: [lijst met namen + steden]?"
Stap 2C — 0 resultaten  → contact_enrich (Google) → presenteer data → vraag bevestiging → contact_create
Stap 3  — na 'ja' van gebruiker → contact_resolved(contact_id, contact_name, contact_company)

## Regels
- contact_resolved NOOIT aanroepen zonder expliciete bevestiging van de gebruiker
- contact_create NOOIT zonder contact_enrich gedaan te hebben
- Geen small talk — focus op contact vinden
- Stap 1 uitvoeren zonder te vragen of aankondigen

## Taal
Nederlands. Kort en zakelijk.
"""

_ACTION_INTENT_MAP = {
    "pre_bezoek":     "Roep direct contact_briefing aan en vat samen in 2-3 zinnen.",
    "na_bezoek":      "Stel deze 3 vragen opeenvolgend: (1) Wat was het doel? (2) Hoe verliep het? (3) Wat is de vervolgactie? Dan log_bezoek.",
    "notitie":        "Vraag wat de notitie moet zijn. Dan note_create.",
    "taak":           "Vraag de taakomschrijving. Standaard dueDate morgen 09:00 tenzij anders. Dan task_create.",
    "afspraak":       "Vraag datum, tijd en locatie. Dan appointment_create.",
    "briefing":       "Roep direct contact_briefing aan.",
    "contact_update": "Vraag welke velden gewijzigd moeten worden. Dan contact_update.",
    "nieuw_contact":  "Het contact is al aangemaakt. Vraag: 'Wil je ook een notitie of taak toevoegen?'",
}


def _build_action_prompt(state: CallState) -> str:
    intent_instruction = _ACTION_INTENT_MAP.get(state.intent, "Vraag hoe je verder kunt helpen.")
    return f"""\
## Rol
Je bent SUSANNE, actie-uitvoerder voor SUUS.
Contact: {state.contact_name} ({state.contact_company})
Contact ID: {state.contact_id}
Intent: {state.intent}

## Jouw taak
{intent_instruction}

## Regels
- Je hebt het contact ID al — vraag er NOOIT naar
- Bevestig schrijfacties vóór uitvoering: "Ik ga [actie] aanmaken — klopt dit?"
- Geen technische IDs tonen
- Na voltooiing: vraag of er nog iets anders moet

## Datum/tijd
{_date_ctx()}
"""


# ─── Agent classes ────────────────────────────────────────────────────────────

class SuusRouter(Agent):
    def __init__(self, state: CallState) -> None:
        super().__init__(
            instructions=ROUTER_PROMPT + f"\n\n## Datum/tijd\n{_date_ctx()}",
            tools=make_router_tools(state),
        )

    async def on_enter(self) -> None:
        await self.session.say(
            "Hoi! Ik ben SUUS. "
            "Noem de bedrijf- en plaatsnaam, dan help ik je direct verder."
        )


class SuzyContactResolver(Agent):
    def __init__(self, state: CallState, initial_query: str = "") -> None:
        prompt = CONTACT_RESOLVER_PROMPT.replace("{initial_query}", initial_query or "het gevraagde contact")
        super().__init__(
            instructions=prompt,
            tools=make_contact_tools(state),
        )

    async def on_enter(self) -> None:
        pass  # SUZY start meteen met zoeken vanuit de prompt, geen extra begroeting


class SusanneAction(Agent):
    def __init__(self, state: CallState) -> None:
        self._state = state
        super().__init__(
            instructions=_build_action_prompt(state),
            tools=make_action_tools(state),
        )

    async def on_enter(self) -> None:
        intent = self._state.intent
        name   = self._state.contact_name or self._state.contact_company

        greetings = {
            "pre_bezoek":     f"Even de briefing voor {name} ophalen...",
            "na_bezoek":      f"Goed, {name} gevonden. Wat was het doel van het bezoek?",
            "notitie":        f"Wat moet ik vastleggen voor {name}?",
            "taak":           f"Wat moet ik onthouden voor {name}, en wanneer?",
            "afspraak":       f"Wanneer wil je een afspraak met {name}?",
            "briefing":       f"Even {name} opzoeken...",
            "contact_update": f"Wat moet ik aanpassen voor {name}?",
        }
        msg = greetings.get(intent, f"Ik heb {name} gevonden. Waarmee kan ik je helpen?")
        await self.session.say(msg)


# ─── Entrypoint ───────────────────────────────────────────────────────────────

async def entrypoint(ctx: JobContext) -> None:
    await ctx.connect()

    org_id    = (ctx.room.metadata or "").strip() or DEMO_ORG_ID
    room_name = ctx.room.name
    logger.info("SUUS agent started  room=%s  org=%s", room_name, org_id)

    state  = CallState(org_id=org_id, room_name=room_name)
    router = SuusRouter(state=state)

    session = AgentSession(
        vad=silero.VAD.load(),
        stt=deepgram.STT(model="nova-2", language="nl"),
        llm=openai_plugin.LLM(model="gpt-4.1"),
        tts=openai_plugin.TTS(model="tts-1", voice="nova"),
        turn_handling=TurnHandlingOptions(interruption={"mode": "adaptive"}),
    )

    await session.start(room=ctx.room, agent=router)


# ─── Entry ────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))
