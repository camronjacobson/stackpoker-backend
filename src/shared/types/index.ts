// StackPoker — Shared TypeScript types

// ─── API Response Wrappers ────────────────────────────────────────────────────

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: ApiError;
  meta?: PaginationMeta;
}

export interface ApiError {
  code: string;
  message: string;
  field?: string;
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

// ─── Auth Types ───────────────────────────────────────────────────────────────

export interface TokenPayload {
  sub: string;       // userId
  username: string;
  iat: number;
  exp: number;
  jti?: string;      // JWT ID for revocation
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface RegisterRequest {
  email: string;
  password: string;
  username: string;
  displayName: string;
  avatarId: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface AppleAuthRequest {
  identityToken: string;
  authorizationCode: string;
  fullName?: {
    givenName?: string;
    familyName?: string;
  };
  username?: string;
  avatarId?: string;
}

export interface RefreshRequest {
  refreshToken: string;
}

// ─── User Types ───────────────────────────────────────────────────────────────

export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  avatarId: string;
  avatarUrl?: string;
  chipBalance: string;   // BigInt serialized
  totalWon: string;
  handsPlayed: number;
  gamesPlayed: number;
  createdAt: string;
  lastSeenAt: string;
}

export interface PrivateUser extends PublicUser {
  email?: string;
  isAdmin: boolean;
}

// ─── Table Types ──────────────────────────────────────────────────────────────

export type TableStatus = 'WAITING' | 'IN_PROGRESS' | 'PAUSED' | 'CLOSED';
export type Street = 'PREFLOP' | 'FLOP' | 'TURN' | 'RIVER' | 'SHOWDOWN';
export type ActionType = 'FOLD' | 'CHECK' | 'CALL' | 'RAISE' | 'ALL_IN' | 'SMALL_BLIND' | 'BIG_BLIND';

export interface TableSummary {
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
  owner: PublicUser;
}

// ─── Game State Types (WebSocket) ─────────────────────────────────────────────

export type CardSuit = 'S' | 'H' | 'D' | 'C';
export type CardRank = '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'T' | 'J' | 'Q' | 'K' | 'A';

export interface Card {
  suit: CardSuit;
  rank: CardRank;
}

export type PlayerStatus = 'WAITING' | 'ACTIVE' | 'FOLDED' | 'ALL_IN' | 'OUT' | 'SITTING_OUT';

export interface GamePlayer {
  userId: string;
  username: string;
  displayName: string;
  avatarId: string;
  seatIndex: number;
  stack: number;
  betAmount: number;
  status: PlayerStatus;
  isDealer: boolean;
  isSmallBlind: boolean;
  isBigBlind: boolean;
  cards?: Card[];       // only populated for the requesting user
  cardCount?: number;   // for other players, just card count
  timeBank: number;     // extra time available in seconds
  isConnected: boolean;
}

export interface Pot {
  amount: number;
  eligiblePlayerIds: string[];
  isMain: boolean;
}

export interface GameState {
  tableId: string;
  handNumber: number;
  status: 'WAITING' | 'DEALING' | 'PREFLOP' | 'FLOP' | 'TURN' | 'RIVER' | 'SHOWDOWN' | 'ENDED';
  players: GamePlayer[];
  communityCards: Card[];
  pots: Pot[];
  totalPot: number;
  currentStreet: Street;
  activePlayerId?: string;
  dealerSeatIndex: number;
  smallBlind: number;
  bigBlind: number;
  lastAction?: {
    playerId: string;
    action: ActionType;
    amount?: number;
  };
  actionDeadline?: number;   // unix timestamp ms
  turnDuration: number;      // ms allowed per turn
  winners?: Array<{
    playerId: string;
    amount: number;
    handName: string;
    bestHand: Card[];
  }>;
}

// ─── WebSocket Message Types ──────────────────────────────────────────────────

export type WsEventType =
  // Connection
  | 'join_table'
  | 'leave_table'
  | 'player_joined'
  | 'player_left'
  | 'player_reconnected'
  | 'player_disconnected'
  // Game flow
  | 'game_state'
  | 'hand_started'
  | 'deal_cards'
  | 'action_required'
  | 'player_action'
  | 'action_result'
  | 'street_changed'
  | 'showdown'
  | 'hand_ended'
  | 'game_ended'
  // Player actions (client -> server)
  | 'action_fold'
  | 'action_check'
  | 'action_call'
  | 'action_raise'
  | 'action_all_in'
  // Chat & social
  | 'table_chat'
  | 'club_chat'
  | 'friend_online'
  | 'friend_offline'
  | 'table_invite'
  // Admin
  | 'kick_player'
  | 'ban_player'
  | 'reset_table'
  | 'end_hand'
  // System
  | 'error'
  | 'ping'
  | 'pong';

export interface WsMessage<T = unknown> {
  event: WsEventType;
  data: T;
  timestamp: number;
}

export interface WsActionPayload {
  tableId: string;
  action: ActionType;
  amount?: number;
}

export interface WsJoinTablePayload {
  tableId: string;
  buyInAmount: number;
  seatIndex?: number;
}
