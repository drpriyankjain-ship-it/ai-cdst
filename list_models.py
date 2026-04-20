from google import genai
import os

# Load .env
from pathlib import Path
for line in (Path("C:/Users/mrpri/Projects/ai-cdst/.env")).read_text().splitlines():
    if line.strip() and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip())

client = genai.Client()
for m in client.models.list():
    if "generateContent" in (m.supported_actions or []):
        print(m.name)
