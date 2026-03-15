import { describe, test, expect } from "bun:test";
import { handleRoomActions } from "../../src/lib/ws";

/** Minimal mock WebSocket for testing handleRoomActions. */
function mockWs() {
  const sent: string[] = [];
  const subscribed: string[] = [];
  return {
    data: { id: "test-socket", rooms: new Set<string>() },
    send(msg: string) { sent.push(msg); },
    subscribe(room: string) { subscribed.push(room); },
    unsubscribe(_room: string) {},
    sent,
    subscribed,
  } as any;
}

describe("handleRoomActions — size limit", () => {
  test("rejects messages larger than 4KB", async () => {
    const ws = mockWs();
    // Create a message larger than MAX_ROOM_ACTION_SIZE (4096 bytes)
    const oversized = JSON.stringify({ action: "subscribe", room: "a".repeat(5000) });
    const result = await handleRoomActions(ws, oversized);
    // Should return false (not handled as room action)
    expect(result).toBe(false);
    expect(ws.sent).toHaveLength(0);
    expect(ws.subscribed).toHaveLength(0);
  });

  test("handles normal-sized subscribe messages", async () => {
    const ws = mockWs();
    const msg = JSON.stringify({ action: "subscribe", room: "test-room" });
    const result = await handleRoomActions(ws, msg);
    expect(result).toBe(true);
    expect(ws.subscribed).toContain("test-room");
  });

  test("ignores non-JSON messages without error", async () => {
    const ws = mockWs();
    const result = await handleRoomActions(ws, "not json");
    expect(result).toBe(false);
  });

  test("respects room guard — deny", async () => {
    const ws = mockWs();
    const msg = JSON.stringify({ action: "subscribe", room: "secret-room" });
    const guard = () => false;
    const result = await handleRoomActions(ws, msg, guard);
    expect(result).toBe(true); // handled (returned deny event)
    expect(ws.subscribed).toHaveLength(0);
    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0]).event).toBe("subscribe_denied");
  });
});
