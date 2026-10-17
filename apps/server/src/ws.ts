// Websocket endpoint `/ws` (PLAN.md §5).
import websocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import { ClientMessage } from '@trellis/shared';
import type { ServerMessage } from '@trellis/shared';
import type { Session } from './session.js';

export async function registerWs(app: FastifyInstance, session: Session): Promise<void> {
  await app.register(websocket);
  const sockets = new Map<string, WebSocket>();

  const send = (socket: WebSocket, msg: ServerMessage): void => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
  };

  const unsubscribe = session.subscribe(({ to, msg }) => {
    if (to === null) for (const s of sockets.values()) send(s, msg);
    else {
      const s = sockets.get(to);
      if (s) send(s, msg);
    }
  });
  app.addHook('onClose', () => {
    unsubscribe();
    for (const s of sockets.values()) s.close(1001, 'server shutting down');
  });

  app.get('/ws', { websocket: true }, (socket) => {
    let clientId: string | null = null;
    const error = (code: string, message: string): void => { send(socket, { type: 'error', code, message }); };

    socket.on('message', (raw: Buffer) => {
      let data: unknown;
      try {
        data = JSON.parse(raw.toString()) as unknown;
      } catch {
        error('INVALID_JSON', 'messages must be JSON');
        return;
      }
      const parsed = ClientMessage.safeParse(data);
      if (!parsed.success) {
        error('INVALID_MESSAGE', z.prettifyError(parsed.error));
        return;
      }
      const msg = parsed.data;
      if (msg.type === 'hello') {
        if (clientId !== null) sockets.delete(clientId);
        clientId = msg.clientId;
        sockets.get(clientId)?.close(4000, 'replaced by a newer connection');
        sockets.set(clientId, socket);
        session.hello(clientId, msg.name, msg.kind);
        send(socket, session.welcome());
        return;
      }
      if (clientId === null) {
        error('HELLO_REQUIRED', 'send hello first');
        return;
      }
      switch (msg.type) {
        case 'batch':
          session.submit(msg.batch, { clientId, requestId: msg.requestId });
          break;
        case 'presence':
          session.updatePresence(clientId, { selection: msg.selection, dragging: msg.dragging });
          break;
        case 'claim': {
          const name = session.status().clients.find((c) => c.clientId === clientId)?.name ?? clientId;
          const by: Parameters<Session['claim']>[1] = { holder: name, clientId };
          if (msg.note !== undefined) by.note = msg.note;
          if (msg.ttlSec !== undefined) by.ttlSec = msg.ttlSec;
          const res = session.claim(msg.ids, by);
          if (!res.ok) error('LOCKED', `already claimed: ${res.conflicts.map((c) => `${c.id} by ${c.holder}`).join(', ')}`);
          break;
        }
        case 'release': {
          const name = session.status().clients.find((c) => c.clientId === clientId)?.name ?? clientId;
          session.release(msg.ids, { holder: name, clientId });
          break;
        }
      }
    });

    socket.on('close', () => {
      if (clientId !== null && sockets.get(clientId) === socket) {
        sockets.delete(clientId);
        session.disconnect(clientId);
      }
    });
  });
}
