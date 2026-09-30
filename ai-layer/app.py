import os
import re
import json
import base64
import asyncio
import time
from typing import List, Optional, Literal
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

# Import modules
from speech_to_text import transcribe_audio
from text_to_speech import synthesize_speech, markdown_to_speech
from llm import generate_response, stream_response
from rag import get_rag_context

# Load environment variables
load_dotenv()

# Get config
ANTHROPIC_MODEL = os.getenv("ANTHROPIC_MODEL", "claude-haiku-4-5")
AI_LAYER_PORT = int(os.getenv("AI_LAYER_PORT", "8000"))

# Validate keys
if not os.getenv("ANTHROPIC_API_KEY"):
    raise RuntimeError("ANTHROPIC_API_KEY missing")
if not os.getenv("DEEPGRAM_API_KEY"):
    raise RuntimeError("DEEPGRAM_API_KEY missing")
if not os.getenv("ELEVENLABS_API_KEY"):
    raise RuntimeError("ELEVENLABS_API_KEY missing")

# Create app
app = FastAPI(
    title="Voice Bot AI Layer",
    version="1.6.0",
    description="Voice and text chat with stop, interrupt and latency per step",
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://localhost:5000",
        "http://localhost:8000",
    ],
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "Authorization"],
)

# ============ Schemas ============

Role = Literal["system", "user", "assistant"]


class ChatMessage(BaseModel):
    role: Role
    content: str = Field(min_length=1)


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, examples=["What is the company about?"])
    history: Optional[List[ChatMessage]] = None
    temperature: float = Field(default=0.2, ge=0.0, le=1.0)
    max_tokens: int = Field(default=600, ge=1, le=2000)


class Source(BaseModel):
    source_file: str
    page: Optional[int] = None


class ChatResponse(BaseModel):
    reply: str
    sources: List[Source] = []


# ============ Endpoints ============

@app.get("/health")
def health():
    """Health check"""
    return {
        "ok": True,
        "service": "voice-bot-ai-layer",
        "model": ANTHROPIC_MODEL,
        "port": AI_LAYER_PORT,
    }


@app.post("/chat", response_model=ChatResponse)
def chat(req: ChatRequest):
    """Text chat endpoint (whole reply at once, handy for Postman)"""
    try:
        rag_context = get_rag_context(req.message)

        history = []
        if req.history:
            for m in req.history:
                if m.role in ["user", "assistant"]:
                    history.append({"role": m.role, "content": m.content})
        history.append({"role": "user", "content": req.message})

        reply = generate_response(
            message=req.message,
            history=history,
            context=rag_context,
            temperature=req.temperature,
            max_tokens=req.max_tokens,
        )
        return ChatResponse(reply=reply, sources=[])

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ============ Speaking the reply sentence by sentence ============

# A break after a sentence ending in a word (not "1." in a numbered list), or at a new line
SEGMENT_BREAK = re.compile(r"(?<=[A-Za-z\)\]\"'*_`][.!?])\s+|\n+")
MIN_SEGMENT_CHARS = 40
TTS_AT_ONCE = asyncio.Semaphore(2)  # free ElevenLabs plans allow only a couple of requests at a time


def ms_since(start: float) -> int:
    return round((time.perf_counter() - start) * 1000)


def take_segments(buffer: str):
    """Cut finished sentences off the front of the streamed text so each can be spoken as soon as it is ready."""
    segments = []
    start = 0
    for match in SEGMENT_BREAK.finditer(buffer):
        end = match.end()
        if len(buffer[start:end].strip()) < MIN_SEGMENT_CHARS:
            continue
        if buffer[:end].count("```") % 2 == 1:
            continue  # inside a code block: wait until it is closed
        segments.append(buffer[start:end])
        start = end
    return segments, buffer[start:]


async def speak_segment(text: str) -> bytes:
    speech = markdown_to_speech(text)
    if not speech:
        return b""
    async with TTS_AT_ONCE:
        return await synthesize_speech(speech)


def remember(history: list, user_text: str, reply: str) -> None:
    history.append({"role": "user", "content": user_text})
    history.append({"role": "assistant", "content": reply})


INTERRUPTED = " [interrupted by the user]"


def cut_off(reply: str) -> str:
    """How a stopped answer is saved, so the LLM knows the user cut it off there."""
    reply = reply.strip()
    return reply + INTERRUPTED if reply else "[interrupted by the user before answering]"


def mark_interrupted(history: list, heard: str) -> None:
    """The page says how much of the last answer was actually heard: save only that part."""
    heard = (heard or "").strip()
    if not heard or not history or history[-1]["role"] != "assistant":
        return
    history[-1]["content"] = cut_off(heard)


async def run_voice_reply(send, user_text: str, history: list, timing: dict) -> None:
    """Write the reply and turn each sentence into speech right away; each sentence's text is sent with its audio."""
    reply = ""
    try:
        search_start = time.perf_counter()
        rag_context = await asyncio.to_thread(get_rag_context, user_text)
        timing["search_ms"] = ms_since(search_start)
    except asyncio.CancelledError:
        remember(history, user_text, cut_off(reply))
        raise

    turn_history = history + [{"role": "user", "content": user_text}]
    ready: asyncio.Queue = asyncio.Queue()
    speech_tasks = []
    llm_start = time.perf_counter()

    async def deliver_in_order() -> None:
        while True:
            item = await ready.get()
            if item is None:
                return
            text, task = item
            audio = await task
            await send({
                "type": "voice_segment",
                "text": text,
                "audio": base64.b64encode(audio).decode("utf-8") if audio else "",
            })
            if "voice_ms" not in timing:
                timing["voice_ms"] = ms_since(timing["first_sentence_at"])
                timing["total_ms"] = ms_since(timing["started"])
                steps = {k: v for k, v in timing.items() if k.endswith("_ms")}
                print("[LATENCY] " + " | ".join(f"{k} {v}" for k, v in steps.items()))
                await send({"type": "latency", "steps": steps})

    def queue_segment(text: str) -> None:
        if "first_sentence_at" not in timing:
            timing["first_sentence_at"] = time.perf_counter()
            timing["first_sentence_ms"] = ms_since(llm_start)
        task = asyncio.create_task(speak_segment(text))
        speech_tasks.append(task)
        ready.put_nowait((text, task))

    deliverer = asyncio.create_task(deliver_in_order())
    pending = ""
    try:
        print("[WS] Writing and speaking the reply...")
        async for piece in stream_response(history=turn_history, context=rag_context):
            if "llm_first_word_ms" not in timing:
                timing["llm_first_word_ms"] = ms_since(llm_start)
            reply += piece
            pending += piece
            segments, pending = take_segments(pending)
            for segment in segments:
                queue_segment(segment)
        if pending.strip():
            queue_segment(pending)
        ready.put_nowait(None)
        await deliverer
    except asyncio.CancelledError:
        # Stopped by the user: keep the question and what was written so far, marked as cut off
        remember(history, user_text, cut_off(reply))
        raise
    finally:
        deliverer.cancel()
        for task in speech_tasks:
            task.cancel()

    reply = reply.strip() or "No response generated."
    await send({"type": "ai_response_chunk", "text": reply, "is_final": True})
    print(f"[WS] Response: {reply}")
    remember(history, user_text, reply)


async def run_text_reply(send, user_text: str, history: list) -> None:
    """Stream a typed reply into the chat piece by piece (no voice)."""
    reply = ""
    try:
        rag_context = await asyncio.to_thread(get_rag_context, user_text)
        turn_history = history + [{"role": "user", "content": user_text}]
        async for piece in stream_response(history=turn_history, context=rag_context):
            reply += piece
            await send({"type": "ai_response_chunk", "text": piece, "is_final": False})
    except asyncio.CancelledError:
        remember(history, user_text, cut_off(reply))
        raise

    reply = reply.strip() or "No response generated."
    await send({"type": "ai_response_chunk", "text": reply, "is_final": True})
    print(f"[WS] Response: {reply}")
    remember(history, user_text, reply)


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """
    WebSocket for voice and typed chat. Every reply runs in the background, so a
    new question or an "interrupt" message can stop it at any moment.

    Voice:  audio_chunk -> end_audio -> stt_chunk -> voice_segment... -> latency -> ai_response_chunk (final) -> turn_end
    Typed:  text_message -> ai_response_chunk (streamed) -> turn_end
    Stop:   interrupt (+ what was heard) -> the running reply is cancelled, and the
            history keeps the question and only the part of the answer you heard
    Every reply message carries the "turn" number the page sent, so the page can ignore a stopped reply.
    """

    await websocket.accept()
    print(f"[WS] Client connected: {websocket.client}")

    send_lock = asyncio.Lock()

    async def send(payload: dict) -> None:
        async with send_lock:
            await websocket.send_json(payload)

    audio_buffer = b""
    conversation_history = []
    current_turn: Optional[asyncio.Task] = None

    async def stop_turn() -> None:
        nonlocal current_turn
        turn, current_turn = current_turn, None
        if turn is None or turn.done():
            return
        turn.cancel()
        try:
            await turn
        except (asyncio.CancelledError, Exception):
            pass
        print("[WS] Reply stopped")

    async def voice_turn(audio: bytes, turn: int) -> None:
        async def reply_send(payload: dict) -> None:
            await send({**payload, "turn": turn})

        started = time.perf_counter()
        try:
            await reply_send({"type": "turn_start", "timestamp": 0})

            print("[WS] Transcribing...")
            transcript = await transcribe_audio(audio)
            timing = {"started": started, "stt_ms": ms_since(started)}
            if not transcript:
                print("[WS] No speech found")
                await reply_send({"type": "no_speech"})
                return

            print(f"[WS] Transcript: {transcript}")
            await reply_send({"type": "stt_chunk", "text": transcript, "is_final": True})
            await run_voice_reply(reply_send, transcript, conversation_history, timing)
            await reply_send({"type": "turn_end", "timestamp": 0})

        except Exception as e:
            print(f"[WS] Error: {e}")
            await reply_send({"type": "error", "message": str(e)})

    async def text_turn(text: str, turn: int) -> None:
        async def reply_send(payload: dict) -> None:
            await send({**payload, "turn": turn})

        try:
            await reply_send({"type": "turn_start", "timestamp": 0})
            print(f"[WS] Typed: {text}")
            await run_text_reply(reply_send, text, conversation_history)
            await reply_send({"type": "turn_end", "timestamp": 0})

        except Exception as e:
            print(f"[WS] Error: {e}")
            await reply_send({"type": "error", "message": str(e)})

    try:
        while True:
            data = await websocket.receive_text()
            message = json.loads(data)
            msg_type = message.get("type")

            # ============ Accumulate audio ============
            if msg_type == "audio_chunk":
                audio_data = message.get("data", "")
                if audio_data:
                    audio_bytes = base64.b64decode(audio_data)
                    audio_buffer += audio_bytes
                    print(f"[WS] Audio chunk: {len(audio_bytes)} bytes")

            # ============ Voice turn ============
            elif msg_type == "end_audio":
                if not audio_buffer:
                    continue
                audio, audio_buffer = audio_buffer, b""
                await stop_turn()
                current_turn = asyncio.create_task(voice_turn(audio, message.get("turn", 0)))

            # ============ Typed turn ============
            elif msg_type == "text_message":
                text = (message.get("text") or "").strip()
                if not text:
                    continue
                await stop_turn()
                current_turn = asyncio.create_task(text_turn(text, message.get("turn", 0)))

            # ============ Stop button, or recording over the bot ============
            elif msg_type == "interrupt":
                await stop_turn()
                mark_interrupted(conversation_history, message.get("heard", ""))

            else:
                print(f"[WS] Unknown: {msg_type}")

    except WebSocketDisconnect:
        print("[WS] Client disconnected")
    except json.JSONDecodeError as e:
        print(f"[WS] JSON error: {e}")
        try:
            await send({"type": "error", "message": "Invalid JSON"})
        except Exception:
            pass
    except Exception as e:
        print(f"[WS] Error: {e}")
        try:
            await send({"type": "error", "message": str(e)})
        except Exception:
            pass
    finally:
        if current_turn is not None:
            current_turn.cancel()
        try:
            await websocket.close()
        except Exception:
            pass


@app.on_event("startup")
async def startup():
    print("✓ AI Layer started")
    print(f"  Model: {ANTHROPIC_MODEL}")
    print(f"  Port: {AI_LAYER_PORT}")


@app.on_event("shutdown")
async def shutdown():
    print("✓ AI Layer shutdown")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host="0.0.0.0",
        port=AI_LAYER_PORT,
        log_level="info",
    )
