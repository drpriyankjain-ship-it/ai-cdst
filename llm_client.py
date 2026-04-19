"""
CDST LLM Client
===============
Shared Gemini client instance imported by all three stage files.
API key is read from the GEMINI_API_KEY environment variable.
"""

from google import genai

gemini = genai.Client()
