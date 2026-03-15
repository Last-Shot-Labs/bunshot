import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import { createApp, type CreateAppConfig } from "./app";
import { websocket as defaultWebsocket, createWsUpgradeHandler, type SocketData } from "@ws/index";
import { setWsServer, handleRoomActions, cleanupSocket } from "@lib/ws";
import { log } from "@lib/logger";

export interface WsConfig<T extends object = object> {
  /** Override or extend the default WebSocket handler */
  handler?: WebSocketHandler<SocketData<T>>;
  /** Override the default /ws upgrade handler (auth + upgrade logic) */
  upgradeHandler?: (req: Request, server: Server<SocketData<T>>) => Promise<Response | undefined>;
  /**
   * Guard called before a socket joins a room via the subscribe action.
   * Return true to allow, false to deny (client receives { event: "subscribe_denied", room }).
   * ws.data.userId is available for auth checks.
   */
  onRoomSubscribe?: (ws: ServerWebSocket<SocketData<T>>, room: string) => boolean | Promise<boolean>;
}

export interface CreateServerConfig<T extends object = object> extends CreateAppConfig {
  port?: number;
  /** Absolute path to the service's workers directory — auto-imports all .ts files */
  workersDir?: string;
  /** Set false to disable auto-loading workers. Defaults to true */
  enableWorkers?: boolean;
  /** WebSocket configuration */
  ws?: WsConfig<T>;
}

export const createServer = async <T extends object = object>(
  config: CreateServerConfig<T>
): Promise<Server<SocketData<T>>> => {
  const app = await createApp(config);
  const port = Number(process.env.PORT ?? config.port ?? 3000);
  const { workersDir, enableWorkers = true, ws: wsConfig = {} } = config;
  const { handler: userWs, upgradeHandler: wsUpgradeHandler, onRoomSubscribe } = wsConfig;

  // Default handlers are typed for the base SocketData — cast is safe because
  // they only access id/userId/rooms which exist in every SocketData<T>.
  type SD = SocketData<T>;
  const defaultOpen = defaultWebsocket.open as WebSocketHandler<SD>["open"];
  const defaultMessage = defaultWebsocket.message as WebSocketHandler<SD>["message"];
  const defaultClose = defaultWebsocket.close as WebSocketHandler<SD>["close"];
  const defaultDrain = defaultWebsocket.drain as WebSocketHandler<SD>["drain"];

  const ws: WebSocketHandler<SD> = {
    open: userWs?.open ?? defaultOpen,
    async message(socket, message) {
      if (!await handleRoomActions(socket, message, onRoomSubscribe)) {
        (userWs?.message ?? defaultMessage!)(socket, message);
      }
    },
    close(socket, code, reason) {
      cleanupSocket(socket.data.id, socket.data.rooms);
      socket.data.rooms.clear();
      (userWs?.close ?? defaultClose!)(socket, code, reason);
    },
    drain: userWs?.drain ?? defaultDrain,
  };

  let server: Server<SD>;

  server = Bun.serve<SD>({
    port,
    routes: {
      "/ws": (req: Request) => wsUpgradeHandler
        ? wsUpgradeHandler(req, server)
        : createWsUpgradeHandler(server as Server<SocketData>)(req),
    },
    fetch: app.fetch,
    websocket: ws,
    error(err) {
      console.error(err);
      return Response.json({ error: "Internal Server Error" }, { status: 500 });
    },
  });

  setWsServer(server);

  if (enableWorkers && workersDir) {
    const glob = new Bun.Glob("**/*.ts");
    for await (const file of glob.scan({ cwd: workersDir })) {
      await import(`${workersDir}/${file}`);
    }
    // Clean up ghost cron schedulers after all workers are loaded
    try {
      const { getRegisteredCronNames, cleanupStaleSchedulers } = await import("@lib/queue");
      const activeNames = [...getRegisteredCronNames()];
      if (activeNames.length > 0) {
        await cleanupStaleSchedulers(activeNames);
      }
    } catch { /* bullmq not installed or no cron workers */ }
  }

  log(`[server] running at http://localhost:${server.port}`);
  log(`[server] API docs at http://localhost:${server.port}/docs`);

  return server;
};
