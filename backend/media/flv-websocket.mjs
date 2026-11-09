import { WebSocketServer, WebSocket } from "ws";

// Same-origin cookies authenticate the upgrade. Viewer ownership, current scope,
// lease and disconnect tracking are shared with the existing HTTP-FLV route.
export function attachFlvWebSockets(server, { getSession, live, media }) {
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: 1024,
  });
  let closing = false;
  const reject = (socket, status) =>
    socket.end(
      `HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => {});
    if (closing) return reject(socket, 503);
    let route, session, streamId;
    try {
      route = new URL(req.url, "http://localhost").pathname.match(
        /^\/api\/v1\/live-sessions\/([a-zA-Z0-9-]+)\/viewers\/([a-zA-Z0-9-]+)\/stream\.flv$/,
      );
      if (!route) return reject(socket, 404);
      if (
        req.headers.origin !== `http://${req.headers.host}` &&
        req.headers.origin !== `https://${req.headers.host}`
      )
        return reject(socket, 403);
      session = getSession(req);
      if (!session) return reject(socket, 401);
      streamId = live.authorizeStream(route[1], session.userId, route[2]);
    } catch {
      return reject(socket, 403);
    }
    try {
      wss.handleUpgrade(
        req,
        socket,
        head,
        (ws) => void relay(ws, session, route[1], route[2], streamId),
      );
    } catch {
      socket.destroy();
    }
  });
  async function relay(ws, session, id, viewerId, streamId) {
    const controller = new AbortController();
    let untrack;
    const abort = () => controller.abort();
    const terminate = () => ws.terminate();
    ws.on("close", abort);
    ws.on("error", abort);
    ws.on("message", () => {
      ws.close(1003, "Media downstream only");
      abort();
    });
    controller.signal.addEventListener("abort", terminate, { once: true });
    const startup = setTimeout(abort, 10000),
      expiry = setTimeout(abort, Math.max(0, session.expiresAt - Date.now()));
    startup.unref();
    expiry.unref();
    try {
      untrack = live.trackConnection(id, viewerId, controller);
      const upstream = live.convertsPreviewAudio(id)
        ? await media.openCompatibleFlv(streamId, controller.signal)
        : await media.openFlv(streamId, controller.signal);
      clearTimeout(startup);
      for await (const chunk of upstream.body) {
        if (controller.signal.aborted || ws.readyState !== WebSocket.OPEN)
          break;
        await new Promise((resolve, reject) =>
          ws.send(chunk, { binary: true }, (error) =>
            error ? reject(error) : resolve(),
          ),
        );
      }
      if (ws.readyState === WebSocket.OPEN) ws.close(1000);
    } catch {
      if (ws.readyState === WebSocket.OPEN) ws.close(1011, "Media unavailable");
    } finally {
      clearTimeout(startup);
      clearTimeout(expiry);
      untrack?.();
      controller.signal.removeEventListener("abort", terminate);
      controller.abort();
      // Do not wait indefinitely for an unresponsive peer's closing handshake.
      if (ws.readyState !== WebSocket.CLOSED) {
        const timer = setTimeout(terminate, 1000);
        timer.unref();
        ws.once("close", () => clearTimeout(timer));
      }
    }
  }
  return () => {
    closing = true;
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  };
}
