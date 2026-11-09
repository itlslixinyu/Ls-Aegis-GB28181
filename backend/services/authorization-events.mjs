// Same-origin, session-bound invalidations only. Never publish credentials or grants.
export class AuthorizationEvents {
  constructor(getSession) {
    this.getSession = getSession;
    this.clients = new Set();
    this.revision = 0;
  }
  attach(req, res, session) {
    if (
      this.clients.size >= 256 ||
      [...this.clients].filter((c) => c.token === session.token).length >= 8
    )
      throw Object.assign(Error("权限同步连接过多，请关闭多余页面后重试"), {
        status: 429,
        code: "AUTHORIZATION_CONNECTION_LIMIT",
      });
    const client = { req, res, token: session.token, userId: session.userId };
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    });
    this.clients.add(client);
    res.on("close", () => this.clients.delete(client));
    res.write("retry: 1000\n\n");
    this.write(client, "authorization");
  }
  write(client, event) {
    if (!client.res.write(`event: ${event}\ndata: ${this.revision}\n\n`)) {
      // A slow client reconnects and receives a fresh authoritative snapshot.
      client.res.destroy();
      this.clients.delete(client);
    }
  }
  check() {
    for (const client of this.clients) {
      if (!this.getSession(client.req)) {
        this.write(client, "expired");
        client.res.end();
        this.clients.delete(client);
      }
    }
  }
  changed(userIds) {
    this.revision++;
    this.check();
    const targets = userIds ? new Set(userIds) : null;
    for (const client of this.clients)
      if (!targets || targets.has(client.userId))
        this.write(client, "authorization");
  }
  heartbeat() {
    this.check();
    for (const client of this.clients)
      if (!client.res.write(": keepalive\n\n")) {
        client.res.destroy();
        this.clients.delete(client);
      }
  }
  close() {
    for (const client of this.clients) client.res.end();
    this.clients.clear();
  }
}
