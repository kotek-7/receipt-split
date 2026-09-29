import type { Identity, Room, SessionResponse } from '../shared/types';

export async function request<T>(
  path: string,
  body?: unknown,
  identity?: Identity,
  method = 'POST',
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? 'GET' : method,
    headers: {
      'Content-Type': 'application/json',
      ...(identity ? { Authorization: `Bearer ${identity.token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || '通信に失敗しました。もう一度お試しください。');
  return data as T;
}

export interface RecentRoom {
  id: string;
  title: string;
  total: number;
  createdAt: string;
}
const sessionKey = (id: string) => `receipt-split:session:${id}`;
export function getIdentity(id: string): Identity | undefined {
  try {
    return JSON.parse(localStorage.getItem(sessionKey(id)) || 'null') || undefined;
  } catch {
    return undefined;
  }
}
export function getRecents(): RecentRoom[] {
  try {
    return JSON.parse(localStorage.getItem('receipt-split:recent') || '[]');
  } catch {
    return [];
  }
}
export function saveSession({ room, identity }: SessionResponse) {
  localStorage.setItem(sessionKey(room.id), JSON.stringify(identity));
  const recent = { id: room.id, title: room.title, total: room.total, createdAt: room.createdAt };
  localStorage.setItem(
    'receipt-split:recent',
    JSON.stringify([recent, ...getRecents().filter((r) => r.id !== room.id)].slice(0, 12)),
  );
}
export function canSaveSession() {
  try {
    localStorage.setItem('receipt-split:test', '1');
    localStorage.removeItem('receipt-split:test');
    return true;
  } catch {
    return false;
  }
}
export const getRoom = (id: string) => request<Room>(`/rooms/${id}`);
