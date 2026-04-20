"""
CDST LLM Client
===============
Shared Gemini client instance imported by all three stage files.
API key is read from the GEMINI_API_KEY environment variable.
"""

import asyncio
import logging

from google import genai
from google.genai.errors import APIError

log = logging.getLogger(__name__)

gemini = genai.Client()

_RETRY_STATUSES = {503, 429}
_MAX_RETRIES    = 5
_BASE_DELAY     = 10.0  # seconds — give Gemini time to recover from overload


def response_text(response) -> str:
    """Extract full text from a Gemini response, concatenating all parts."""
    try:
        parts = response.candidates[0].content.parts
        return "".join(p.text for p in parts if hasattr(p, "text") and p.text)
    except Exception:
        return response.text or ""


def parse_json_response(text: str) -> dict | list:
    """
    Parse JSON from a Gemini response, tolerating markdown code fences.
    Raises json.JSONDecodeError with the raw text appended if parsing fails.
    """
    import json, re
    t = text.strip()
    # Strip ```json ... ``` or ``` ... ``` fences
    t = re.sub(r"^```(?:json)?\s*", "", t)
    t = re.sub(r"\s*```$", "", t)
    t = t.strip()
    try:
        return json.loads(t)
    except json.JSONDecodeError:
        pass

    # Last resort: find first { or [ and slice from there
    for start_ch in ('{', '['):
        idx = t.find(start_ch)
        if idx != -1:
            try:
                return json.loads(t[idx:])
            except json.JSONDecodeError:
                pass

    print(f"\nDEBUG raw response.text ({len(text)} chars):\n{repr(text[:1000])}\n")
    import json as _json
    raise _json.JSONDecodeError("Cannot parse JSON from Gemini response — see DEBUG above", t, 0)


async def generate_with_retry(model: str, contents, config=None):
    """Async generate_content with exponential backoff on 503/429."""
    delay = _BASE_DELAY
    for attempt in range(_MAX_RETRIES):
        try:
            return await gemini.aio.models.generate_content(
                model=model, contents=contents, config=config
            )
        except APIError as e:
            if e.code not in _RETRY_STATUSES or attempt == _MAX_RETRIES - 1:
                raise
            log.warning("Gemini %s on attempt %d — retrying in %.0fs", e.status_code, attempt + 1, delay)
            await asyncio.sleep(delay)
            delay *= 2
