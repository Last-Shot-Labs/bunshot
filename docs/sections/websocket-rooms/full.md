## WebSocket Rooms / Channels

Rooms are built on Bun's native pub/sub. `createServer` always intercepts room action messages first via `handleRoomActions` — so room subscribe/unsubscribe works regardless of whether you provide a custom `websocket.message`.

### WS utilities

| Export | Description |
|---|---|
| `publish(room, data)` | Broadcast `data` to all sockets subscribed to `room` |
| `subscribe(ws, room)` | Subscribe a socket to a room and track it in `ws.data.rooms` |
| `unsubscribe(ws, room)` | Unsubscribe a socket from a room |
| `getSubscriptions(ws)` | Returns `string[]` of rooms the socket is currently in |
| `getRooms()` | Returns `string[]` of all rooms with at least one active subscriber |
| `getRoomSubscribers(room)` | Returns `string[]` of socket IDs currently subscribed to `room` |
| `handleRoomActions(ws, message, onSubscribe?)` | Parses and dispatches subscribe/unsubscribe actions. Returns `true` if the message was a room action (consumed), `false` otherwise. Pass an optional async guard as the third argument. |

### Client → server: join or leave a room

Send a JSON message with `action: "subscribe"` or `action: "unsubscribe"`:

```ts
ws.send(JSON.stringify({ action: "subscribe",   room: "chat:general" }));
ws.send(JSON.stringify({ action: "unsubscribe", room: "chat:general" }));
```

Server responses:

| Event | Meaning |
|---|---|
| `{ event: "subscribed", room }` | Successfully joined |
| `{ event: "unsubscribed", room }` | Successfully left |
| `{ event: "subscribe_denied", room }` | Blocked by `onRoomSubscribe` guard |

Any non-room message is passed through to your `websocket.message` handler unchanged.

### Server → room: broadcast

```ts
import { publish } from "@lastshotlabs/bunshot";

publish("chat:general", { text: "Hello room!", from: "system" });
```

All sockets subscribed to `"chat:general"` receive the message. Works from anywhere — routes, workers, anywhere after `createServer` resolves.

### Server-side: manage subscriptions in code

Use `subscribe` / `unsubscribe` anywhere you have a `ws` reference (e.g. in `ws.handler.open` to auto-join personal rooms):

```ts
import { subscribe, unsubscribe, getSubscriptions } from "@lastshotlabs/bunshot";

await createServer({
  ws: {
    handler: {
      open(ws) {
        // auto-subscribe authenticated users to their personal room
        if (ws.data.userId) subscribe(ws, `user:${ws.data.userId}`);
      },
      message(ws, message) {
        // handleRoomActions already ran — only non-room messages reach here
        const rooms = getSubscriptions(ws); // current room list
      },
      close(ws) {
        // ws.data.rooms is cleared automatically — no cleanup needed
      },
    },
  },
});
```

### Room permission guard

Pass `ws.onRoomSubscribe` to `createServer` to gate which rooms a socket can join. Return `true` to allow, `false` to deny. Uses `ws.data.userId` for auth-based checks. Can be async.

```ts
await createServer({
  ws: {
    onRoomSubscribe(ws, room) {
      if (!ws.data.userId) return false;                              // must be logged in
      if (room.startsWith("admin:")) return isAdmin(ws.data.userId); // role check
      if (room.startsWith("user:")) return room === `user:${ws.data.userId}`; // ownership
      return true;
    },
  },
});

// async guard — query DB or cache
await createServer({
  ws: {
    onRoomSubscribe: async (ws, room) => {
      const ok = await db.roomMembers.findOne({ room, userId: ws.data.userId });
      return !!ok;
    },
  },
});
```
