/**
 * Moderation system:
 * 1. Word filter — blocks messages containing banned words
 * 2. Rate limiter — max N messages per time window per user
 * 3. Report system — auto-mute after threshold
 */

// ---- Word Filter ----

const BLOCKED_WORDS = [
  // Add slurs, harassment terms, etc.
  // Keeping this minimal — customize as needed
  'slur_placeholder_1',
  'slur_placeholder_2',
]

// Also block URLs/links to prevent spam
const URL_PATTERN = /https?:\/\/\S+|www\.\S+/gi

export function filterMessage(text: string): { allowed: boolean; reason?: string } {
  // Check length
  if (text.trim().length === 0) {
    return { allowed: false, reason: 'Message cannot be empty' }
  }

  if (text.length > 500) {
    return { allowed: false, reason: 'Message too long (max 500 characters)' }
  }

  // Check blocked words
  const lower = text.toLowerCase()
  for (const word of BLOCKED_WORDS) {
    if (lower.includes(word.toLowerCase())) {
      return { allowed: false, reason: 'Message contains inappropriate content' }
    }
  }

  // Block URLs
  if (URL_PATTERN.test(text)) {
    URL_PATTERN.lastIndex = 0 // Reset regex state
    return { allowed: false, reason: 'Links are not allowed' }
  }

  return { allowed: true }
}

// ---- Rate Limiter ----

interface RateWindow {
  timestamps: number[]
}

const rateLimits = new Map<string, RateWindow>()

const MAX_MESSAGES = 10
const WINDOW_MS = 30_000 // 30 seconds

export function checkRateLimit(screenName: string): { allowed: boolean; reason?: string } {
  const now = Date.now()
  let window = rateLimits.get(screenName)

  if (!window) {
    window = { timestamps: [] }
    rateLimits.set(screenName, window)
  }

  // Remove timestamps outside the window
  window.timestamps = window.timestamps.filter((t) => now - t < WINDOW_MS)

  if (window.timestamps.length >= MAX_MESSAGES) {
    return { allowed: false, reason: 'Slow down! Too many messages. Wait a few seconds.' }
  }

  window.timestamps.push(now)
  return { allowed: true }
}

// Clean up old rate limit entries periodically
setInterval(() => {
  const now = Date.now()
  for (const [key, window] of rateLimits) {
    window.timestamps = window.timestamps.filter((t) => now - t < WINDOW_MS)
    if (window.timestamps.length === 0) {
      rateLimits.delete(key)
    }
  }
}, 60_000)

// ---- Auto-Mute ----

const MUTE_THRESHOLD = 5 // Reports needed to auto-mute
const mutedUsers = new Set<string>()

export function isUserMuted(screenName: string): boolean {
  return mutedUsers.has(screenName)
}

export function checkAutoMute(screenName: string, reportCount: number): boolean {
  if (reportCount >= MUTE_THRESHOLD) {
    mutedUsers.add(screenName)
    return true
  }
  return false
}

export function unmuteUser(screenName: string): void {
  mutedUsers.delete(screenName)
}

// ---- Screen Name Validation ----

export function validateScreenName(name: string): { valid: boolean; reason?: string } {
  const trimmed = name.trim()

  if (trimmed.length < 2) {
    return { valid: false, reason: 'Screen name must be at least 2 characters' }
  }

  if (trimmed.length > 20) {
    return { valid: false, reason: 'Screen name must be 20 characters or less' }
  }

  // Only allow alphanumeric, underscores, hyphens
  if (!/^[a-zA-Z0-9_\-]+$/.test(trimmed)) {
    return { valid: false, reason: 'Screen name can only contain letters, numbers, underscores, and hyphens' }
  }

  // Block names that impersonate davvn
  const lower = trimmed.toLowerCase()
  if (lower === 'davvn' || lower === 'dawn' || lower === 'admin' || lower === 'moderator' || lower === 'system') {
    return { valid: false, reason: 'That screen name is reserved' }
  }

  // Check word filter on screen name
  const filtered = filterMessage(trimmed)
  if (!filtered.allowed) {
    return { valid: false, reason: 'Screen name contains inappropriate content' }
  }

  return { valid: true }
}
