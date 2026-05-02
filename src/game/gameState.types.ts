import { Card } from './deck';
import { PotSlice } from './potManager';

// ─── Player Status ────────────────────────────────────────────────────────────

export type PlayerStatus = 'WAITING' | 'ACTIVE' | 'FOLDED' | 'ALL_IN' | 'SITTING_OUT' | 'DISCONNECTED';
export type Street       = 'PREFLOP' | 'FLOP' | 'TURN' | 'RIVER' | 'SHOWDOWN';
export type GamePhase    = 'WAITING' | 'STARTING' | 'DEALING' | 'BETTING' | 'SHOWDOWN' | 'ENDED';
export type ActionType   = 'FOLD' | 'CHECK' | 'CALL' | 'RAISE' | 'ALL_IN' | 'SMALL_BLIND' | 'BIG_BLIND';

// ─── Seat ─────────────────────────────────────────────────────────────────────

export interface Seat {
  seatIndex:      number;
  userId:         string;
  username:       string;
  displayName:    string;
  avatarId:       string;
  stack:          number;
  status:         PlayerStatus;
  holeCards:      Card[];          // server-only: actual cards
  betThisStreet:  number;          // chips bet this street
  totalContributed: number;        // chips in pot this hand
  isDealer:       boolean;
  isSmallBlind:   boolean;
  isBigBlind:     boolean;
  timeBank:       number;          // bonus seconds (starts at 30)
  isConnected:    boolean;
  isBot?:         boolean;         // true for AI-controlled players
  lastActionAt:   number;          // unix ms
}

// ─── Last Action (broadcast-safe) ────────────────────────────────────────────

export interface LastAction {
  playerId:   string;
  username:   string;
  action:     ActionType;
  amount?:    number;
  timestamp:  number;
}

// ─── Full Server Game State ───────────────────────────────────────────────────

export type GameType = 'TEXAS_HOLDEM' | 'PLO';

export interface ServerGameState {
  tableId:          string;
  gameType:         GameType;
  handNumber:       number;
  phase:            GamePhase;
  street:           Street;
  seats:            Seat[];
  deck:             Card[];             // remaining cards
  communityCards:   Card[];
  pots:             PotSlice[];
  currentBet:       number;             // highest bet on the current street
  minRaise:         number;
  activePlayerId:   string | null;      // whose turn it is
  dealerSeatIndex:  number;
  smallBlind:       number;
  bigBlind:         number;
  actionDeadline:   number;             // unix ms
  turnDuration:     number;             // ms
  lastAction:       LastAction | null;
  winners:          WinnerPayout[] | null;
  handStartedAt:    number;
}

export interface WinnerPayout {
  playerId:  string;
  username:  string;
  amount:    number;
  handName:  string;
  bestCards: Card[];
  showCards: boolean;
}

// ─── Client-safe view (hides other players' hole cards) ───────────────────────

export interface ClientGameState {
  tableId:         string;
  gameType:        GameType;
  handNumber:      number;
  phase:           GamePhase;
  street:          Street;
  seats:           ClientSeat[];
  communityCards:  Card[];
  pots:            PotSlice[];
  totalPot:        number;
  currentBet:      number;
  minRaise:        number;
  activePlayerId:  string | null;
  dealerSeatIndex: number;
  smallBlind:      number;
  bigBlind:        number;
  actionDeadline:  number;
  turnDuration:    number;             // ms — total span of the current turn (base + time bank)
  lastAction:      LastAction | null;
  winners:         WinnerPayout[] | null;
  // Legal actions for the requesting player
  legalActions:    LegalAction[];
}

export interface ClientSeat {
  seatIndex:      number;
  userId:         string;
  username:       string;
  displayName:    string;
  avatarId:       string;
  stack:          number;
  status:         PlayerStatus;
  holeCards:      Card[] | null;     // only set for the requesting user (or at showdown)
  cardCount:      number;            // for other players
  betThisStreet:  number;
  totalContributed: number;
  isDealer:       boolean;
  isSmallBlind:   boolean;
  isBigBlind:     boolean;
  timeBank:       number;
  isConnected:    boolean;
}

export interface LegalAction {
  action:    ActionType;
  minAmount?: number;
  maxAmount?: number;
  callAmount?: number;
}

// ─── WebSocket events ─────────────────────────────────────────────────────────

export type WsEvent =
  | 'game_state'
  | 'player_joined'
  | 'player_left'
  | 'player_reconnected'
  | 'player_disconnected'
  | 'hand_started'
  | 'action_required'
  | 'player_action'
  | 'street_changed'
  | 'showdown'
  | 'hand_ended'
  | 'table_closed'
  | 'chat_message'
  | 'error'
  | 'ping' | 'pong';

export interface WsMessage<T = unknown> {
  event: WsEvent;
  data:  T;
  ts:    number;
}

// Incoming from client
export interface ActionPayload {
  tableId: string;
  action:  ActionType;
  amount?: number;
}

export interface ChatPayload {
  tableId: string;
  message: string;
}
