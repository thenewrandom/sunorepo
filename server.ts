import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { createServer as createHttpServer } from "http";
import { WebSocketServer } from "ws";
import { GoogleGenAI, LiveServerMessage, Modality, Type } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

const ai = new GoogleGenAI({ 
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: { headers: { 'User-Agent': 'aistudio-build' } }
});

const tools = [{
  functionDeclarations: [
    {
      name: "addChannel",
      description: "Add a new audio channel to the mixer.",
    },
    {
      name: "removeChannel",
      description: "Remove an audio channel from the mixer by its ID.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.NUMBER, description: "The ID of the channel to remove." }
        },
        required: ["id"]
      }
    },
    {
      name: "setChannelVolume",
      description: "Set the volume of an audio channel.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.NUMBER, description: "The ID of the channel." },
          volume: { type: Type.NUMBER, description: "Volume level from 0 to 100." }
        },
        required: ["id", "volume"]
      }
    },
    {
      name: "toggleChannelMute",
      description: "Toggle the mute state (M) of an audio channel.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.NUMBER, description: "The ID of the channel." }
        },
        required: ["id"]
      }
    },
    {
      name: "toggleChannelTalkback",
      description: "Toggle the talkback state (T) of an audio channel.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.NUMBER, description: "The ID of the channel." }
        },
        required: ["id"]
      }
    },
    {
      name: "toggleChannelAuto",
      description: "Toggle the auto state (A) of an audio channel.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.NUMBER, description: "The ID of the channel." }
        },
        required: ["id"]
      }
    },
    {
      name: "muteAllRemote",
      description: "Mute all remote video feeds.",
    },
    {
      name: "soloRemote",
      description: "Solo the remote video feed.",
    }
  ]
}];

async function startServer() {
  const app = express();
  const PORT = 3000;
  
  app.use(express.json());

  // Chat API (for text prompting)
  app.post("/api/chat", async (req, res) => {
    try {
      const { prompt } = req.body;
      const response = await ai.models.generateContent({
        model: "gemini-3.7-flash",
        contents: prompt,
        config: {
          systemInstruction: "You are an AI Audio Engineer assistant built into a remote recording interface. You can control the app by calling functions (e.g., adding channels, changing volume). Call functions when requested.",
          tools: tools,
        }
      });
      
      const functionCalls = response.functionCalls || [];
      res.json({ text: response.text, functionCalls });
    } catch (error: any) {
      console.error("Chat API error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  const httpServer = createHttpServer(app);
  
  const wss = new WebSocketServer({ noServer: true });
  const signalingWss = new WebSocketServer({ noServer: true });
  
  const rooms: Record<string, { host?: any, guest?: any }> = {};

  signalingWss.on("connection", (ws) => {
    let currentRoom: string | null = null;
    let currentRole: 'host' | 'guest' | null = null;

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        
        if (msg.type === 'join') {
          currentRoom = msg.room;
          currentRole = msg.role;
          
          if (!rooms[currentRoom!]) {
            rooms[currentRoom!] = {};
          }
          rooms[currentRoom!][currentRole!] = ws;
          
          console.log(`[Signaling] ${currentRole} joined room ${currentRoom}`);

          // If both are here, tell them to start
          if (rooms[currentRoom!].host && rooms[currentRoom!].guest) {
            console.log(`[Signaling] Room ${currentRoom} is ready. Emitting ready events.`);
            rooms[currentRoom!].host.send(JSON.stringify({ type: 'ready' }));
            rooms[currentRoom!].guest.send(JSON.stringify({ type: 'ready' }));
          }
        } 
        else if (currentRoom) {
          const targetRole = currentRole === 'host' ? 'guest' : 'host';
          const targetWs = rooms[currentRoom][targetRole];
          console.log(`[Signaling] Forwarding ${msg.type} from ${currentRole} to ${targetRole} in room ${currentRoom}`);
          if (targetWs && targetWs.readyState === 1) { // WebSocket.OPEN
            targetWs.send(data.toString());
          }
        }
      } catch (e) {
        console.error("Signaling message error", e);
      }
    });

    ws.on("close", () => {
      if (currentRoom && currentRole) {
        if (rooms[currentRoom]) {
          delete rooms[currentRoom][currentRole];
          const otherRole = currentRole === 'host' ? 'guest' : 'host';
          const targetWs = rooms[currentRoom][otherRole];
          if (targetWs && targetWs.readyState === 1) {
            targetWs.send(JSON.stringify({ type: 'peer_disconnected' }));
          }
          if (!rooms[currentRoom].host && !rooms[currentRoom].guest) {
            delete rooms[currentRoom];
          }
        }
      }
    });
  });

  httpServer.on('upgrade', (request, socket, head) => {
    if (request.url === '/live') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else if (request.url === '/signaling') {
      signalingWss.handleUpgrade(request, socket, head, (ws) => {
        signalingWss.emit('connection', ws, request);
      });
    } else {
      // socket.destroy();
    }
  });

  wss.on("connection", async (clientWs) => {
    try {
      const session = await ai.live.connect({
        model: "gemini-3.1-flash-live-preview",
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: "You are an AI Audio Engineer assistant built into a remote recording interface. You can talk to the user and control the app's channels, volume, mute, and other settings via function calling. Keep your answers brief and helpful.",
          tools: tools,
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } },
          },
        },
        callbacks: {
          onmessage: (message: LiveServerMessage) => {
            // Forward audio
            const audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (audio) {
              clientWs.send(JSON.stringify({ audio }));
            }
            // Forward function calls
            const toolCalls = message.toolCall?.functionCalls;
            if (toolCalls && toolCalls.length > 0) {
              clientWs.send(JSON.stringify({ toolCalls }));
            }
          },
          onclose: () => {
            console.log("Gemini Live session closed");
          },
          onerror: (error) => {
            console.error("Gemini Live error:", error);
          }
        },
      });

      clientWs.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.audio) {
            session.sendRealtimeInput({
              audio: { data: msg.audio, mimeType: "audio/pcm;rate=16000" },
            });
          } else if (msg.toolResponses) {
            session.sendToolResponse({
               functionResponses: msg.toolResponses
            });
          }
        } catch (e) {
          console.error("Error processing client message:", e);
        }
      });

      clientWs.on("close", () => {
        session.close();
      });
    } catch (e) {
      console.error("Error establishing live session:", e);
      clientWs.close();
    }
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer();
