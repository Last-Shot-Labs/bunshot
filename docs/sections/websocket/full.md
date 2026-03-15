## WebSocket

The `/ws` endpoint is mounted automatically by `createServer`. No extra setup needed.

### Default behaviour

| What | Default |
|---|---|
| Upgrade / auth | Reads `auth-token` cookie → verifies JWT → checks session → sets `ws.data.userId` |
| `open` | Logs connection, sends `{ event: "connected", id }` |
| `message` | Handles room actions (see below), echoes everything else |
| `close` | Clears `ws.data.rooms`, logs disconnection |

### Socket data (`SocketData`)

`SocketData` is generic — pass a type parameter to add your own fields:

```ts
type SocketData<T extends object = object> = {
  id: string;            // unique connection ID (UUID)
  userId: string | null; // null if unauthenticated
  rooms: Set<string>;    // rooms this socket is subscribed to
} & T;
```

**Extending with custom fields:**

```ts
import { createServer, type SocketData } from "@lastshotlabs/bunshot";

type MyData = { tenantId: string; role: "admin" | "user" };

await createServer<MyData>({
  ws: {
    upgradeHandler: async (req, server) => {
      const tenantId = req.headers.get("x-tenant-id") ?? "default";
      const upgraded = server.upgrade(req, {
        data: { id: crypto.randomUUID(), userId: null, rooms: new Set(), tenantId, role: "user" },
      });
      return upgraded ? undefined : Response.json({ error: "Upgrade failed" }, { status: 400 });
    },
    handler: {
      open(ws) {
        // ws.data.tenantId and ws.data.role are fully typed
        console.log(ws.data.tenantId, ws.data.role);
      },
    },
    onRoomSubscribe(ws, room) {
      return ws.data.role === "admin" || !room.startsWith("admin:");
    },
  },
});
```

With no type parameter, `SocketData` defaults to `{ id, userId, rooms }` — the base shape used by the default upgrade handler.

### Overriding the message handler

Pass `ws.handler` to `createServer` to replace the default echo. Room action handling always runs first — your handler only receives non-room messages:

```ts
await createServer({
  ws: {
    handler: {
      open(ws) {
        ws.send(JSON.stringify({ event: "connected", id: ws.data.id }));
      },
      message(ws, message) {
        // room subscribe/unsubscribe already handled — put your logic here
        const parsed = JSON.parse(message as string);
        if (parsed.action === "ping") ws.send(JSON.stringify({ event: "pong" }));
      },
      close(ws, code, reason) {
        // ws.data.rooms already cleared
      },
    },
  },
});
```

You can supply any subset of `open`, `message`, `close`, `drain` — unset handlers fall back to the defaults.

### Overriding the upgrade / auth handler

Replace the default cookie-JWT handshake entirely via `ws.upgradeHandler`. You must call `server.upgrade()` yourself and include `rooms: new Set()` in data:

```ts
await createServer({
  ws: {
    upgradeHandler: async (req, server) => {
      const token = req.headers.get("x-my-token");
      const userId = token ? await verifyMyToken(token) : null;
      const upgraded = server.upgrade(req, {
        data: { id: crypto.randomUUID(), userId, rooms: new Set() },
      });
      return upgraded ? undefined : Response.json({ error: "Upgrade failed" }, { status: 400 });
    },
  },
});
```
