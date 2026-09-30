import os

import httpx
from dotenv import load_dotenv

# Load .env
load_dotenv()

DEEPGRAM_API_KEY = os.getenv("DEEPGRAM_API_KEY")

if not DEEPGRAM_API_KEY:
    raise RuntimeError("DEEPGRAM_API_KEY missing")


async def transcribe_audio(audio_bytes: bytes) -> str:
    """Transcribe a complete recording in one request."""
    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                "https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true",
                headers={"Authorization": f"Token {DEEPGRAM_API_KEY}"},
                content=audio_bytes,
                timeout=30.0,
            )

        if response.status_code != 200:
            print(f"Deepgram error {response.status_code}: {response.text}")
            return ""

        result = response.json()
        try:
            transcript = result["results"]["channels"][0]["alternatives"][0]["transcript"]
            return transcript.strip()
        except (KeyError, IndexError):
            print("Error extracting transcript from Deepgram response")
            return ""

    except Exception as e:
        print(f"Deepgram error: {e}")
        raise
