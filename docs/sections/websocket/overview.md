## WebSocket

The `/ws` endpoint is mounted automatically by `createServer`. Default behavior: cookie-JWT auth on upgrade, room action handling, message size enforcement (64 KB default). Non-room messages are dropped unless a custom handler is provided.

`SocketData` carries `id`, `userId`, and `rooms` per connection. Pass a type parameter to `createServer<T>` to extend with custom fields. Override `ws.handler` (open/message/close) and `ws.upgradeHandler` for custom behavior.
