import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import express, { type ErrorRequestHandler, type Request } from 'express';
import { z } from 'zod';
import { scanReceiptRequest, type ReceiptScanOptions } from './receipt-scan';
import {
  calculateSettlement,
  getItemQuantity,
  getItemSplitMode,
  getSelectionQuantity,
} from '../shared/settlement';
import type { Identity, Room, SessionResponse } from '../shared/types';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const nameSchema = z.string().trim().min(1).max(24);
const itemSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[a-zA-Z0-9_-]+$/),
    name: z.string().trim().min(1).max(100),
    amount: z.number().int().positive().max(1_000_000),
    quantity: z.number().int().positive().max(999).optional(),
    splitMode: z.enum(['equal', 'quantity']).optional(),
  })
  .strict();
const createSchema = z
  .object({
    title: z.string().trim().min(1).max(80),
    payerName: nameSchema,
    participantCount: z.number().int().min(1).max(100).optional(),
    calculationMode: z.literal('fixed-participants').optional(),
    items: z
      .array(itemSchema)
      .min(1)
      .max(100)
      .refine((items) => new Set(items.map((item) => item.id)).size === items.length),
    total: z.number().int().positive().max(10_000_000),
  })
  .strict()
  .refine((input) => input.calculationMode === undefined || input.participantCount !== undefined);
const selectionSchema = z
  .object({
    itemIds: z
      .array(z.string())
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length),
    done: z.boolean(),
    quantities: z.record(z.number().int().positive().max(999)).optional(),
  })
  .strict();
const closeSchema = z
  .object({ closed: z.boolean(), version: z.number().int().positive() })
  .strict();
const paidSchema = z.object({ memberId: z.string(), paid: z.boolean() }).strict();

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(400, message);
  return result.data;
}

function randomId(): string {
  return randomBytes(24).toString('base64url');
}
function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
function normalizedName(name: string): string {
  return name.normalize('NFKC').toLocaleLowerCase('ja');
}

export interface AppOptions {
  dbPath: string;
  serveFrontend?: boolean;
  receiptScan?: ReceiptScanOptions;
}

export async function createApp({ dbPath, serveFrontend = false, receiptScan = {} }: AppOptions) {
  if (dbPath !== ':memory:') mkdirSync(path.dirname(dbPath), { recursive: true });
  const database = new DatabaseSync(dbPath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      member_id TEXT NOT NULL,
      UNIQUE(room_id, member_id)
    );
  `);
  const readRoom = database.prepare('SELECT body FROM rooms WHERE id = ?');
  const writeRoom = database.prepare('UPDATE rooms SET body = ? WHERE id = ?');
  const insertRoom = database.prepare('INSERT INTO rooms (id, body) VALUES (?, ?)');
  const insertSession = database.prepare(
    'INSERT INTO sessions (token_hash, room_id, member_id) VALUES (?, ?, ?)',
  );
  const readSession = database.prepare(
    'SELECT member_id FROM sessions WHERE room_id = ? AND token_hash = ?',
  );
  const deleteSession = database.prepare(
    'DELETE FROM sessions WHERE room_id = ? AND member_id = ?',
  );

  function roomById(id: string): Room {
    const stored = readRoom.get(id) as { body: string } | undefined;
    if (!stored)
      throw new ApiError(404, 'この割り勘が見つかりません。共有リンクを確認してください。');
    return JSON.parse(stored.body) as Room;
  }

  function transaction<T>(work: () => T): T {
    database.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      database.exec('COMMIT');
      return result;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  function save(room: Room): Room {
    room.updatedAt = new Date().toISOString();
    room.version++;
    writeRoom.run(JSON.stringify(room), room.id);
    return room;
  }

  function createIdentity(roomId: string, memberId: string): Identity {
    const token = randomBytes(32).toString('base64url');
    insertSession.run(tokenHash(token), roomId, memberId);
    return { memberId, token };
  }

  function authenticate(request: Request, room: Room, payerOnly = false): string {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.get('Authorization') ?? '');
    if (!match)
      throw new ApiError(
        403,
        'この端末の参加情報を確認できません。共有リンクから参加してください。',
      );
    const session = readSession.get(room.id, tokenHash(match[1])) as
      { member_id: string } | undefined;
    if (!session || !room.members.some((member) => member.id === session.member_id)) {
      throw new ApiError(403, 'この割り勘の参加情報を確認できません。');
    }
    if (payerOnly && session.member_id !== room.payerId)
      throw new ApiError(403, 'この操作は立て替えた人だけができます。');
    return session.member_id;
  }

  const app = express();
  app.disable('x-powered-by');
  app.use('/api', (_request, response, next) => {
    response.set('Cache-Control', 'no-store');
    response.set('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.get('/api/receipt-reader', (_request, response) =>
    response.json({ ai: Boolean(receiptScan.run) }),
  );
  const rawReceipt = express.raw({ type: () => true, limit: '8mb' });
  app.post(
    '/api/receipt-scan',
    (request, response, next) => {
      rawReceipt(request, response, (error) => {
        if (error) {
          response
            .status(error.type === 'entity.too.large' ? 413 : 400)
            .json({ error: '画像を読み込めませんでした。小さい画像を選び直してください。' });
          return;
        }
        next();
      });
    },
    async (request, response) => {
      const controller = new AbortController();
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const onClose = () => {
        if (!response.writableEnded) {
          controller.abort();
          void reader?.cancel().catch(() => undefined);
        }
      };
      request.once('aborted', onClose);
      response.once('close', onClose);
      try {
        const headers = new Headers();
        for (const name of ['Origin', 'Content-Type', 'Sec-Fetch-Site', 'Accept']) {
          const value = request.get(name);
          if (value) headers.set(name, value);
        }
        const bytes = Buffer.isBuffer(request.body)
          ? new Uint8Array(request.body)
          : new Uint8Array();
        const scanRequest = new Request(
          `${request.protocol}://${request.get('host')}/api/receipt-scan`,
          {
            method: 'POST',
            headers,
            body: bytes,
            signal: controller.signal,
          },
        );
        const result = await scanReceiptRequest(scanRequest, receiptScan);
        result.headers.forEach((value, name) => response.set(name, value));
        response.status(result.status);
        if (result.body) {
          reader = result.body.getReader();
          response.flushHeaders();
          // A scan emits only a handful of bounded events; forward each immediately.
          while (!response.destroyed && !controller.signal.aborted) {
            const { done, value } = await reader.read();
            if (done || response.destroyed) break;
            response.write(value);
          }
        }
        if (!response.destroyed) response.end();
      } finally {
        await reader?.cancel().catch(() => undefined);
        reader?.releaseLock();
        request.off('aborted', onClose);
        response.off('close', onClose);
      }
    },
  );
  app.use(express.json({ limit: '128kb' }));

  app.get('/api/health', (_request, response) => response.json({ ok: true }));

  app.post('/api/rooms', (request, response) => {
    const input = parse(
      createSchema,
      request.body,
      '飲み会の名前・あなたの名前・レシートの内容を確認してください。割り勘人数は 1〜100 人、金額は 1 円以上、数量は 1〜999 の整数で入力してください。',
    );
    const result = transaction<SessionResponse>(() => {
      const now = new Date().toISOString();
      const payerId = randomId();
      const room: Room = {
        id: randomId(),
        title: input.title,
        payerId,
        participantCount: input.participantCount,
        calculationMode: input.calculationMode,
        items: input.items,
        total: input.total,
        members: [{ id: payerId, name: input.payerName, done: false }],
        selections: { [payerId]: [] },
        paidMemberIds: [],
        closed: false,
        createdAt: now,
        updatedAt: now,
        version: 1,
      };
      insertRoom.run(room.id, JSON.stringify(room));
      return { room, identity: createIdentity(room.id, payerId) };
    });
    response.status(201).json(result);
  });

  app.get('/api/rooms/:id', (request, response) => response.json(roomById(request.params.id)));

  app.post('/api/rooms/:id/members', (request, response) => {
    const { name } = parse(
      z.object({ name: nameSchema }).strict(),
      request.body,
      '名前は 1〜24 文字で入力してください。',
    );
    const result = transaction<SessionResponse>(() => {
      const room = roomById(request.params.id);
      if (room.closed)
        throw new ApiError(
          409,
          'この割り勘は締め切り済みです。立て替えた人に締め切りの解除をお願いしてください。',
        );
      if (room.members.some((member) => normalizedName(member.name) === normalizedName(name))) {
        throw new ApiError(409, '同じ名前の人が参加しています。別の名前で参加してください。');
      }
      if (room.participantCount !== undefined && room.members.length >= room.participantCount)
        throw new ApiError(
          409,
          `設定した ${room.participantCount} 人が参加済みです。立て替えた人に確認してください。`,
        );
      const memberId = randomId();
      room.members.push({ id: memberId, name, done: false });
      room.selections[memberId] = [];
      return { room: save(room), identity: createIdentity(room.id, memberId) };
    });
    response.status(201).json(result);
  });

  app.delete('/api/rooms/:id/members/:memberId', (request, response) => {
    parse(z.object({}).strict(), request.body, '削除する参加者を確認してください。');
    response.json(
      transaction(() => {
        const room = roomById(request.params.id);
        authenticate(request, room, true);
        if (room.closed)
          throw new ApiError(
            409,
            '割り勘を締め切ったため参加者を削除できません。締め切りを解除してから操作してください。',
          );
        const memberId = request.params.memberId;
        if (memberId === room.payerId) throw new ApiError(400, '立て替えた人は削除できません。');
        if (!room.members.some((member) => member.id === memberId))
          throw new ApiError(404, 'この参加者が見つかりません。画面を更新してください。');
        room.members = room.members.filter((member) => member.id !== memberId);
        delete room.selections[memberId];
        if (room.selectionQuantities) delete room.selectionQuantities[memberId];
        room.paidMemberIds = room.paidMemberIds.filter((id) => id !== memberId);
        deleteSession.run(room.id, memberId);
        return save(room);
      }),
    );
  });

  app.put('/api/rooms/:id/selection', (request, response) => {
    const input = parse(
      selectionSchema,
      request.body,
      '選んだ料理・飲み物と数を確認してください。',
    );
    response.json(
      transaction(() => {
        const room = roomById(request.params.id);
        const memberId = authenticate(request, room);
        if (room.closed)
          throw new ApiError(
            409,
            '割り勘を締め切ったため変更できません。立て替えた人に締め切りの解除をお願いしてください。',
          );
        if (input.itemIds.some((id) => !room.items.some((item) => item.id === id)))
          throw new ApiError(400, 'レシートにない内容が選ばれています。画面を更新してください。');
        if (
          room.calculationMode === 'fixed-participants' &&
          input.itemIds.some((id) =>
            room.items.some((item) => item.id === id && getItemSplitMode(item) === 'equal'),
          )
        )
          throw new ApiError(
            400,
            'みんなで分ける料理・飲み物は、人数分で割った金額が自動で含まれます。選ぶ必要はありません。',
          );
        if (
          Object.keys(input.quantities ?? {}).some(
            (id) =>
              !input.itemIds.includes(id) ||
              !room.items.some((item) => item.id === id && getItemSplitMode(item) === 'quantity'),
          )
        )
          throw new ApiError(400, '数は「各自」で選んだ料理・飲み物に入力してください。');
        const quantities = Object.fromEntries(
          room.items
            .filter(
              (item) => input.itemIds.includes(item.id) && getItemSplitMode(item) === 'quantity',
            )
            .map((item) => {
              const quantity =
                input.quantities && Object.hasOwn(input.quantities, item.id)
                  ? input.quantities[item.id]
                  : getSelectionQuantity(room, memberId, item) || 1;
              const otherQuantity = room.members.reduce(
                (sum, member) =>
                  sum + (member.id === memberId ? 0 : getSelectionQuantity(room, member.id, item)),
                0,
              );
              if (quantity + otherQuantity > getItemQuantity(item))
                throw new ApiError(
                  409,
                  `「${item.name}」はレシートの数量 ${getItemQuantity(item)} を超えています。ほかの人の入力を確認してください。`,
                );
              return [item.id, quantity];
            }),
        );
        room.selectionQuantities ??= {};
        room.selectionQuantities[memberId] = quantities;
        room.selections[memberId] = input.itemIds;
        room.members.find((member) => member.id === memberId)!.done = input.done;
        return save(room);
      }),
    );
  });

  app.post('/api/rooms/:id/close', (request, response) => {
    const input = parse(closeSchema, request.body, '割り勘の状態を確認してください。');
    response.json(
      transaction(() => {
        const room = roomById(request.params.id);
        authenticate(request, room, true);
        if (input.version !== room.version)
          throw new ApiError(
            409,
            'ほかの人の入力が更新されました。最新の金額を確認して、もう一度操作してください。',
          );
        if (input.closed === room.closed) return room;
        if (input.closed && !calculateSettlement(room).ready)
          throw new ApiError(
            409,
            '全員の参加・入力完了が必要です。料理・飲み物の選び忘れや、残っている数がないか確認してください。',
          );
        room.closed = input.closed;
        if (!input.closed) room.paidMemberIds = [];
        return save(room);
      }),
    );
  });

  app.put('/api/rooms/:id/paid', (request, response) => {
    const input = parse(paidSchema, request.body, '受け取りを記録する人を確認してください。');
    response.json(
      transaction(() => {
        const room = roomById(request.params.id);
        authenticate(request, room, true);
        if (!room.closed)
          throw new ApiError(409, '金額を確定してから、受け取りを記録してください。');
        if (
          !room.members.some((member) => member.id === input.memberId) ||
          input.memberId === room.payerId
        ) {
          throw new ApiError(400, '受け取りを記録する参加者を選んでください。');
        }
        room.paidMemberIds = room.paidMemberIds.filter((id) => id !== input.memberId);
        if (input.paid) room.paidMemberIds.push(input.memberId);
        return save(room);
      }),
    );
  });

  app.use('/api', (_request, response) =>
    response.status(404).json({ error: '指定された操作が見つかりません。' }),
  );

  let closeFrontend: (() => Promise<void>) | undefined;
  if (serveFrontend) {
    if (process.env.NODE_ENV === 'production') {
      app.use(express.static(path.join(projectRoot, 'dist')));
      app.get('/{*path}', (_request, response) =>
        response.sendFile(path.join(projectRoot, 'dist', 'index.html')),
      );
    } else {
      const { createServer } = await import('vite');
      const vite = await createServer({
        root: projectRoot,
        server: { middlewareMode: true },
        appType: 'spa',
      });
      app.use(vite.middlewares);
      closeFrontend = () => vite.close();
    }
  }
  const handleError: ErrorRequestHandler = (error, _request, response, _next) => {
    if (error instanceof ApiError) {
      response.status(error.status).json({ error: error.message });
      return;
    }
    if (error?.type === 'entity.parse.failed' || error?.type === 'entity.too.large') {
      response
        .status(400)
        .json({ error: '送信内容を読み取れませんでした。入力内容を確認してください。' });
      return;
    }
    console.error('API request failed:', error);
    response
      .status(500)
      .json({ error: '保存できませんでした。時間をおいてもう一度お試しください。' });
  };
  app.use(handleError);
  return {
    app,
    async close() {
      await closeFrontend?.();
      database.close();
    },
  };
}
