"""
CDST LLM Client
===============
Shared Gemini client instance imported by all three stage files.
API key is read from the GEMINI_API_KEY environment variable.
"""

import logging

from google import genai
from google.genai.errors import APIError

log = logging.getLogger(__name__)

gemini = genai.Client()

_CASCADE_STATUSES = {503, 404, 429}  # cascade to next model on these; raise immediately on others

_usage_log: list[dict] = []


def pop_usage_log() -> list[dict]:
    """Drain and return all usage entries accumulated since the last call."""
    global _usage_log
    entries, _usage_log = _usage_log, []
    return entries


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


async def generate_with_cascade(models: list[str], contents, config=None):
    """Try each model in order; cascade to the next on 503/404/429."""
    last_err = None
    for model in models:
        try:
            response = await gemini.aio.models.generate_content(
                model=model, contents=contents, config=config
            )
            u = getattr(response, "usage_metadata", None)
            if u:
                _usage_log.append({
                    "model":         model,
                    "input_tokens":  getattr(u, "prompt_token_count",     0) or 0,
                    "output_tokens": getattr(u, "candidates_token_count", 0) or 0,
                })
            if model != models[0]:
                log.warning("Cascade: used %s (primary %s unavailable)", model, models[0])
            return response
        except APIError as e:
            if e.code not in _CASCADE_STATUSES:
                raise
            last_err = e
            log.warning("Gemini %s on %s — cascading to next model", e.code, model)
    raise last_err


async def stream_with_cascade(models: list[str], contents, config=None):
    """Try each model in order for streaming; cascade only if no tokens have been yielded yet."""
    last_err = None
    for model in models:
        try:
            started = False
            async for chunk in gemini.aio.models.generate_content_stream(
                model=model, contents=contents, config=config
            ):
                started = True
                yield chunk
            return
        except APIError as e:
            if started or e.code not in _CASCADE_STATUSES:
                raise
            last_err = e
            log.warning("Gemini %s on %s (pre-stream) — cascading to next model", e.code, model)
    raise last_err
