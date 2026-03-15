## WebSocket Rooms / Channels

Rooms are built on Bun's native pub/sub. Clients send `{ action: "subscribe", room: "chat:general" }` to join; servers broadcast via `publish("chat:general", data)`.

Utilities: `publish`, `subscribe`, `unsubscribe`, `getSubscriptions`, `getRooms`, `getRoomSubscribers`. Gate room access with `ws.onRoomSubscribe` (sync or async guard).
