export interface User {
  screenName: string
  status: 'online' | 'away'
  awayMessage: string | null
  socketId: string
  lastActive: number
}

export interface Message {
  id: string
  from: string
  to: string
  text: string
  timestamp: number
}

export interface BuddyInfo {
  screenName: string
  status: 'online' | 'away'
  awayMessage: string | null
}

export interface Report {
  id: string
  reporter: string
  reportedUser: string
  messageId: string | null
  reason: string
  timestamp: number
}

// Client → Server events
export interface ClientEvents {
  'sign-on': (data: { screenName: string }) => void
  'set-away': (data: { message: string | null }) => void
  'send-message': (data: { to: string; text: string }) => void
  'load-history': (data: { with: string }) => void
  'report-user': (data: { screenName: string; messageId?: string; reason: string }) => void
  'sign-off': () => void
}

// Server → Client events
export interface ServerEvents {
  'sign-on-success': (data: { screenName: string; buddyList: BuddyInfo[] }) => void
  'sign-on-error': (data: { message: string }) => void
  'buddy-update': (data: BuddyInfo) => void
  'buddy-offline': (data: { screenName: string }) => void
  'message': (data: Message) => void
  'history': (data: { with: string; messages: Message[] }) => void
  'message-blocked': (data: { reason: string }) => void
  'user-reported': (data: { success: boolean }) => void
  'door-open': (data: { screenName: string }) => void
  'door-close': (data: { screenName: string }) => void
}
