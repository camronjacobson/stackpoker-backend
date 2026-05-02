// ─── Lobby & Table Types ──────────────────────────────────────────────────────

export type TableStatus = 'WAITING' | 'IN_PROGRESS' | 'PAUSED' | 'CLOSED';

export interface CreateTableRequest {
  name: string;
  maxPlayers: number;        // 2–9
  smallBlind: number;
  bigBlind: number;
  minBuyIn: number;
  maxBuyIn: number;
  isPrivate: boolean;
  clubId?: string;
  gameType?: string;
}

export interface JoinTableRequest {
  buyInAmount: number;
  seatIndex?: number;
}

export interface TablePlayer {
  userId: string;
  username: string;
  displayName: string;
  avatarId: string;
  seatIndex: number;
  stack: string;       // BigInt as string
  isActive: boolean;
  joinedAt: string;
}

export interface TableDetail {
  id: string;
  name: string;
  joinCode: string;
  status: TableStatus;
  maxPlayers: number;
  currentPlayers: number;
  smallBlind: string;
  bigBlind: string;
  minBuyIn: string;
  maxBuyIn: string;
  isPrivate: boolean;
  clubId?: string;
  clubName?: string;
  owner: {
    id: string;
    username: string;
    displayName: string;
    avatarId: string;
  };
  players: TablePlayer[];
  createdAt: string;
}

export interface TableListItem {
  id: string;
  name: string;
  joinCode: string;
  status: TableStatus;
  maxPlayers: number;
  currentPlayers: number;
  smallBlind: string;
  bigBlind: string;
  minBuyIn: string;
  maxBuyIn: string;
  isPrivate: boolean;
  ownerUsername: string;
  ownerAvatarId: string;
  clubId?: string;
  clubName?: string;
  createdAt: string;
}

// ─── Friend Types ─────────────────────────────────────────────────────────────

export type FriendshipStatus = 'PENDING' | 'ACCEPTED' | 'BLOCKED';

export interface FriendRequest {
  id: string;
  status: FriendshipStatus;
  createdAt: string;
  sender: {
    id: string;
    username: string;
    displayName: string;
    avatarId: string;
  };
  receiver: {
    id: string;
    username: string;
    displayName: string;
    avatarId: string;
  };
}

export interface Friend {
  friendshipId: string;
  userId: string;
  username: string;
  displayName: string;
  avatarId: string;
  isOnline: boolean;
  currentTableId?: string;
  chipBalance: string;
}

export interface SearchedUser {
  id: string;
  username: string;
  displayName: string;
  avatarId: string;
  chipBalance: string;
  friendshipStatus?: FriendshipStatus | 'NONE';
  friendshipId?: string;
}

// ─── Invite Types ─────────────────────────────────────────────────────────────

export type InviteStatus = 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'EXPIRED';

export interface TableInviteDetail {
  id: string;
  status: InviteStatus;
  expiresAt: string;
  createdAt: string;
  table: {
    id: string;
    name: string;
    joinCode: string;
    smallBlind: string;
    bigBlind: string;
    currentPlayers: number;
    maxPlayers: number;
  };
  sender: {
    id: string;
    username: string;
    displayName: string;
    avatarId: string;
  };
}
