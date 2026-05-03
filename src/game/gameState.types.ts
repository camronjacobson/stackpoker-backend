import { Card } from './deck';
import { PotSlice } from './potManager';

// MAP: gameState.types — server/client shared shapes (179 lines)
// - PlayerStatus / Street / GamePhase ...... L6-8
// - Seat (server-side, has hole+mucked) .... L13
// - LastAction ............................. L43
// - ServerGameState ........................ L55
// - WinnerPayout ........................... L78
// - ClientGameState (per-recipient view) ... L89
// - ClientSeat (filtered, has revealedCards) L113
// - LegalAction ............................ L137
// - WsEvent / WsMessage / payloads ......... L146-176

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
  holeCards:      Card[];          // server-only: actual cards (cleared on fold)
  // Cards as of fold — preserved so a folded player can voluntarily show them
  // after the hand. Live (non-folded) seats keep [] here. Cleared at start of
  // every new hand alongside the per-hand reset.
  mucked:         Card[];
  // Indices (into holeCards or mucked, whichever currently holds them) that
  // the seat's owner has chosen to reveal to the table. Persists for the
  // remainder of the hand display, cleared at start of next hand.
  voluntaryShownCardIndices: number[];
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
  // Cards that *would have been* dealt to complete the board if the hand had
  // run out, populated only when a hand ends before the river (everyone
  // folded preflop / on the flop / on the turn). Empty array during live
  // play. Reset every startHand. Drives the iOS "tap to reveal what was
  // next" feature so the hero can satisfy curiosity after a fold-win without
  // changing actual game state. We deliberately gate this on `phase==ENDED`
  // in buildClientView so mid-hand snapshots never leak future cards.
  runOutBoard:      Card[];
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
  // What the rest of the board would have been when the hand ended early
  // (fold-out before the river). Empty array when the board ran out
  // naturally or during live play. iOS renders these as face-down tappable
  // placeholders that flip to reveal on tap.
  revealableBoard: Card[];
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
  // Cards this seat has voluntarily exposed to the whole table (fold-show
  // tap, or auto-reveal on all-in showdown). Visible to every viewer; one
  // entry per shown card with its original hand-position index so the UI
  // can place it back over the right slot. Empty array = nothing shown.
  revealedCards:  { index: number; card: Card }[];
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
