"""
SUUS — LiveKit voice assistant (TaskGroup architecture)

Single SuusAgent runs a TaskGroup cycle per request:
  1. CollectIntentTask   — detect intent + optional company query  → IntentResult
  2. ResolveContactTask  — Google normalize → CRM lookup/create   → ContactResult
  3. ExecuteActionTask   — perform the CRM action                 → ActionResult

Benefits over multi-agent:
  - Shared chat context (automatic, no manual copying)
  - Typed results (compile-time safe)
  - Built-in TaskGroup regression (user can correct earlier step)
  - Tasks complete programmatically (no LLM deciding when to hand off)
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Annotated

import aiohttp
import sentry_sdk
from dotenv import load_dotenv
from livekit import rtc
from livekit.agents import (
    Agent,
    AgentSession,
    AgentTask,
    JobContext,
    RunContext,
    TurnHandlingOptions,
    WorkerOptions,
    cli,
    function_tool,
)
from livekit.agents.beta.tools import EndCallTool
from livekit.agents.beta.workflows import TaskGroup
from livekit.plugins import deepgram, elevenlabs
from livekit.plugins import openai as openai_plugin
from livekit.plugins import silero

load_dotenv(override=True)
logger = logging.getLogger(__name__)

sentry_sdk.init(
    dsn=os.environ.get("SENTRY_DSN", ""),
    traces_sample_rate=0.2,
)

NEXT_API_URL = os.environ.get("NEXT_API_URL", "http://localhost:3000")
DEMO_ORG_ID  = os.environ.get("DEMO_ORG_ID", "")

# Pre-load heavy models once at worker startup — avoids AssignmentTimeoutError
# on first job dispatch (LiveKit Cloud times out if child process is too slow to init)
logger.info("Pre-loading VAD model...")
_VAD = silero.VAD.load(
    # 1.1 s — sales reps pause mid-sentence; default 550 ms is too aggressive.
    min_silence_duration=1.1,
    prefix_padding_duration=0.5,
    # Raise activation threshold slightly to reduce noise-triggered false starts.
    activation_threshold=0.6,
    deactivation_threshold=0.4,
)
logger.info("VAD model ready")



# ─── Shared call state ────────────────────────────────────────────────────────

@dataclass
class CallState:
    org_id:          str           = ""
    room_name:       str           = ""
    room:            rtc.Room | None = field(default=None, repr=False)
    http:            aiohttp.ClientSession | None = field(default=None, repr=False)
    # Set by CollectIntentTask
    intent:          str           = ""
    company_query:   str           = ""
    # Set by ResolveContactTask
    contact_id:      str           = ""
    contact_name:    str           = ""
    contact_company: str           = ""
    contact_address: str           = ""   # Google formatted address for appointments


RunContext_T = RunContext[CallState]


# ─── Typed task results ───────────────────────────────────────────────────────

@dataclass
class IntentResult:
    intent:        str  # pre_bezoek | na_bezoek | notitie | taak | afspraak | briefing | contact_update | nieuw_contact
    company_query: str  # may be empty — ResolveContactTask will ask if so


@dataclass
class ContactResult:
    contact_id:      str
    contact_name:    str
    contact_company: str


@dataclass
class ActionResult:
    summary: str


@dataclass
class BezoekData:
    uitkomst:          str       = ""
    vervolg_actie:     str       = "geen"   # taak | afspraak | geen
    vervolg_datum:     str | None = None
    klant_type:        str       = ""       # lead | klant
    groothandel:       str       = ""
    pos_materiaal:     bool      = False
    korting_afspraken: bool      = False
    producten:         str       = ""
    geannuleerd:       bool      = False


# ─── CRM HTTP helper ──────────────────────────────────────────────────────────

async def call_crm_tool(
    tool_name: str,
    args: dict,
    state: CallState,
    push_card: bool = True,
) -> str:
    # Inject contact context for card display — underscore-prefixed so CRM tools ignore them
    display_args = dict(args)
    if state.contact_company:
        display_args.setdefault("_companyName",    state.contact_company)
    if state.contact_address:
        display_args.setdefault("_contactAddress", state.contact_address)

    payload = {
        "name":      tool_name,
        "arguments": display_args,
        "roomName":  state.room_name,
        "call":      {"metadata": {"organization_id": state.org_id}},
    }
    try:
        http    = state.http or aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=25, connect=3, sock_read=12))
        managed = state.http is None  # close only if we created it
        try:
            async with http.post(f"{NEXT_API_URL}/api/voice/tool", json=payload) as resp:
                data   = await resp.json()
                result = str(data.get("result", ""))
                await _audit_log(tool_name, args, result, state)
                card   = data.get("card")
                if card and push_card and state.room:
                    try:
                        packet = json.dumps({"type": "mini_card", "card": card}).encode()
                        await state.room.local_participant.publish_data(packet, reliable=True)
                        logger.debug("Card pushed: %s", card.get("type"))
                    except Exception as exc:
                        logger.warning("Card push failed: %s", exc)
                return result
        finally:
            if managed:
                await http.close()
    except Exception as exc:
        logger.error("call_crm_tool %s failed: %s", tool_name, exc)
        sentry_sdk.set_context("crm_call", {"tool": tool_name, "room": state.room_name, "org": state.org_id})
        sentry_sdk.capture_exception(exc)
        return f'{{"error": "{exc}"}}'


# ─── Audit log ────────────────────────────────────────────────────────────────

_WRITE_TOOLS = {
    "note_create", "task_create", "appointment_create",
    "log_bezoek", "contact_create", "contact_update",
}


async def _audit_log(tool: str, args: dict, result: str, state: CallState) -> None:
    if tool not in _WRITE_TOOLS:
        return
    try:
        await state.http.post(f"{NEXT_API_URL}/api/voice/audit", json={  # type: ignore[union-attr]
            "org_id": state.org_id,
            "room":   state.room_name,
            "tool":   tool,
            "args":   {k: v for k, v in args.items() if not k.startswith("_")},
            "result": result,
            "ts":     datetime.utcnow().isoformat(),
        })
    except Exception as exc:
        logger.warning("Audit log failed (non-fatal): %s", exc)


# ─── Date context helper ──────────────────────────────────────────────────────

def _date_ctx() -> str:
    now      = datetime.now()
    today    = now.strftime("%Y-%m-%d")
    tomorrow = (now + timedelta(days=1)).strftime("%Y-%m-%d")
    time_str = now.strftime("%H:%M")
    return f"vandaag={today} | morgen={tomorrow} | tijd={time_str}"


# ─── Task 1: CollectIntentTask ────────────────────────────────────────────────

class CollectIntentTask(AgentTask[IntentResult]):
    """
    Detects what the sales rep wants to do.
    Completes with (intent, optional company_query) immediately — no LLM hand-off.
    """

    def __init__(self) -> None:
        super().__init__(
            llm=openai_plugin.LLM(model="gpt-4.1", temperature=0.0),
            instructions=f"""
Je bent SUUS. Detecteer de intent van de gebruiker en roep DIRECT intent_detected aan.

TWEE BRANCHES:

── CRM (klant-gerelateerd) ──────────────────────────────────────
- pre_bezoek          → "ik ga naar X", "briefing voor X", "info over X"
- na_bezoek           → "ik was bij X", "net terug", "bezoek loggen", of ALLEEN bedrijfsnaam
- notitie             → "notitie voor X", "zet op dat bij X"
- taak                → "taak voor X", "herinnering voor X"
- afspraak            → "afspraak met X", "inplannen bij X"
- briefing            → "wie is X", "vertel me over X"
- contact_update      → "update X", "adres van X"
- nieuw_contact       → "voeg X toe", "nieuw bedrijf"

── PERSOONLIJK (geen klant nodig) ───────────────────────────────
- persoonlijk          → "persoonlijk", "voor mezelf", "voor mij", "eigen" ZONDER specifieke actie
- persoonlijke_notitie → "notitie voor mezelf", "onthouden", "persoonlijke notitie", notitie ZONDER bedrijf
- persoonlijke_taak    → "taak voor mezelf", "reminder voor mij", "persoonlijke taak", taak ZONDER bedrijf
- vrije_afspraak       → "afspraak plannen" ZONDER bedrijf, "agenda", persoonlijke afspraak

── OVERIG ────────────────────────────────────────────────────────
- reset               → "ander bedrijf" ZONDER naam, "nieuw gesprek", "terug naar begin", "hoofdmenu"

BESLISSINGSREGELS — in volgorde:

0. Als de gebruiker ALLEEN aangeeft "met een klant" of "voor een klant" (geen bedrijf, geen actie), vraag dan ALLEEN: "Noem bedrijfsnaam en plaatsnaam." — wacht op het antwoord, dan intent_detected met intent="na_bezoek". NOOIT naar actie vragen — dat doet een volgende stap.
1. Bedrijfsnaam DUIDELIJK aanwezig met actie OF stad (bv. "voor [naam]", "[naam] in [stad]", "bij [naam]", "ik was bij [naam]") → CRM-intent + company_query invullen. DIRECT intent_detected aanroepen.
2. "mezelf", "voor mij", "persoonlijk", "mijn agenda", "eigen" aanwezig:
   - Met specifieke actie (notitie/taak/agenda) → gebruik persoonlijke_notitie / persoonlijke_taak / vrije_afspraak.
   - Zonder specifieke actie → intent="persoonlijk". DIRECT intent_detected aanroepen.
3. ALLEEN een bedrijfsnaam + stad zonder verdere context → "na_bezoek" + company_query. DIRECT intent_detected aanroepen.
4. Actiewoord aanwezig (notitie/taak/afspraak) MAAR geen bedrijf EN geen persoonlijk signaal → Stel EEN korte vraag: "Is dit voor een klant of voor jezelf?" — wacht op antwoord, dan intent_detected.
5. Garbled/onbegrijpelijke/onvolledige input → NEGEER, wacht rustig op een duidelijke volgende uiting. NOOIT intent_detected aanroepen op ruis.
6. Nooit zelf CRM-acties uitvoeren. Nooit bevestigen of aankondigen — alleen intent_detected aanroepen of één disambiguatievraag stellen.

""",
        )

    async def on_enter(self) -> None:
        # Inject current date/time at call time, not at worker-startup time.
        self.update_instructions(self.instructions + f"\nDatum/tijd: {_date_ctx()}")

    @function_tool
    async def intent_detected(
        self,
        intent:        Annotated[str, "pre_bezoek | na_bezoek | notitie | taak | afspraak | briefing | contact_update | nieuw_contact | persoonlijke_notitie | persoonlijke_taak | vrije_afspraak | reset"],
        context:       RunContext_T,
        company_query: Annotated[str, "Bedrijfsnaam + stad (leeg voor persoonlijke intents en reset)"] = "",
    ) -> None:
        """Roep aan zodra je de intent herkent. company_query is optioneel."""
        state: CallState = context.userdata
        state.intent        = intent
        state.company_query = company_query.strip()
        # New company OR reset → wipe active contact
        if company_query.strip() or intent == "reset":
            state.contact_id      = ""
            state.contact_name    = ""
            state.contact_company = ""
            state.contact_address = ""
        logger.info("Intent detected: intent=%s  query=%s", intent, company_query)
        self.complete(IntentResult(intent=intent, company_query=company_query.strip()))


# ─── Task 2: ResolveContactTask ───────────────────────────────────────────────

class ResolveContactTask(AgentTask[ContactResult]):
    """
    Resolves the contact via Google normalization + CRM lookup/create.
    Completes programmatically via contact_confirmed / contact_created.
    """

    def __init__(self) -> None:
        super().__init__(
            instructions="""
Je bent SUUS CONTACT. Voer STRIKT in volgorde uit:

STAP 0: Heb je al een bedrijfsnaam in de context?
  - Ja → ga direct naar STAP 1.
  - Nee → vraag EENMALIG: "Noem bedrijfsnaam en plaatsnaam."

STAP 1: Roep DIRECT google_enrich(bedrijfsnaam + stad) aan. Geen aankondiging.

STAP 2a: Google geeft resultaat → zeg: "Ik vond [naam] op [adres] in [stad] — bedoel je die?"
STAP 2b: Google geeft GEEN resultaat (found: false) → zeg: "Ik kan dat bedrijf niet vinden. Kun je de naam spellen?" → wacht → roep google_enrich opnieuw aan met de gespelde naam.

STAP 3: Wacht op bevestiging.
  - Ja → STAP 4.
  - Nee + correctie → roep google_enrich opnieuw aan. Terug naar STAP 2.

STAP 4: Roep crm_search aan met de genormaliseerde naam.
  - Gevonden (1+ resultaat) → zeg "Gevonden in je CRM." → roep DIRECT contact_confirmed aan.
  - Niet gevonden → vraag "Lead of klant?" → roep crm_create aan → roep DIRECT contact_confirmed aan.

KRITIEKE REGELS:
- Na crm_search met resultaat: roep contact_confirmed AAN in DEZELFDE BEURT — geen wachten.
- Na crm_create: roep contact_confirmed AAN in DEZELFDE BEURT.
- Bij gespelde naam: bouw de volledige naam samen voor je google_enrich aanroept.
- Geen smalltalk. Kort en zakelijk. Nederlands.
""",
        )

    async def on_enter(self) -> None:
        state: CallState = self.session.userdata

        # Sticky contact: already resolved and no new company → skip straight to completion
        if state.contact_id and not state.company_query:
            logger.info("ResolveContact: reusing existing contact %s", state.contact_company)
            self.complete(ContactResult(
                contact_id=state.contact_id,
                contact_name=state.contact_name,
                contact_company=state.contact_company,
            ))
            return

        # No contact needed for personal/reset intents → skip resolution
        _personal = {"vrije_afspraak", "persoonlijke_notitie", "persoonlijke_taak", "reset"}
        if state.intent in _personal:
            logger.info("ResolveContact: skipping for intent=%s", state.intent)
            self.complete(ContactResult(contact_id="", contact_name="", contact_company=""))
            return

        # New company mentioned or no contact yet → normal Google lookup flow
        if state.company_query:
            logger.info("ResolveContact: starting with query=%s", state.company_query)
        self.session.generate_reply()

    @function_tool
    async def google_enrich(
        self,
        query:   Annotated[str, "Bedrijfsnaam + stad voor Google-lookup"],
        context: RunContext_T,
    ) -> str:
        """Normaliseer bedrijfsnaam via Google (adres, naam, telefoon)."""
        result = await call_crm_tool("contact_enrich", {"query": query}, context.userdata)
        try:
            data = json.loads(result)
            if data.get("found"):
                context.userdata.contact_address = data.get("formatted") or ""
        except Exception:
            pass
        return result

    @function_tool
    async def crm_search(
        self,
        query:   Annotated[str, "Genormaliseerde bedrijfsnaam + stad"],
        context: RunContext_T,
    ) -> str:
        """Zoek contact op in CRM. Toon geen card — pas tonen na bevestiging."""
        return await call_crm_tool("contact_search", {"query": query}, context.userdata, push_card=False)

    @function_tool
    async def crm_create(
        self,
        companyName: Annotated[str, "Bedrijfsnaam — VERPLICHT"],
        type:        Annotated[str, "lead | customer — VERPLICHT"],
        city:        Annotated[str, "Plaatsnaam — VERPLICHT"],
        context:     RunContext_T,
        firstName:   Annotated[str | None, "Voornaam"] = None,
        phone:       Annotated[str | None, "Telefoon"] = None,
        website:     Annotated[str | None, "Website"] = None,
    ) -> str:
        """Maak nieuw contact aan in CRM."""
        args = {k: v for k, v in {
            "companyName": companyName, "type": type, "city": city,
            "firstName": firstName, "phone": phone, "website": website,
        }.items() if v is not None}
        return await call_crm_tool("contact_create", args, context.userdata)

    @function_tool
    async def contact_confirmed(
        self,
        contact_id:      Annotated[str, "Contact ID uit crm_search of crm_create"],
        contact_name:    Annotated[str, "Weergavenaam"],
        contact_company: Annotated[str, "Bedrijfsnaam"],
        context:         RunContext_T,
    ) -> None:
        """Roep aan zodra contact gevonden of aangemaakt is. Sluit deze stap af."""
        state: CallState = context.userdata
        state.contact_id      = contact_id
        state.contact_name    = contact_name
        state.contact_company = contact_company
        logger.info("Contact resolved: %s  id=%s", contact_company, contact_id)

        # Push the confirmed contact card now (suppressed during search)
        if state.room:
            try:
                card = {
                    "type":      "contact_found",
                    "id":        contact_id,
                    "contactId": contact_id,
                    "title":     contact_company,
                    "subtitle":  contact_name,
                    "meta":      state.contact_address or None,
                }
                packet = json.dumps({"type": "mini_card", "card": card}).encode()
                await state.room.local_participant.publish_data(packet, reliable=True)
                logger.info(json.dumps({"event": "card_pushed", "type": "contact_found", "contact": contact_company, "room": state.room_name}))
            except Exception as exc:
                logger.warning("Confirmed card push failed: %s", exc)

        self.complete(ContactResult(
            contact_id=contact_id,
            contact_name=contact_name,
            contact_company=contact_company,
        ))


# ─── Subtask: LogBezoekTask ───────────────────────────────────────────────────

# Fixed question texts — returned verbatim from each record_ tool so the LLM
# has zero freedom; it must say exactly this as its next utterance.
_Q2 = "Vraag 2: Is er een vervolgafspraak of herinnering nodig? Zo ja, wanneer?"
_Q3 = "Vraag 3: Is dit een prospect of een klant?"
_Q4 = "Vraag 4: Bij welke groothandel bestelt deze klant?"
_Q5 = "Vraag 5: Is er POS-materiaal geplaatst? (ja of nee)"
_Q6 = "Vraag 6: Zijn er kortingafspraken gemaakt? (ja of nee)"
_Q7 = "Laatste vraag: met welke producten werken zij?"


class LogBezoekTask(AgentTask[BezoekData]):
    """
    Collects all 7 bezoek fields via strict sequential Q&A.
    Each record_ tool returns the next question verbatim — LLM must repeat it
    word-for-word, leaving no room for free-form improvisation.
    Completes automatically after record_producten.
    """

    def __init__(self) -> None:
        super().__init__(
            instructions="""
Je bent SUUS. Verzamel 7 bezoekgegevens ÉÉN VOOR ÉÉN.

STRIKTE WERKWIJZE:
1. Wacht op het antwoord van de gebruiker.
2. Roep het juiste record_ tool aan met het antwoord.
3. Spreek de teruggekregen tekst van het tool LETTERLIJK en VOLLEDIG uit als je volgende zin — GEEN eigen woorden, GEEN toevoegingen, GEEN samenvatting.
4. Herhaal stap 1-3 voor elke volgende vraag.

AANVULLINGEN / CORRECTIES:
- Als de gebruiker iets wil toevoegen of corrigeren bij een eerdere vraag: combineer de toevoeging met het bestaande antwoord en roep het juiste record_ tool opnieuw aan. Ga daarna door met de volgende onbeantwoorde vraag (spreek opnieuw de teruggekregen tekst uit).

ANNULEREN:
- Roep annuleer UITSLUITEND aan als de gebruiker letterlijk zegt: "annuleer", "stop", "ik wil stoppen", "terug naar menu", "doe maar niet". NOOIT bij vragen, aanvullingen of correcties.

GEBRUIK ALLEEN de tools hieronder. GEEN andere tools. GEEN eigen CRM-acties.
""",
            # Dedicated STT for structured form input:
            # - smart_format=True: formats dates ("15 april" → "15-04"), numbers, and
            #   boolean words cleanly — safe here because we're not capturing company names.
            # - Tighter keyterm list focused on the specific values expected per question.
            stt=deepgram.STT(
                model="nova-3",
                language="nl",
                smart_format=True,    # formats dates/numbers — intentionally ON here
                no_delay=True,        # don't wait for full sequence before returning
                numerals=True,
                punctuate=True,
                filler_words=False,
                keyterm=[
                    # ── Vraag 2: vervolgactie ────────────────────────────────────
                    "taak", "afspraak", "geen", "vervolgafspraak", "herinnering",
                    "volgende week", "morgen", "overmorgen", "maandag", "dinsdag",
                    "woensdag", "donderdag", "vrijdag",
                    # ── Vraag 3: klanttype ───────────────────────────────────────
                    "prospect", "klant",
                    # ── Vraag 4: groothandel ─────────────────────────────────────
                    "groothandel", "Sligro", "Makro", "Bidfood", "Hanos",
                    "Van Hoeckel", "Metro", "Deli XL", "Lekkerland",
                    # ── Vraag 5-6: ja/nee ────────────────────────────────────────
                    "ja", "nee", "geplaatst", "gemaakt", "geen",
                    "POS materiaal", "kortingafspraken", "korting",
                    # ── Vraag 7: producten ───────────────────────────────────────
                    "wijn", "bier", "gin", "tonic", "whisky", "rum", "vodka",
                    "champagne", "prosecco", "cocktail", "mocktail",
                    "non-alcoholisch", "frisdrank", "water", "koffie",
                    # ── Annuleren ────────────────────────────────────────────────
                    "annuleer", "stoppen", "terug naar menu",
                ],
            ),
        )
        self._data = BezoekData()

    async def on_enter(self) -> None:
        await self.session.say("Eerste vraag: wat was de uitkomst van het bezoek?")

    @function_tool
    async def annuleer(self) -> None:
        """Annuleer de bezoeklog. Gebruik ALLEEN als gebruiker letterlijk zegt: 'annuleer', 'stop', 'ik wil stoppen', 'terug naar menu', 'doe maar niet'."""
        self.complete(BezoekData(geannuleerd=True))

    @function_tool
    async def record_uitkomst(
        self,
        uitkomst: Annotated[str, "Samenvatting / uitkomst van het bezoek"],
    ) -> str:
        """Sla de uitkomst op. Spreek de teruggekregen tekst letterlijk uit."""
        self._data.uitkomst = uitkomst
        return _Q2

    @function_tool
    async def record_vervolg(
        self,
        actie: Annotated[str, "taak | afspraak | geen"],
        datum: Annotated[str | None, "ISO 8601 datum als van toepassing"] = None,
    ) -> str:
        """Sla de vervolgactie op. Spreek de teruggekregen tekst letterlijk uit."""
        self._data.vervolg_actie = actie
        self._data.vervolg_datum = datum
        return _Q3

    @function_tool
    async def record_klanttype(
        self,
        klant_type: Annotated[str, "prospect | klant"],
    ) -> str:
        """Sla op of dit een prospect of klant is. Spreek de teruggekregen tekst letterlijk uit."""
        self._data.klant_type = klant_type
        return _Q4

    @function_tool
    async def record_groothandel(
        self,
        groothandel: Annotated[str, "Naam van de groothandel"],
    ) -> str:
        """Sla de groothandel op. Spreek de teruggekregen tekst letterlijk uit."""
        self._data.groothandel = groothandel
        return _Q5

    @function_tool
    async def record_pos_materiaal(
        self,
        geplaatst: Annotated[bool, "True als POS-materiaal geplaatst is"],
    ) -> str:
        """Sla op of POS-materiaal geplaatst is. Spreek de teruggekregen tekst letterlijk uit."""
        self._data.pos_materiaal = geplaatst
        return _Q6

    @function_tool
    async def record_korting(
        self,
        gemaakt: Annotated[bool, "True als kortingafspraken gemaakt zijn"],
    ) -> str:
        """Sla op of kortingafspraken gemaakt zijn. Spreek de teruggekregen tekst letterlijk uit."""
        self._data.korting_afspraken = gemaakt
        return _Q7

    @function_tool
    async def record_producten(
        self,
        producten: Annotated[str, "Producten waarmee zij werken"],
    ) -> None:
        """Sla de producten op en rond de bezoeklog af. Dit is de laatste vraag."""
        self._data.producten = producten
        self.complete(self._data)


# ─── Task 3: ExecuteActionTask ────────────────────────────────────────────────

class ExecuteActionTask(AgentTask[ActionResult]):
    """
    Performs the requested CRM action on the resolved contact.
    Module-level tools do the real work; action_completed is the completion switch.
    Instructions are built in __init__ from the already-populated CallState
    (the TaskGroup lambda factory runs after previous tasks complete).
    """

    def __init__(self, state: CallState) -> None:
        self._state      = state
        self._intent     = state.intent
        self._auto_start = state.intent in (
            "pre_bezoek", "briefing",
            "notitie", "taak", "afspraak", "vrije_afspraak",
            "contact_update",
            "persoonlijke_notitie", "persoonlijke_taak",
        )
        self._is_personal = state.intent in (
            "persoonlijk", "vrije_afspraak", "persoonlijke_notitie", "persoonlijke_taak",
        )

        intent_map = {
            # ── Direct tool triggers (no menu needed) ──────────────────────────
            "pre_bezoek": (
                "Roep DIRECT _contact_briefing aan — GEEN tekst vooraf, GEEN aankondiging. "
                "Presenteer de briefing in max 3 zinnen, roep daarna action_completed aan."
            ),
            "briefing": (
                "Roep DIRECT _contact_briefing aan — GEEN tekst vooraf, GEEN aankondiging. "
                "Presenteer de briefing in max 3 zinnen, roep daarna action_completed aan."
            ),

            # ── na_bezoek: CRM action menu ─────────────────────────────────────
            "na_bezoek": (
                "Stel DIRECT de vaste vraag: "
                "'Wat wil je doen? Bezoek loggen, briefing, notitie, taak, of agenda?'\n"
                "Wacht op het antwoord. Roep dan DIRECT het juiste tool aan — GEEN tekst, GEEN bevestiging:\n"
                "- 'bezoek loggen' of 'loggen' of 'bezoek' → log_bezoek_start() — DIRECT, geen extra vraag\n"
                "- 'briefing' → _contact_briefing()\n"
                "- 'notitie' → vraag 'Wat moet ik vastleggen?' → wacht → bevestig 'Ik ga noteren: [inhoud] — klopt dit?' → na ja: _note_create()\n"
                "- 'taak' → vraag 'Wat en wanneer?' → wacht → _task_create()\n"
                "- 'agenda' of 'afspraak' → vraag 'Wanneer en hoe laat?' → wacht → _appointment_create()\n"
                "NOOIT een vrije tekstreactie geven. ALTIJD een tool aanroepen."
            ),

            # ── Direct CRM actions (contact already resolved) ──────────────────
            "notitie": (
                "STAP 1: Vraag DIRECT 'Wat moet ik vastleggen?' — GEEN andere tekst.\n"
                "STAP 2: Wacht op de inhoud.\n"
                "STAP 3: Zeg EXACT: 'Ik ga noteren: [inhoud] — klopt dit?'\n"
                "STAP 4: Na 'ja' of bevestiging → _note_create(body=[inhoud]) — DIRECT, GEEN extra tekst.\n"
                "Sla NOOIT op zonder bevestiging. NOOIT vrije tekst tussendoor."
            ),
            "taak": (
                "Vraag DIRECT 'Wat is de taak en wanneer?' (standaard morgen 09:00 als geen datum).\n"
                "Wacht op het antwoord. Roep dan DIRECT _task_create aan — GEEN bevestigingsvraag, GEEN extra tekst."
            ),
            "afspraak": (
                f"Afspraak bij {state.contact_company}"
                + (f" (locatie: {state.contact_address})." if state.contact_address else ".")
                + " Vraag DIRECT 'Wanneer en hoe laat?' — locatie is al bekend, NIET opnieuw vragen.\n"
                "Wacht op het antwoord. Roep dan DIRECT _appointment_create aan — GEEN bevestigingsvraag."
            ),
            "contact_update": (
                "Vraag DIRECT 'Welke gegevens wil je aanpassen?'.\n"
                "Wacht op het antwoord. Roep dan DIRECT _contact_update aan."
            ),
            "nieuw_contact": (
                "Contact is aangemaakt. Vraag DIRECT 'Wil je een notitie of taak toevoegen?'\n"
                "Wacht op het antwoord. Roep dan DIRECT het juiste tool aan:\n"
                "- 'notitie' → vraag inhoud → _note_create()\n"
                "- 'taak' → vraag wat/wanneer → _task_create()\n"
                "- 'nee' of 'klaar' → action_completed()\n"
                "NOOIT vrije tekst. ALTIJD een tool aanroepen."
            ),

            # ── Personal menu ──────────────────────────────────────────────────
            "persoonlijk": (
                "Stel DIRECT de vaste vraag: 'Kan ik iets in je agenda zetten, notitie maken, of een taak aanmaken?'\n"
                "Wacht op het antwoord. Roep dan DIRECT het juiste tool aan — GEEN tekst, GEEN bevestiging:\n"
                "- 'notitie' of 'onthouden' → vraag 'Wat wil je onthouden?' → wacht → _note_create()\n"
                "- 'taak' of 'herinnering' → vraag 'Wat en wanneer?' → wacht → _task_create()\n"
                "- 'agenda' of 'afspraak' → vraag 'Wanneer en wat?' → wacht → _appointment_create()\n"
                "- 'terug' of 'hoofdmenu' of 'met een klant' → action_completed(summary='RESET') — DIRECT\n"
                "NOOIT vrije tekst. ALTIJD een tool aanroepen."
            ),
            "persoonlijke_notitie": (
                "STAP 1: Vraag DIRECT 'Wat wil je onthouden?' — GEEN andere tekst.\n"
                "STAP 2: Wacht op de inhoud.\n"
                "STAP 3: Zeg EXACT: 'Ik noteer: [inhoud] — klopt dit?'\n"
                "STAP 4: Na 'ja' of bevestiging → _note_create(body=[inhoud]) met lege contactId — DIRECT.\n"
                "- 'terug' of 'hoofdmenu' of 'met een klant' → action_completed(summary='RESET') — DIRECT.\n"
                "NOOIT vrije tekst tussendoor."
            ),
            "persoonlijke_taak": (
                "Vraag DIRECT 'Wat is de taak en wanneer?' (standaard morgen 09:00).\n"
                "Wacht op het antwoord. Roep dan DIRECT _task_create aan met lege contactId — GEEN bevestigingsvraag.\n"
                "- 'terug' of 'hoofdmenu' of 'met een klant' → action_completed(summary='RESET') — DIRECT."
            ),
            "vrije_afspraak": (
                "Vrije afspraak (geen vast contact).\n"
                "Vraag DIRECT: 'Wat is het onderwerp, met wie of waar, en wanneer?'\n"
                "Wacht op het antwoord. Gebruik _location_lookup voor het adres indien nodig.\n"
                "Roep dan DIRECT _appointment_create aan met lege contactId — GEEN bevestigingsvraag.\n"
                "- 'terug' of 'hoofdmenu' of 'met een klant' → action_completed(summary='RESET') — DIRECT."
            ),
        }
        intent_instruction = intent_map.get(
            state.intent,
            f"Vraag 'Voor {state.contact_company} — wat wil je doen? "
            "Bezoek loggen, briefing, notitie, taak, of afspraak?'",
        )

        if self._is_personal:
            ctx_header = "Je bent SUUS MANAGER. Persoonlijke actie (geen CRM-contact). contactId is leeg — gebruik dat zo in tool calls."
        elif state.contact_company:
            ctx_header = (
                f"Je bent SUUS MANAGER. Voer uit voor {state.contact_company}.\n"
                f"Contact ID: {state.contact_id} (gebruik dit voor alle tool calls — toon het NOOIT aan de gebruiker)"
            )
        else:
            ctx_header = "Je bent SUUS MANAGER."

        instructions = f"""{ctx_header}

TAAK: {intent_instruction}

REGELS:
- Volg de TAAK-instructie LETTERLIJK. NOOIT vrije tekst genereren buiten de aangegeven vragen.
- Roep altijd het juiste tool aan — GEEN alternatieve tekstreactie.
- Na voltooiing van de actie: roep action_completed aan met een korte samenvatting.
- Geen technische IDs tonen aan de gebruiker.

"""
        super().__init__(
            instructions=instructions,
            tools=[
                _contact_briefing, _note_create, _task_create,
                _appointment_create, _contact_update,
                _task_list, _appointment_list, _location_lookup,
                # log_bezoek_start is a method tool — declared below on the class
            ],
        )

    async def on_enter(self) -> None:
        # Inject current date/time at call time, not at worker-startup time.
        self.update_instructions(self.instructions + f"\nDatum/tijd: {_date_ctx()}")

        if self._intent == "reset":
            # Nothing to do — SuusAgent loop will handle the fresh greeting
            self.complete(ActionResult(summary="reset"))
            return

        if self._auto_start:
            self.session.generate_reply()  # triggers the primary tool immediately (briefing, notitie, etc.)
        elif self._is_personal:
            # Generic personal branch — always show a fixed menu first
            await self.session.say(
                "Kan ik iets in je agenda zetten of een persoonlijke notitie maken?"
            )
        else:
            # CRM branch (na_bezoek or unknown) — show the CRM action menu
            await self.session.say(
                "Wat wil je doen? Bezoek loggen, briefing, notitie, taak, of agenda?"
            )

    @function_tool
    async def log_bezoek_start(
        self,
        context: RunContext_T,
    ) -> str:
        """Start het stap-voor-stap loggen van een klantbezoek. Roep aan zodra de gebruiker 'bezoek loggen' kiest."""
        # LogBezoekTask cannot be awaited from inside a function-tool coroutine because
        # function-tool tasks do not have inline_task=True in their activity context.
        # Signal BEZOEK_START through the ActionResult; SuusAgent.on_enter handles it
        # at the top-level loop where inline_task=True is guaranteed.
        self.complete(ActionResult(summary="BEZOEK_START"))
        return "BEZOEK_START"

    @function_tool
    async def action_completed(
        self,
        summary: Annotated[str, "Korte omschrijving van wat gedaan is"],
        context: RunContext_T,
    ) -> None:
        """Roep aan zodra de gevraagde actie succesvol voltooid is."""
        logger.info("Action completed: %s", summary)
        self.complete(ActionResult(summary=summary))


# ─── Module-level CRM tools (used by ExecuteActionTask) ──────────────────────

@function_tool
async def _contact_briefing(context: RunContext_T) -> str:
    """Genereer briefing: recente notities, open taken, afspraken."""
    state = context.userdata
    return await call_crm_tool("contact_briefing", {"contactId": state.contact_id}, state)


@function_tool
async def _note_create(
    body:    Annotated[str, "Volledige tekst van de notitie"],
    context: RunContext_T,
) -> str:
    """Voeg notitie toe aan het contact."""
    state = context.userdata
    return await call_crm_tool("note_create", {"contactId": state.contact_id, "body": body}, state)


@function_tool
async def _task_create(
    title:   Annotated[str, "Taakomschrijving"],
    dueDate: Annotated[str, "ISO 8601 datum bijv. 2026-04-02T09:00:00+02:00"],
    context: RunContext_T,
    body:    Annotated[str | None, "Optionele toelichting"] = None,
) -> str:
    """Maak follow-up taak aan. Standaard dueDate: morgen 09:00."""
    state = context.userdata
    args: dict = {"contactId": state.contact_id, "title": title, "dueDate": dueDate}
    if body:
        args["body"] = body
    return await call_crm_tool("task_create", args, state)


@function_tool
async def _appointment_create(
    title:     Annotated[str, "Titel"],
    startTime: Annotated[str, "ISO 8601 start"],
    endTime:   Annotated[str, "ISO 8601 eind"],
    context:   RunContext_T,
    location:  Annotated[str | None, "Locatie"] = None,
    notes:     Annotated[str | None, "Notities"] = None,
) -> str:
    """Maak afspraak aan. Vraag altijd datum + tijdstip eerst."""
    state = context.userdata
    args: dict = {"contactId": state.contact_id, "title": title, "startTime": startTime, "endTime": endTime}
    if location: args["location"] = location
    if notes:    args["notes"]    = notes
    return await call_crm_tool("appointment_create", args, state)



@function_tool
async def _contact_update(
    context:     RunContext_T,
    firstName:   Annotated[str | None, "Voornaam"] = None,
    lastName:    Annotated[str | None, "Achternaam"] = None,
    email:       Annotated[str | None, "E-mail"] = None,
    phone:       Annotated[str | None, "Telefoon"] = None,
    companyName: Annotated[str | None, "Bedrijfsnaam"] = None,
    type:        Annotated[str | None, "lead | customer"] = None,
    city:        Annotated[str | None, "Stad"] = None,
) -> str:
    """Wijzig contactvelden. Stuur alleen gewijzigde velden."""
    state = context.userdata
    args: dict = {"contactId": state.contact_id}
    for k, v in {"firstName": firstName, "lastName": lastName, "email": email,
                 "phone": phone, "companyName": companyName, "type": type, "city": city}.items():
        if v is not None:
            args[k] = v
    return await call_crm_tool("contact_update", args, state)


@function_tool
async def _location_lookup(
    query: Annotated[str, "Bedrijfsnaam of adres om op te zoeken via Google"],
    context: RunContext_T,
) -> str:
    """Zoek een adres op via Google Places — voor vrije afspraken zonder CRM-contact."""
    return await call_crm_tool("contact_enrich", {"query": query}, context.userdata, push_card=False)


@function_tool
async def _task_list(context: RunContext_T) -> str:
    """Geef openstaande taken voor het contact."""
    state = context.userdata
    return await call_crm_tool("task_list", {"contactId": state.contact_id, "limit": 10}, state)


@function_tool
async def _appointment_list(context: RunContext_T) -> str:
    """Geef aankomende afspraken voor het contact."""
    state = context.userdata
    return await call_crm_tool("appointment_list", {"contactId": state.contact_id, "limit": 10}, state)


# ─── Main Agent ───────────────────────────────────────────────────────────────

class SuusAgent(Agent):
    """
    Single permanent agent. on_enter loops through TaskGroup cycles:
      greeting → [intent → contact → action] → "nog iets?" → repeat
    TaskGroup MUST be awaited from on_enter (LiveKit restriction).
    """

    def __init__(self) -> None:
        end_call = EndCallTool(
            extra_description="Gebruik dit als de gebruiker wil ophangen, zegt 'tot ziens', 'doei', 'dag', of aangeeft klaar te zijn.",
            delete_room=True,
            end_instructions="Zeg vriendelijk tot ziens in het Nederlands. Kort en zakelijk.",
        )
        super().__init__(
            instructions="Je bent SUUS, AI-assistent voor B2B-sales.",
            tools=end_call.tools,
        )

    async def on_enter(self) -> None:
        state: CallState = self.session.userdata
        logger.info(json.dumps({"event": "on_enter_fired", "room": state.room_name}))

        await self.session.say("Hoi met SUUS! Wil je persoonlijk iets doen of met een klant?")
        logger.info(json.dumps({"event": "greeting_sent", "room": state.room_name}))

        while True:
            task_group = TaskGroup(
                chat_ctx=self.chat_ctx,
                summarize_chat_ctx=True,
            )
            task_group.add(
                lambda: CollectIntentTask(),
                id="collect_intent",
                description="Detect what the user wants to do (intent + optional company)",
            )
            task_group.add(
                lambda: ResolveContactTask(),
                id="resolve_contact",
                description="Look up the company via Google and find/create in CRM",
            )
            task_group.add(
                lambda: ExecuteActionTask(state),
                id="execute_action",
                description="Perform the requested CRM action on the resolved contact",
            )

            try:
                _ = asyncio.current_task()
                results = await task_group
                action: ActionResult | None = results.task_results.get("execute_action")  # type: ignore[assignment]
                if action:
                    logger.info("Cycle complete: %s", action.summary)
            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.error("TaskGroup cycle failed: %s", exc)
                sentry_sdk.capture_exception(exc)
                try:
                    await self.session.say("Er is iets misgegaan. Probeer het opnieuw.")
                except Exception:
                    break  # session is shutting down (e.g. silence timeout fired) — exit cleanly
                continue  # don't break the loop — try again

            # ── BEZOEK_START: LogBezoekTask must run here (on_enter has inline_task=True) ──
            if action and action.summary == "BEZOEK_START":
                logger.info("BEZOEK_START received — launching LogBezoekTask")
                try:
                    data: BezoekData = await LogBezoekTask()
                    logger.info("LogBezoekTask completed, geannuleerd=%s", data.geannuleerd)
                except Exception as exc:
                    logger.error("LogBezoekTask failed: %s", exc, exc_info=True)
                    await self.session.say("Er ging iets mis met het loggen. Probeer opnieuw.")
                    state.intent = ""
                    state.company_query = ""
                    continue
                if not data.geannuleerd:
                    bezoek_args: dict = {
                        "contactId":    state.contact_id,
                        "companyName":  state.contact_company,
                        "samenvatting": data.uitkomst,
                    }
                    if data.producten:                      bezoek_args["producten"]         = data.producten
                    if data.klant_type:                     bezoek_args["klantType"]         = data.klant_type
                    if data.vervolg_actie:                  bezoek_args["vervolgActie"]      = data.vervolg_actie
                    if data.vervolg_datum:                  bezoek_args["vervolgDatum"]      = data.vervolg_datum
                    if data.groothandel:                    bezoek_args["groothandel"]       = data.groothandel
                    if data.pos_materiaal is not None:      bezoek_args["pos_materiaal"]     = data.pos_materiaal
                    if data.korting_afspraken is not None:  bezoek_args["korting_afspraken"] = data.korting_afspraken
                    await call_crm_tool("log_bezoek", bezoek_args, state)
                    await self.session.say("Bezoek gelogd!")
                else:
                    await self.session.say(
                        "Bezoeklog geannuleerd. "
                        "Wat wil je doen? Bezoek loggen, briefing, notitie, taak, of agenda?"
                    )
                state.intent        = ""
                state.company_query = ""
                continue  # skip end-of-cycle prompt — loop back directly

            # Reset intent/query for next cycle
            was_reset = (
                state.intent == "reset"
                or bool(action and action.summary == "RESET")
            )
            state.intent        = ""
            state.company_query = ""
            if was_reset:
                state.contact_company = ""
                state.contact_id      = ""
                state.contact_address = ""

            if was_reset or not state.contact_company:
                await self.session.say("Wil je persoonlijk iets doen of met een klant?")
            else:
                await self.session.say(
                    f"Nog iets voor {state.contact_company}, "
                    "persoonlijk iets doen, of een andere klant?"
                )


# ─── Entrypoint ───────────────────────────────────────────────────────────────

async def entrypoint(ctx: JobContext) -> None:
    logger.info("=== ENTRYPOINT CALLED === room=%s", ctx.room.name)
    logger.info("NEXT_API_URL=%s", os.environ.get("NEXT_API_URL", "NOT SET"))
    logger.info("DEEPGRAM_API_KEY set=%s", bool(os.environ.get("DEEPGRAM_API_KEY")))
    logger.info("ELEVENLABS_API_KEY set=%s", bool(os.environ.get("ELEVENLABS_API_KEY") or os.environ.get("ELEVEN_API_KEY")))
    logger.info("OPENAI_API_KEY set=%s", bool(os.environ.get("OPENAI_API_KEY")))

    await ctx.connect()
    logger.info("Connected to room: %s", ctx.room.name)

    # Guard against duplicate dispatch: exit if another SUUS agent is already active.
    existing_agents = [
        p for p in ctx.room.remote_participants.values()
        if getattr(p, "kind", None) == rtc.ParticipantKind.PARTICIPANT_KIND_AGENT
    ]
    if existing_agents:
        logger.warning(json.dumps({
            "event": "duplicate_agent_exit",
            "room":  ctx.room.name,
            "other": [p.identity for p in existing_agents],
        }))
        return

    org_id    = (ctx.room.metadata or "").strip() or DEMO_ORG_ID
    room_name = ctx.room.name
    logger.info(json.dumps({
        "event": "call_start",
        "room":  room_name,
        "org":   org_id,
        "ts":    datetime.utcnow().isoformat(),
    }))

    state = CallState(
        org_id=org_id,
        room_name=room_name,
        room=ctx.room,
        http=aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=25, connect=3, sock_read=12)),
    )

    # VAD interruption fires as soon as speech is detected — more responsive than
    # adaptive (which needs ~1s of audio to classify). Better for short commands like "stop".
    # Dynamic endpointing: min_delay 1.1s gives room for Dutch compound words and
    # mid-sentence hesitations without being too sluggish.
    turn_handling = TurnHandlingOptions(
        interruption={"mode": "vad"},
        endpointing={"mode": "dynamic", "min_delay": 0.6, "max_delay": 4.0},
    )

    session = AgentSession[CallState](
        userdata=state,
        vad=_VAD,
        stt=deepgram.STT(
            model="nova-3",
            language="nl",
            smart_format=False,
            numerals=True,
            punctuate=True,
            filler_words=False,
            keyterm=[
                "bezoek", "bezoek loggen", "briefing", "notitie", "taak",
                "afspraak", "agenda", "loggen", "aanmaken", "opzoeken",
                "samenvatting", "vervolg", "vervolgactie", "follow-up",
                "lead", "klant", "prospect", "groothandel", "horeca",
                "contactpersoon", "bedrijf", "organisatie",
                "korting", "kortingafspraken", "pos materiaal",
                "juist", "precies", "klopt", "correct", "exact",
                "annuleren", "geannuleerd", "stoppen",
                "Amsterdam", "Rotterdam", "Utrecht", "Den Haag", "Eindhoven",
                "Groningen", "Tilburg", "Almere", "Breda", "Nijmegen",
                "Haarlem", "Arnhem", "Zaandam", "Amersfoort", "Apeldoorn",
                "Risottini", "SUUS",
            ],
        ),
        llm=openai_plugin.LLM(model="gpt-4.1", temperature=0.0),
        tts=elevenlabs.TTS(
            model="eleven_turbo_v2_5",
            voice_id="XJa38TJgDqYhj5mYbSJA",
            language="nl",
            voice_settings=elevenlabs.VoiceSettings(
                stability=0.75,        # more consistent pronunciation of company names
                similarity_boost=0.75, # slight reduction prevents over-processing
                style=0.0,             # style adds latency and occasional artifacts
                speed=1.0,             # slower = clearer, especially for confirmations
            ),
        ),
        **( {"turn_handling": turn_handling} if turn_handling else {} ),
    )

    agent = SuusAgent()
    await session.start(room=ctx.room, agent=agent)
    logger.info("Session started, agent=%s", agent)
    # on_enter handles greeting + cycle loop

    async def _cleanup() -> None:
        logger.info(json.dumps({
            "event": "call_end",
            "room":  room_name,
            "org":   org_id,
            "ts":    datetime.utcnow().isoformat(),
        }))
        if state.http:
            await state.http.close()

    ctx.add_shutdown_callback(_cleanup)


# ─── Entry ────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint, agent_name="suus"))
