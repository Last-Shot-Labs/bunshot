import type { Server, WebSocketHandler } from "bun";
import { verifyToken } from "@lib/jwt";
import { getSession } from "@lib/session";
import { COOKIE_TOKEN } from "@lib/constants";

export type SocketData<T extends object = object> = {
  id: string;
  userId: string | null;
  rooms: Set<string>;
} & T;

type BaseSocketData = SocketData<object>;

export const createWsUpgradeHandler = (server: Server<BaseSocketData>) =>
  async (req: Request): Promise<Response | undefined> => {
    let userId: string | null = null;
    try {
      const token = req.headers.get("cookie")
        ?.match(new RegExp(`(?:^|;\\s*)${COOKIE_TOKEN}=([^;]+)`))?.[1] ?? null;
      if (token) {
        const payload = await verifyToken(token);
        const stored = await getSession(payload.sub!);
        if (stored === token) userId = payload.sub!;
      }
    } catch { /* unauthenticated — userId stays null */ }

    const upgraded = server.upgrade(req, { data: { id: crypto.randomUUID(), userId, rooms: new Set() } });
    return upgraded ? undefined : Response.json({ error: "Upgrade failed" }, { status: 400 });
  };

export const websocket: WebSocketHandler<BaseSocketData> = {
  open(ws) {
    console.log(`[ws] connected: ${ws.data.id}`);
    ws.send(JSON.stringify({ event: "connected", id: ws.data.id }));
  },
  message(ws, message) {
    ws.send(message);
  },
  close(ws) {
    console.log(`[ws] disconnected: ${ws.data.id}`);
  },
};
