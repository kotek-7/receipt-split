import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import express, { type ErrorRequestHandler, type Request } from 'express';
import { z } from 'zod';
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
    items: z
      .array(itemSchema)
      .min(1)
      .max(100)
      .refine((items) => new Set(items.map((item) => item.id)).size === items.length),
    total: z.number().int().positive().max(10_000_000),
  })
  .strict();
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
}

export async function createApp({ dbPath, serveFrontend = false }: AppOptions) {
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
      throw new ApiError(404, 'この精算が見つかりません。共有リンクを確認してください。');
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
      throw new ApiError(403, 'この精算の参加情報を確認できません。');
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
  app.use(express.json({ limit: '128kb' }));

  app.get('/api/health', (_request, response) => response.json({ ok: true }));

  app.post('/api/rooms', (request, response) => {
    const input = parse(
      createSchema,
      request.body,
      'タイトル・名前・明細を確認してください。金額は 1 円以上、個数は 1〜999 の整数で入力してください。',
    );
    const result = transaction<SessionResponse>(() => {
      const now = new Date().toISOString();
      const payerId = randomId();
      const room: Room = {
        id: randomId(),
        title: input.title,
        payerId,
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
        throw new ApiError(409, 'この精算は確定済みです。立て替えた人に再開をお願いしてください。');
      if (room.members.some((member) => normalizedName(member.name) === normalizedName(name))) {
        throw new ApiError(409, '同じ名前の人が参加しています。別の名前で参加してください。');
      }
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
            '精算が確定したため参加者を削除できません。精算を再開してから操作してください。',
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
    const input = parse(selectionSchema, request.body, '選択した明細を確認してください。');
    response.json(
      transaction(() => {
        const room = roomById(request.params.id);
        const memberId = authenticate(request, room);
        if (room.closed)
          throw new ApiError(
            409,
            '精算が確定したため変更できません。立て替えた人に再開をお願いしてください。',
          );
        if (input.itemIds.some((id) => !room.items.some((item) => item.id === id)))
          throw new ApiError(400, '見つからない明細が含まれています。画面を更新してください。');
        if (
          Object.keys(input.quantities ?? {}).some(
            (id) =>
              !input.itemIds.includes(id) ||
              !room.items.some((item) => item.id === id && getItemSplitMode(item) === 'quantity'),
          )
        )
          throw new ApiError(400, '個数は「個数で分ける」の選択した明細に入力してください。');
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
                  `「${item.name}」は購入数 ${getItemQuantity(item)} 個を超えています。ほかの人の選択を確認してください。`,
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
    const input = parse(closeSchema, request.body, '精算の状態を確認してください。');
    response.json(
      transaction(() => {
        const room = roomById(request.params.id);
        authenticate(request, room, true);
        if (input.version !== room.version)
          throw new ApiError(
            409,
            'ほかの人の選択が更新されました。最新の金額を確認して、もう一度操作してください。',
          );
        if (input.closed === room.closed) return room;
        if (input.closed && !calculateSettlement(room).ready)
          throw new ApiError(409, '全員の選択完了と、すべての明細・購入数の割り当てが必要です。');
        room.closed = input.closed;
        if (!input.closed) room.paidMemberIds = [];
        return save(room);
      }),
    );
  });

  app.put('/api/rooms/:id/paid', (request, response) => {
    const input = parse(paidSchema, request.body, '支払い済みにする人を確認してください。');
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
