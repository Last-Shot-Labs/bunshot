import type { Server, ServerWebSocket } from "bun";

type WithRooms = { rooms: Set<string> };
type WithSocketId = { id: string } & WithRooms;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _server: Server<any> | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const setWsServer = (server: Server<any>) => { _server = server; };

export const publish = (topic: string, data: unknown) => {
  _server?.publish(topic, JSON.stringify(data));
};

/** room → Set of socket IDs */
const _roomRegistry = new Map<string, Set<string>>();

/** All rooms that currently have at least one subscriber */
export const getRooms = (): string[] => [..._roomRegistry.keys()];

/** Socket IDs subscribed to a given room */
export const getRoomSubscribers = (room: string): string[] =>
  [...(_roomRegistry.get(room) ?? [])];

type RoomGuard<T extends WithRooms> = (ws: ServerWebSocket<T>, room: string) => boolean | Promise<boolean>;

const MAX_ROOM_ACTION_SIZE = 4096; // 4 KB — room actions are small JSON payloads

export const handleRoomActions = async <T extends WithSocketId>(
  ws: ServerWebSocket<T>,
  message: string | Buffer,
  onSubscribe?: RoomGuard<T>,
): Promise<boolean> => {
  try {
    const raw = typeof message === "string" ? message : Buffer.from(message).toString();
    if (raw.length > MAX_ROOM_ACTION_SIZE) return false; // not a room action
    const data = JSON.parse(raw);
    if (data.action === "subscribe" && typeof data.room === "string") {
      if (onSubscribe && !(await onSubscribe(ws, data.room))) {
        ws.send(JSON.stringify({ event: "subscribe_denied", room: data.room }));
      } else {
        subscribe(ws, data.room);
        ws.send(JSON.stringify({ event: "subscribed", room: data.room }));
      }
      return true;
    }
    if (data.action === "unsubscribe" && typeof data.room === "string") {
      unsubscribe(ws, data.room);
      ws.send(JSON.stringify({ event: "unsubscribed", room: data.room }));
      return true;
    }
  } catch { /* not JSON */ }
  return false;
};

export const subscribe = <T extends WithSocketId>(ws: ServerWebSocket<T>, room: string) => {
  ws.subscribe(room);
  ws.data.rooms.add(room);
  if (!_roomRegistry.has(room)) _roomRegistry.set(room, new Set());
  _roomRegistry.get(room)!.add(ws.data.id);
};

export const unsubscribe = <T extends WithSocketId>(ws: ServerWebSocket<T>, room: string) => {
  ws.unsubscribe(room);
  ws.data.rooms.delete(room);
  const ids = _roomRegistry.get(room);
  if (ids) {
    ids.delete(ws.data.id);
    if (ids.size === 0) _roomRegistry.delete(room);
  }
};

export const getSubscriptions = <T extends WithRooms>(ws: ServerWebSocket<T>): string[] =>
  [...ws.data.rooms];

/** Called on socket close to prune the registry. Internal use only. */
export const cleanupSocket = (socketId: string, rooms: Set<string>) => {
  for (const room of rooms) {
    const ids = _roomRegistry.get(room);
    if (ids) {
      ids.delete(socketId);
      if (ids.size === 0) _roomRegistry.delete(room);
    }
  }
};
