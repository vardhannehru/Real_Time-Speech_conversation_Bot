import os
import re

import httpx
from dotenv import load_dotenv

load_dotenv()

ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY")

if not ELEVENLABS_API_KEY:
    raise RuntimeError("ELEVENLABS_API_KEY missing")

VOICE_ID = "JBFqnCBsd6RMkjVDRZzb"  # George
MODEL_ID = "eleven_flash_v2_5"


def markdown_to_speech(text: str) -> str:
    """Turn a Markdown reply into plain sentences, so the voice doesn't read out # or *."""
    text = re.sub(r"```.*?```", " ", text, flags=re.S)
    text = re.sub(r"`([^`]*)`", r"\1", text)
    text = re.sub(r"^\s*#{1,6}\s*", "", text, flags=re.M)
    text = re.sub(r"^\s*[-*•]\s+", "", text, flags=re.M)
    text = re.sub(r"^\s*(\d+)[.)]\s+", r"\1. ", text, flags=re.M)
    text = re.sub(r"^\s*(-{3,}|\*{3,}|_{3,})\s*$", "", text, flags=re.M)
    text = re.sub(r"\*\*([^*]+)\*\*", r"\1", text)
    text = re.sub(r"\*([^*]+)\*", r"\1", text)

    lines = [line.strip() for line in text.splitlines() if line.strip()]
    # End every line with punctuation so the voice pauses between headings and list items
    lines = [line if line[-1] in ".!?:" else f"{line}." for line in lines]
    return " ".join(lines)


async def synthesize_speech(text: str, voice_id: str = VOICE_ID) -> bytes:
    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}",
                headers={
                    "xi-api-key": ELEVENLABS_API_KEY,
                    "Accept": "audio/mpeg",
                },
                json={
                    "text": text,
                    "model_id": MODEL_ID,
                    "voice_settings": {
                        "stability": 0.5,
                        "similarity_boost": 0.75,
                    },
                },
                timeout=30.0,
            )

            if response.status_code == 200:
                return response.content

            print(f"ElevenLabs error {response.status_code}: {response.text}")
            return b""

    except Exception as e:
        print(f"ElevenLabs error: {e}")
        return b""
