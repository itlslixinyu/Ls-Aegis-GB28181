import net from "node:net";
export const transportOf = (remote) =>
  remote?.sipTransport || remote?.transport || "UDP";
export function sendSip(gateway, buffer, remote, callback = () => {}) {
  if (gateway.send) return gateway.send(buffer, remote, callback);
  gateway.socket?.send(
    buffer,
    remote.remotePort ?? remote.port,
    remote.remoteAddress ?? remote.address,
    callback,
  );
}
// RFC 3261 stream framing: one Content-Length-delimited message per callback.
export class SipFramer {
  constructor(onMessage, onKeepalive = () => {}) {
    this.buffer = Buffer.alloc(0);
    this.onMessage = onMessage;
    this.onKeepalive = onKeepalive;
  }
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length) {
      if (this.buffer.subarray(0, 4).equals(Buffer.from("\r\n\r\n"))) {
        this.buffer = this.buffer.subarray(4);
        this.onKeepalive();
        continue;
      }
      if (this.buffer.subarray(0, 2).equals(Buffer.from("\r\n"))) {
        this.buffer = this.buffer.subarray(2);
        continue;
      }
      const end = this.buffer.indexOf("\r\n\r\n");
      if (end < 0) {
        if (this.buffer.length > 16384) throw Error("SIP头过大");
        return;
      }
      if (end > 16384) throw Error("SIP头过大");
      const lengths = [
        ...this.buffer
          .subarray(0, end)
          .toString("ascii")
          .matchAll(/^(?:Content-Length|l):\s*(\d+)\s*$/gim),
      ];
      if (lengths.length !== 1) throw Error("TCP SIP须含唯一Content-Length");
      const size = end + 4 + Number(lengths[0][1]);
      if (size > 65507) throw Error("SIP消息过大");
      if (this.buffer.length < size) return;
      const packet = this.buffer.subarray(0, size);
      this.buffer = this.buffer.subarray(size);
      this.onMessage(packet);
    }
  }
}
export class TcpSipTransport {
  constructor(gateway) {
    this.gateway = gateway;
    this.peers = new Map();
    this.sockets = new Set();
    this.closed = false;
  }
  async start(host, port) {
    this.server = net.createServer((s) => this.attach(s, false));
    this.server.maxConnections = 256;
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    this.server.on("error", () => {
      this.gateway.state = "error";
    });
  }
  attach(socket, outgoing, key) {
    if (this.closed || this.sockets.size >= 256) {
      socket.destroy();
      return;
    }
    key ??= socket.remoteAddress + ":" + socket.remotePort;
    this.sockets.add(socket);
    this.peers.set(key, socket);
    socket.setNoDelay(true);
    socket.setTimeout(outgoing ? 600000 : 190000, () => socket.destroy());
    const remote = () => ({
      address: socket.remoteAddress,
      port: socket.remotePort,
      transport: "TCP",
    });
    const framer = new SipFramer(
      (packet) => this.gateway.receive(packet, remote()),
      () => socket.write("\r\n"),
    );
    socket.on("data", (chunk) => {
      try {
        framer.push(chunk);
      } catch {
        socket.destroy();
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      this.sockets.delete(socket);
      if (this.peers.get(key) !== socket) return;
      this.peers.delete(key);
      if (!outgoing && !this.closed)
        this.gateway.db
          .prepare(
            "UPDATE devices SET status='offline' WHERE remoteAddress=? AND remotePort=? AND sipTransport='TCP'",
          )
          .run(socket.remoteAddress, socket.remotePort);
    });
  }
  send(buffer, remote, callback) {
    if (this.closed) return callback(Error("TCP服务已关闭"));
    const host = remote.remoteAddress ?? remote.address,
      port = remote.remotePort ?? remote.port,
      key = host + ":" + port;
    let socket = this.peers.get(key);
    if (!socket || socket.destroyed) {
      socket = net.createConnection({ host, port });
      this.attach(socket, true, key);
      const timer = setTimeout(
        () => socket.destroy(Error("TCP连接超时")),
        5000,
      );
      timer.unref();
      socket.once("connect", () => clearTimeout(timer));
      socket.once("close", () => clearTimeout(timer));
    }
    if (socket.destroyed || socket.writableLength > 1048576)
      return callback(Error("TCP连接不可写"));
    socket.write(buffer, callback);
  }
  disconnect(host, port) {
    this.peers.get(host + ":" + port)?.destroy();
  }
  close() {
    this.closed = true;
    for (const socket of this.sockets) socket.destroy();
    this.server?.close();
    this.peers.clear();
  }
}
