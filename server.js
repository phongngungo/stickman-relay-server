'use strict';

const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = '0.0.0.0';
const MAX_PLAYERS_PER_ROOM = 4;
const HEARTBEAT_INTERVAL_MS = 20000;
const EMPTY_ROOM_TTL_MS = 60000;
const SWEEPER_INTERVAL_MS = 15000;
const BINARY_MSG_RELAY = 0x01;
const BINARY_HEADER_SIZE = 9; // [1B msg_type][4B target_peer LE][4B sender_peer LE]
const MAX_PAYLOAD_BYTES = 1 << 20; // 1 MiB

/**
 * Room map: roomId (5-digit string "10000"-"99999") -> {
 *   id: string,
 *   locked: boolean,
 *   peers: Map<number, WebSocket>,
 *   createdAt: number,
 *   emptySince: number | null
 * }
 */
const rooms = new Map();

function countTotalClients() {
  let count = 0;
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN) {
      count += 1;
    }
  }
  return count;
}

function sendJson(ws, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return;
  }
  try {
    ws.send(JSON.stringify(payload));
  } catch (err) {
    console.error('[Relay] sendJson error:', err.message);
  }
}

function allocateRoomId() {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const id = String(10000 + Math.floor(Math.random() * 90000));
    if (!rooms.has(id)) {
      return id;
    }
  }
  for (let n = 10000; n <= 99999; n += 1) {
    const id = String(n);
    if (!rooms.has(id)) {
      return id;
    }
  }
  return null;
}

function allocatePeerId(room) {
  for (let pid = 2; pid <= MAX_PLAYERS_PER_ROOM; pid += 1) {
    if (!room.peers.has(pid)) {
      return pid;
    }
  }
  return 0;
}

function detachPeerFromRoom(ws, reason) {
  const roomId = ws.roomId;
  const peerId = ws.peerId;
  ws.roomId = null;
  ws.peerId = 0;

  if (!roomId || !peerId) {
    return;
  }
  const room = rooms.get(roomId);
  if (!room) {
    return;
  }

  // Only remove if this socket is still registered under peerId
  if (room.peers.get(peerId) === ws) {
    room.peers.delete(peerId);
  }

  if (peerId === 1) {
    // Host disconnected -> notify all clients & dissolve room cleanly
    rooms.delete(roomId);
    for (const [, client] of room.peers.entries()) {
      client.roomId = null;
      client.peerId = 0;
      sendJson(client, { type: 'HOST_DISCONNECTED', room_id: roomId });
      try {
        client.close(4000, 'Host disconnected');
      } catch (_) {
        // ignore already-closing socket
      }
    }
    room.peers.clear();
    console.log(`[Relay] Room ${roomId} closed (host left: ${reason || 'disconnect'})`);
    return;
  }

  // Non-host client left -> notify remaining peers
  for (const [, client] of room.peers.entries()) {
    sendJson(client, { type: 'PEER_DISCONNECTED', peer_id: peerId });
  }

  if (room.peers.size === 0) {
    room.emptySince = Date.now();
  }
  console.log(`[Relay] Peer ${peerId} left room ${roomId} (${room.peers.size} remaining)`);
}

function handleTextMessage(ws, rawText) {
  let msg;
  try {
    msg = JSON.parse(rawText);
  } catch (_) {
    sendJson(ws, { type: 'ERROR', code: 'INVALID_JSON', message: 'Malformed JSON payload' });
    return;
  }

  if (!msg || typeof msg.type !== 'string') {
    sendJson(ws, { type: 'ERROR', code: 'INVALID_MESSAGE', message: 'Missing message type' });
    return;
  }

  switch (msg.type) {
    case 'PING': {
      sendJson(ws, { type: 'PONG', ts: msg.ts !== undefined ? msg.ts : Date.now() });
      break;
    }

    case 'CREATE_ROOM': {
      if (ws.roomId) {
        detachPeerFromRoom(ws, 'create_new_room');
      }
      const roomId = allocateRoomId();
      if (!roomId) {
        sendJson(ws, { type: 'ERROR', code: 'SERVER_FULL', message: 'No available room IDs' });
        return;
      }
      const room = {
        id: roomId,
        locked: false,
        peers: new Map([[1, ws]]),
        createdAt: Date.now(),
        emptySince: null,
      };
      rooms.set(roomId, room);
      ws.roomId = roomId;
      ws.peerId = 1;
      sendJson(ws, { type: 'ROOM_CREATED', room_id: roomId, peer_id: 1 });
      console.log(`[Relay] Room ${roomId} created by Host (peer 1)`);
      break;
    }

    case 'JOIN_ROOM': {
      if (ws.roomId) {
        detachPeerFromRoom(ws, 'join_another_room');
      }
      const roomId = String(msg.room_id || '').trim();
      const room = rooms.get(roomId);
      if (!room) {
        sendJson(ws, {
          type: 'ERROR',
          code: 'ROOM_NOT_FOUND',
          message: `Room ${roomId || '?????'} does not exist`,
        });
        return;
      }
      if (room.locked) {
        sendJson(ws, {
          type: 'ERROR',
          code: 'GAME_IN_PROGRESS',
          message: 'Room is locked — match already in progress',
        });
        return;
      }
      if (room.peers.size >= MAX_PLAYERS_PER_ROOM) {
        sendJson(ws, {
          type: 'ERROR',
          code: 'ROOM_FULL',
          message: `Room ${roomId} is full (${MAX_PLAYERS_PER_ROOM}/${MAX_PLAYERS_PER_ROOM})`,
        });
        return;
      }

      const peerId = allocatePeerId(room);
      if (peerId === 0) {
        sendJson(ws, {
          type: 'ERROR',
          code: 'ROOM_FULL',
          message: `Room ${roomId} has no free peer slots`,
        });
        return;
      }

      const existingPeers = Array.from(room.peers.keys()).sort((a, b) => a - b);
      room.peers.set(peerId, ws);
      room.emptySince = null;
      ws.roomId = roomId;
      ws.peerId = peerId;

      // Inform joiner first with all existing peers
      sendJson(ws, {
        type: 'ROOM_JOINED',
        room_id: roomId,
        peer_id: peerId,
        peers: existingPeers,
      });

      // Notify every existing peer in room
      for (const existingPid of existingPeers) {
        const existingWs = room.peers.get(existingPid);
        sendJson(existingWs, { type: 'PEER_CONNECTED', peer_id: peerId });
      }
      console.log(`[Relay] Peer ${peerId} joined room ${roomId} (peers: ${room.peers.size}/${MAX_PLAYERS_PER_ROOM})`);
      break;
    }

    case 'SET_LOCKED': {
      if (!ws.roomId || ws.peerId !== 1) {
        return;
      }
      const room = rooms.get(ws.roomId);
      if (!room) {
        return;
      }
      room.locked = Boolean(msg.locked);
      console.log(`[Relay] Room ${room.id} locked=${room.locked}`);
      break;
    }

    case 'DISCONNECT_PEER': {
      if (!ws.roomId || ws.peerId !== 1) {
        return;
      }
      const room = rooms.get(ws.roomId);
      if (!room) {
        return;
      }
      const targetPid = Number(msg.peer_id);
      if (!Number.isInteger(targetPid) || targetPid <= 1) {
        return;
      }
      const targetWs = room.peers.get(targetPid);
      if (!targetWs) {
        return;
      }
      detachPeerFromRoom(targetWs, 'kicked_by_host');
      sendJson(targetWs, {
        type: 'ERROR',
        code: 'DISCONNECTED_BY_HOST',
        message: 'Disconnected by host',
      });
      try {
        targetWs.close(4001, 'Disconnected by host');
      } catch (_) {
        // ignore
      }
      break;
    }

    default: {
      sendJson(ws, {
        type: 'ERROR',
        code: 'UNKNOWN_MESSAGE_TYPE',
        message: `Unsupported message type: ${msg.type}`,
      });
      break;
    }
  }
}

function handleBinaryFrame(ws, rawData) {
  if (!ws.roomId || !ws.peerId) {
    return;
  }
  const room = rooms.get(ws.roomId);
  if (!room) {
    return;
  }

  const buf = Buffer.isBuffer(rawData)
    ? rawData
    : Array.isArray(rawData)
      ? Buffer.concat(rawData)
      : Buffer.from(rawData);

  if (buf.length < BINARY_HEADER_SIZE) {
    return;
  }
  if (buf[0] !== BINARY_MSG_RELAY) {
    return;
  }

  const targetPeer = buf.readInt32LE(1);
  // Anti-spoofing: overwrite bytes 5..8 with authentic ws.peerId
  buf.writeInt32LE(ws.peerId, 5);

  if (targetPeer === 0) {
    // Broadcast to all OTHER peers in room
    for (const [pid, client] of room.peers.entries()) {
      if (pid !== ws.peerId && client.readyState === WebSocket.OPEN) {
        client.send(buf, { binary: true });
      }
    }
  } else if (targetPeer > 0) {
    // Direct unicast to targetPeer
    if (targetPeer === ws.peerId) {
      return;
    }
    const targetClient = room.peers.get(targetPeer);
    if (targetClient && targetClient.readyState === WebSocket.OPEN) {
      targetClient.send(buf, { binary: true });
    }
  } else {
    // Negative target: send to all OTHER peers EXCEPT peerId === -targetPeer
    const excludedPid = -targetPeer;
    for (const [pid, client] of room.peers.entries()) {
      if (pid !== ws.peerId && pid !== excludedPid && client.readyState === WebSocket.OPEN) {
        client.send(buf, { binary: true });
      }
    }
  }
}

const server = http.createServer((req, res) => {
  const urlPath = (req.url || '/').split('?')[0];
  if (req.method === 'GET' && (urlPath === '/health' || urlPath === '/')) {
    const body = JSON.stringify({
      status: 'ok',
      rooms: rooms.size,
      clients: countTotalClients(),
    });
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(body);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ status: 'not_found' }));
});

const wss = new WebSocketServer({
  server,
  maxPayload: MAX_PAYLOAD_BYTES,
  perMessageDeflate: false, // Low latency for real-time 25 Hz binary game state
});

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.roomId = null;
  ws.peerId = 0;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      handleBinaryFrame(ws, data);
    } else {
      handleTextMessage(ws, data.toString('utf8'));
    }
  });

  ws.on('close', () => {
    detachPeerFromRoom(ws, 'socket_closed');
  });

  ws.on('error', (err) => {
    console.error(`[Relay] WebSocket error (room=${ws.roomId}, peer=${ws.peerId}):`, err.message);
    detachPeerFromRoom(ws, 'socket_error');
  });
});

// Keepalive Ping/Pong heartbeat every 20,000 ms
const heartbeatTimer = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      detachPeerFromRoom(ws, 'heartbeat_timeout');
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch (_) {
      ws.terminate();
    }
  }
}, HEARTBEAT_INTERVAL_MS);

// Sweeper cleans empty rooms older than 60,000 ms
const sweeperTimer = setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms.entries()) {
    if (room.peers.size === 0) {
      if (room.emptySince === null) {
        room.emptySince = now;
      } else if (now - room.emptySince >= EMPTY_ROOM_TTL_MS) {
        rooms.delete(roomId);
        console.log(`[Relay] Swept stale empty room ${roomId}`);
      }
    }
  }
}, SWEEPER_INTERVAL_MS);

wss.on('close', () => {
  clearInterval(heartbeatTimer);
  clearInterval(sweeperTimer);
});

function shutdown(signal) {
  console.log(`[Relay] Received ${signal}, shutting down...`);
  clearInterval(heartbeatTimer);
  clearInterval(sweeperTimer);
  for (const ws of wss.clients) {
    try {
      ws.close(1001, 'Server shutting down');
    } catch (_) {
      // ignore
    }
  }
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.listen(PORT, HOST, () => {
  console.log(`[Relay] Stickman 5-Digit WebSocket Relay Server listening on ${HOST}:${PORT}`);
});
