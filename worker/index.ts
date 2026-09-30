import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';
import {
  calculateSettlement,
  getItemQuantity,
  getItemSplitMode,
  getSelectionQuantity,
} from '../shared/settlement';
import type { Identity, Room, SessionResponse } from '../shared/types';

export interface Env {
  ROOMS: DurableObjectNamespace<ReceiptRoom>;
  ASSETS: Fetcher;
}

const nameSchema = z.string().trim().min(1).max(24);
const createSchema = z
  .object({
    title: z.string().trim().min(1).max(80),
    payerName: nameSchema,
    participantCount: z.number().int().min(1).max(100).optional(),
    items: z
      .array(
        z
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
          .strict(),
      )
      .min(1)
      .max(100)
      .refine((items) => new Set(items.map((item) => item.id)).size === items.length),
    total: z.number().int().positive().max(10_000_000),
  })
  .strict();
const memberSchema = z.object({ name: nameSchema }).strict();
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
const roomRoute =
  /^\/api\/rooms\/([A-Za-z0-9_-]{32})(?:\/(members|selection|close|paid)(?:\/([A-Za-z0-9_-]{32}))?)?$/;
const createError =
  '飲み会の名前・あなたの名前・レシートの内容を確認してください。割り勘人数は 1〜100 人、金額は 1 円以上、数量は 1〜999 の整数で入力してください。';
const notFound = 'この割り勘が見つかりません。共有リンクを確認してください。';

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}

function failure(error: unknown): Response {
  if (error instanceof ApiError) return json({ error: error.message }, error.status);
  console.error('Receipt API request failed:', error);
  return json({ error: '保存できませんでした。時間をおいてもう一度お試しください。' }, 500);
}

function parse<T>(schema: z.ZodType<T>, input: unknown, message: string): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new ApiError(400, message);
  return result.data;
}

/** Check actual streamed bytes; a caller-controlled Content-Length is insufficient. */
async function readJson(request: Request): Promise<unknown> {
  const invalid = () =>
    new ApiError(400, '送信内容を読み取れませんでした。入力内容を確認してください。');
  if (
    !request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json') ||
    !request.body
  )
    throw invalid();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 128 * 1024) {
        await reader.cancel();
        throw invalid();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw invalid();
  }
}

function randomString(bytes = 24): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(bytes))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function tokenHash(token: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function normalizedName(name: string): string {
  return name.normalize('NFKC').toLocaleLowerCase('ja');
}

function isOperation(method: string, action?: string, memberId?: string): boolean {
  if (!action) return method === 'GET';
  if (action === 'members') return memberId ? method === 'DELETE' : method === 'POST';
  if (memberId) return false;
  return action === 'close' ? method === 'POST' : method === 'PUT';
}

export class ReceiptRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        member_id TEXT NOT NULL UNIQUE
      );
    `);
  }

  private roomById(id: string): Room {
    const rows = this.ctx.storage.sql
      .exec<{ body: string }>('SELECT body FROM rooms WHERE id = ?', id)
      .toArray();
    if (!rows[0]) throw new ApiError(404, notFound);
    return JSON.parse(rows[0].body) as Room;
  }

  private save(room: Room): Room {
    room.version++;
    room.updatedAt = new Date().toISOString();
    this.ctx.storage.sql.exec(
      'UPDATE rooms SET body = ? WHERE id = ?',
      JSON.stringify(room),
      room.id,
    );
    return room;
  }

  private authenticate(room: Room, hash: string | undefined, payerOnly = false): string {
    if (!hash)
      throw new ApiError(
        403,
        'この端末の参加情報を確認できません。共有リンクから参加してください。',
      );
    const rows = this.ctx.storage.sql
      .exec<{ member_id: string }>('SELECT member_id FROM sessions WHERE token_hash = ?', hash)
      .toArray();
    const memberId = rows[0]?.member_id;
    if (!memberId || !room.members.some((member) => member.id === memberId))
      throw new ApiError(403, 'この割り勘の参加情報を確認できません。');
    if (payerOnly && memberId !== room.payerId)
      throw new ApiError(403, 'この操作は立て替えた人だけができます。');
    return memberId;
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const match = roomRoute.exec(new URL(request.url).pathname);
      if (!match) throw new ApiError(404, notFound);
      const [, roomId, action, targetMemberId] = match;
      if (!this.ctx.id.equals(this.env.ROOMS.idFromName(roomId))) throw new ApiError(404, notFound);
      const creating = request.method === 'POST' && !action;
      if (!creating && !isOperation(request.method, action, targetMemberId))
        throw new ApiError(404, '指定された操作が見つかりません。');
      if (request.method === 'GET') return json(this.roomById(roomId));

      // Complete all I/O before loading room state. No awaits occur in transactions.
      const body = await readJson(request);
      const authorization = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(
        request.headers.get('Authorization') ?? '',
      );
      const incomingHash = authorization ? await tokenHash(authorization[1]) : undefined;
      const joining = request.method === 'POST' && action === 'members';
      const identity: Identity | undefined =
        creating || joining ? { memberId: randomString(), token: randomString(32) } : undefined;
      const newHash = identity ? await tokenHash(identity.token) : undefined;

      const result = this.ctx.storage.transactionSync<Room | SessionResponse>(() => {
        if (creating) {
          const input = parse(createSchema, body, createError);
          if (this.ctx.storage.sql.exec('SELECT id FROM rooms').toArray().length)
            throw new ApiError(409, 'この割り勘はすでに作成されています。');
          const now = new Date().toISOString();
          const room: Room = {
            id: roomId,
            title: input.title,
            payerId: identity!.memberId,
            participantCount: input.participantCount,
            items: input.items,
            total: input.total,
            members: [{ id: identity!.memberId, name: input.payerName, done: false }],
            selections: { [identity!.memberId]: [] },
            paidMemberIds: [],
            closed: false,
            createdAt: now,
            updatedAt: now,
            version: 1,
          };
          this.ctx.storage.sql.exec(
            'INSERT INTO rooms (id, body) VALUES (?, ?)',
            room.id,
            JSON.stringify(room),
          );
          this.ctx.storage.sql.exec(
            'INSERT INTO sessions (token_hash, member_id) VALUES (?, ?)',
            newHash!,
            identity!.memberId,
          );
          return { room, identity: identity! };
        }

        const room = this.roomById(roomId);
        if (joining) {
          const { name } = parse(memberSchema, body, '名前は 1〜24 文字で入力してください。');
          if (room.closed)
            throw new ApiError(
              409,
              'この割り勘は確定済みです。立て替えた人に再開をお願いしてください。',
            );
          if (room.members.some((member) => normalizedName(member.name) === normalizedName(name)))
            throw new ApiError(409, '同じ名前の人が参加しています。別の名前で参加してください。');
          if (room.participantCount !== undefined && room.members.length >= room.participantCount)
            throw new ApiError(
              409,
              `設定した ${room.participantCount} 人が参加済みです。立て替えた人に確認してください。`,
            );
          room.members.push({ id: identity!.memberId, name, done: false });
          room.selections[identity!.memberId] = [];
          this.ctx.storage.sql.exec(
            'INSERT INTO sessions (token_hash, member_id) VALUES (?, ?)',
            newHash!,
            identity!.memberId,
          );
          return { room: this.save(room), identity: identity! };
        }

        const memberId = this.authenticate(room, incomingHash, action !== 'selection');
        if (action === 'selection') {
          const input = parse(selectionSchema, body, '選んだ料理・飲み物と数を確認してください。');
          if (room.closed)
            throw new ApiError(
              409,
              '割り勘が確定したため変更できません。立て替えた人に再開をお願いしてください。',
            );
          if (input.itemIds.some((id) => !room.items.some((item) => item.id === id)))
            throw new ApiError(400, 'レシートにない内容が選ばれています。画面を更新してください。');
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
                    sum +
                    (member.id === memberId ? 0 : getSelectionQuantity(room, member.id, item)),
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
        } else if (action === 'close') {
          const input = parse(closeSchema, body, '割り勘の状態を確認してください。');
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
        } else if (action === 'paid') {
          const input = parse(paidSchema, body, '受け取りを記録する人を確認してください。');
          if (!room.closed)
            throw new ApiError(409, '金額を確定してから、受け取りを記録してください。');
          if (
            !room.members.some((member) => member.id === input.memberId) ||
            input.memberId === room.payerId
          )
            throw new ApiError(400, '受け取りを記録する参加者を選んでください。');
          room.paidMemberIds = room.paidMemberIds.filter((id) => id !== input.memberId);
          if (input.paid) room.paidMemberIds.push(input.memberId);
        } else if (action === 'members' && targetMemberId) {
          parse(z.object({}).strict(), body, '削除する参加者を確認してください。');
          if (room.closed)
            throw new ApiError(
              409,
              '割り勘が確定したため参加者を削除できません。選択を再開してから操作してください。',
            );
          if (targetMemberId === room.payerId)
            throw new ApiError(400, '立て替えた人は削除できません。');
          if (!room.members.some((member) => member.id === targetMemberId))
            throw new ApiError(404, 'この参加者が見つかりません。画面を更新してください。');
          room.members = room.members.filter((member) => member.id !== targetMemberId);
          delete room.selections[targetMemberId];
          if (room.selectionQuantities) delete room.selectionQuantities[targetMemberId];
          room.paidMemberIds = room.paidMemberIds.filter((id) => id !== targetMemberId);
          this.ctx.storage.sql.exec('DELETE FROM sessions WHERE member_id = ?', targetMemberId);
        }
        return this.save(room);
      });
      return json(result, creating || joining ? 201 : 200);
    } catch (error) {
      return failure(error);
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === '/api/health' && request.method === 'GET') return json({ ok: true });
      if (url.pathname === '/api/rooms' && request.method === 'POST') {
        const input = parse(createSchema, await readJson(request), createError);
        const roomId = randomString();
        const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
        return await stub.fetch(`https://room.internal/api/rooms/${roomId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        });
      }
      const match = roomRoute.exec(url.pathname);
      if (match && isOperation(request.method, match[2], match[3])) {
        return await env.ROOMS.get(env.ROOMS.idFromName(match[1])).fetch(request);
      }
      if (url.pathname === '/api' || url.pathname.startsWith('/api/'))
        return json({ error: '指定された操作が見つかりません。' }, 404);
      return env.ASSETS.fetch(request);
    } catch (error) {
      return failure(error);
    }
  },
} satisfies ExportedHandler<Env>;
