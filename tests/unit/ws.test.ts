import { describe, it, expect, beforeEach } from "bun:test";
import {
  publish,
  subscribe,
  unsubscribe,
  getSubscriptions,
  getRooms,
  getRoomSubscribers,
  cleanupSocket,
  setWsServer,
} from "../../src/lib/ws";

// Mock ServerWebSocket with the minimal interface needed
function createMockWs(id: string) {
  const subscribed = new Set<string>();
  return {
    data: { id, rooms: new Set<string>() },
    subscribe(room: string) { subscribed.add(room); },
    unsubscribe(room: string) { subscribed.delete(room); },
    send(_data: string) {},
    _subscribed: subscribed,
  } as any;
}

describe("ws room management", () => {
  beforeEach(() => {
    // Clear room registry between tests by cleaning up any lingering sockets
    for (const room of getRooms()) {
      for (const subId of getRoomSubscribers(room)) {
        cleanupSocket(subId, new Set([room]));
      }
    }
  });

  describe("subscribe + unsubscribe", () => {
    it("subscribes a socket to a room", () => {
      const ws = createMockWs("sock-1");
      subscribe(ws, "chat");

      expect(ws.data.rooms.has("chat")).toBe(true);
      expect(ws._subscribed.has("chat")).toBe(true);
      expect(getRooms()).toContain("chat");
      expect(getRoomSubscribers("chat")).toContain("sock-1");
    });

    it("unsubscribes a socket from a room", () => {
      const ws = createMockWs("sock-2");
      subscribe(ws, "chat");
      unsubscribe(ws, "chat");

      expect(ws.data.rooms.has("chat")).toBe(false);
      expect(ws._subscribed.has("chat")).toBe(false);
      expect(getRoomSubscribers("chat")).toEqual([]);
    });

    it("removes room from registry when last subscriber leaves", () => {
      const ws = createMockWs("sock-3");
      subscribe(ws, "empty-room");
      unsubscribe(ws, "empty-room");

      expect(getRooms()).not.toContain("empty-room");
    });

    it("handles multiple sockets in same room", () => {
      const ws1 = createMockWs("sock-a");
      const ws2 = createMockWs("sock-b");
      subscribe(ws1, "multi");
      subscribe(ws2, "multi");

      expect(getRoomSubscribers("multi")).toHaveLength(2);
      expect(getRoomSubscribers("multi")).toContain("sock-a");
      expect(getRoomSubscribers("multi")).toContain("sock-b");

      unsubscribe(ws1, "multi");
      expect(getRoomSubscribers("multi")).toEqual(["sock-b"]);
    });
  });

  describe("getSubscriptions", () => {
    it("returns rooms a socket is subscribed to", () => {
      const ws = createMockWs("sock-sub");
      subscribe(ws, "room-1");
      subscribe(ws, "room-2");

      const subs = getSubscriptions(ws);
      expect(subs).toHaveLength(2);
      expect(subs).toContain("room-1");
      expect(subs).toContain("room-2");
    });
  });

  describe("getRooms", () => {
    it("lists all rooms with subscribers", () => {
      const ws = createMockWs("sock-rooms");
      subscribe(ws, "alpha");
      subscribe(ws, "beta");

      const rooms = getRooms();
      expect(rooms).toContain("alpha");
      expect(rooms).toContain("beta");
    });
  });

  describe("getRoomSubscribers", () => {
    it("returns empty array for non-existent room", () => {
      expect(getRoomSubscribers("nonexistent")).toEqual([]);
    });
  });

  describe("cleanupSocket", () => {
    it("removes socket from all rooms on disconnect", () => {
      const ws = createMockWs("sock-cleanup");
      subscribe(ws, "room-x");
      subscribe(ws, "room-y");

      cleanupSocket("sock-cleanup", ws.data.rooms);

      expect(getRoomSubscribers("room-x")).toEqual([]);
      expect(getRoomSubscribers("room-y")).toEqual([]);
      // Rooms should be cleaned up since they're empty
      expect(getRooms()).not.toContain("room-x");
      expect(getRooms()).not.toContain("room-y");
    });
  });

  describe("publish", () => {
    it("does not throw when no server is set", () => {
      // _server is null, publish should be a no-op
      expect(() => publish("topic", { msg: "hello" })).not.toThrow();
    });

    it("publishes when server is set", () => {
      let published: { topic: string; data: string } | null = null;
      const mockServer = {
        publish(topic: string, data: string) { published = { topic, data }; },
      } as any;
      setWsServer(mockServer);

      publish("my-topic", { hello: "world" });

      expect(published).not.toBeNull();
      expect(published!.topic).toBe("my-topic");
      expect(JSON.parse(published!.data)).toEqual({ hello: "world" });

      // Reset
      setWsServer(null as any);
    });
  });
});
