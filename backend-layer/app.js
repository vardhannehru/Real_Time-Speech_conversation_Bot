import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";

dotenv.config();

const AI_LAYER_URL = process.env.AI_LAYER_URL || "http://localhost:8000";
const AI_LAYER_WS_URL = AI_LAYER_URL.replace(/^http/, "ws") + "/ws";
const PORT = Number(process.env.BACKEND_PORT) || 5000;

const app = express();
app.use(cors({ origin: "http://localhost:3000" }));
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "voice-bot-backend" });
});

app.post("/api/chat", async (req, res) => {
  const { message, history } = req.body;

  if (!message) {
    return res.status(400).json({ error: "message required" });
  }

  try {
    const response = await axios.post(`${AI_LAYER_URL}/chat`, {
      message,
      history: history || [],
    });
    res.json(response.data);
  } catch (error) {
    const status = error.response?.status || 502;
    const detail = error.response?.data?.detail || "AI layer unavailable";
    res.status(status).json({ error: detail });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (client) => {
  console.log("Frontend connected");
  const ai = new WebSocket(AI_LAYER_WS_URL);
  const pending = [];

  ai.on("open", () => {
    console.log("Connected to AI layer");
    pending.forEach((m) => ai.send(m));
    pending.length = 0;
  });

  ai.on("message", (data) => {
    if (client.readyState === WebSocket.OPEN) client.send(data.toString());
  });

  ai.on("close", () => client.close());

  ai.on("error", (err) => {
    console.log("AI layer WebSocket error:", err.message);
    if (client.readyState === WebSocket.OPEN) {
      client.send(
        JSON.stringify({ type: "error", message: "AI layer unavailable" }),
      );
    }
    client.close();
  });

  client.on("message", (data) => {
    const msg = data.toString();
    if (ai.readyState === WebSocket.OPEN) ai.send(msg);
    else pending.push(msg);
  });

  client.on("close", () => {
    console.log("Frontend disconnected");
    ai.close();
  });
});

server.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});
