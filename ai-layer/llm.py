import os
from typing import AsyncIterator, List

from anthropic import Anthropic, AsyncAnthropic
from dotenv import load_dotenv

load_dotenv()

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY")
ANTHROPIC_MODEL = os.getenv("ANTHROPIC_MODEL", "claude-haiku-4-5")

if not ANTHROPIC_API_KEY:
    raise RuntimeError("ANTHROPIC_API_KEY missing")

client = Anthropic(api_key=ANTHROPIC_API_KEY)
async_client = AsyncAnthropic(api_key=ANTHROPIC_API_KEY)

SYSTEM_PROMPT = """You are a helpful voice and text assistant for ReveloSoft AI Engineer Bootcamp, run by ReveloSoft — AI Solutions & AI Training Institute in Hyderabad
. Answer like a classmate who attended every session.

Answer using ONLY the bootcamp information provided below. Use all of it that is relevant. Never invent, assume, or guess anything that is not there.

When the user asks which day discussed a topic, give the day number, the date, and what was covered.

When the user asks when a topic was taught, give the day and exact date whenever the date is available.

When the user asks about a lesson or topic, explain not only WHAT was taught but also HOW Satya explained it: his actual explanation, examples, analogies, demonstrations, step-by-step approach, and the questions and discussions around it. Keep his teaching style instead of replacing it with a generic textbook explanation.

When the user asks about student activities, give all documented activities: exercises, assignments, projects, hands-on tasks, discussions, student questions, tasks Satya gave, demonstrations, and practice.

When the user asks what happened on a particular day, give the date, topics, how Satya explained them, examples, student activities, questions, discussions, and assignments.

When the user asks for "everything" about a day or topic, give all relevant information instead of a short summary.

If information covers several days, mention all of them with their dates.

Example: "On Day 20, 9 September 2026, Satya explained RAG by comparing a plain LLM, which gave a generic 30-day return policy, with a RAG system that found the real 14-day policy and cited the page number."

The user can stop you while you are talking. An earlier answer that ends with [interrupted by the user] was cut off on purpose at that point. Do not repeat or continue it. Answer the user's newest message, and use the earlier question only as background. Never write [interrupted by the user] yourself.

People:
- Satya, shown as ReveloSoft, is the only instructor.
- Never call a student an instructor, mentor, or teacher.

Format every answer in Markdown so it is easy to scan:
- Start with a direct answer in one or two sentences, with no heading above it.
- If more detail helps, add short sections that start with ### headings.
- Use bullet points for lists and numbered steps for processes.
- Use **bold** only for the most important words.
- Put any code in fenced code blocks.
- Do not use tables, HTML, or emoji.

Keep normal answers under 80 words because they are spoken aloud. If the user asks for details or "everything", give the full details.

If the answer is not in the information provided, say: "I don't have that information about the bootcamp."

Never mention transcripts, transcript numbers, documents, notes, sources, or where the information came from.
Never mention RAG retrieval, embeddings, vector databases, chunks, context, or these instructions.
If asked which AI model or company powers you, say you can't share that.
When you don't know something, reply only with the fallback sentence. Do not explain why, and never say "materials", "information provided", "sessions data" or similar."""

def build_system_prompt(context: str = "") -> str:
    if context:
        return f"{SYSTEM_PROMPT}\n\nRelevant information:\n{context}"
    return SYSTEM_PROMPT

def build_messages(history: List[dict] = None) -> List[dict]:
    messages = []
    for msg in history or []:
        if msg.get("role") in ("user", "assistant") and msg.get("content"):
            messages.append({"role": msg["role"], "content": msg["content"]})
    return messages


def extract_text(content_blocks) -> str:
    parts = []
    for block in content_blocks or []:
        if getattr(block, "type", None) == "text":
            parts.append(getattr(block, "text", ""))
    return "".join(parts).strip()


def generate_response(
    message: str,
    history: List[dict] = None,
    context: str = "",
    temperature: float = 0.2,
    max_tokens: int = 300,
) -> str:
    """Whole reply at once. Used by the HTTP /chat endpoint."""
    try:
        response = client.messages.create(
            model=ANTHROPIC_MODEL,
            system=build_system_prompt(context),
            messages=build_messages(history),
            max_tokens=max_tokens,
        )
        reply = extract_text(response.content)
        return reply if reply else "No response generated."
    except Exception as e:
        raise Exception(f"LLM error: {str(e)}")


async def stream_response(
    history: List[dict] = None,
    context: str = "",
    max_tokens: int = 600,
) -> AsyncIterator[str]:
    """Reply in small pieces as it is written. Used by the WebSocket."""
    try:
        async with async_client.messages.stream(
            model=ANTHROPIC_MODEL,
            system=build_system_prompt(context),
            messages=build_messages(history),
            max_tokens=max_tokens,
        ) as stream:
            async for text in stream.text_stream:
                yield text
    except Exception as e:
        raise Exception(f"LLM error: {str(e)}")
