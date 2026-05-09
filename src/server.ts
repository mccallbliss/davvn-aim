import 'dotenv/config'
import express, { type Request, type Response, type NextFunction } from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import cors from 'cors'
import { rateLimit } from 'express-rate-limit'
import type { User, BuddyInfo, ClientEvents, ServerEvents } from './types.js'
import {
  saveMessage,
  loadHistory,
  saveReport,
  getReportsForUser,
  touchScreenName,
  addGuestbookEntry,
  getGuestbook,
  getGuestbookAll,
  deleteGuestbookEntry,
  addSmsSignup,
  getAllSmsSignups,
} from './db.js'
import { filterMessage, checkRateLimit, isUserMuted, checkAutoMute, validateScreenName } from './moderation.js'

const PORT = parseInt(process.env.PORT || '3001')
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173'
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ''

const app = express()

// Trust the proxy in front of us (Fly's edge) so express-rate-limit
// gets the real client IP rather than the load balancer's.
app.set('trust proxy', 1)

app.use(cors({ origin: CORS_ORIGIN }))
app.use(express.json())

// ---- Rate limiters ----
// Light limits on the public POSTs so launch day doesn't get spammed.
// (Socket.IO chat has its own per-screen-name limiter in moderation.ts.)
const guestbookLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  limit: 5,                 // 5 posts per IP per window
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'You\'re posting too fast — try again in a few minutes.' },
})
const smsSignupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: 3,                 // 3 attempts per IP per hour
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many sign-up attempts — try again later.' },
})

// ---- Admin auth ----
// Tiny shared-secret middleware. If ADMIN_TOKEN is unset, all admin routes
// return 503 — better to be unreachable than accidentally wide-open.
function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!ADMIN_TOKEN) return res.status(503).json({ error: 'Admin disabled (ADMIN_TOKEN not set)' })
  const provided = req.header('x-admin-token') || ''
  if (provided !== ADMIN_TOKEN) return res.status(401).json({ error: 'Unauthorized' })
  next()
}

// Health check
app.get('/', (_req, res) => {
  res.json({
    service: 'davvn-aim',
    status: 'online',
    users: onlineUsers.size,
  })
})

app.get('/health', (_req, res) => {
  res.json({ ok: true })
})

// ---- Guestbook REST API ----
app.get('/guestbook', (_req, res) => {
  try {
    const entries = getGuestbook()
    res.json(entries)
  } catch {
    res.status(500).json({ error: 'Failed to load guestbook' })
  }
})

app.post('/guestbook', guestbookLimiter, (req, res) => {
  const { name, location, message } = req.body
  if (!name || !message) return res.status(400).json({ error: 'Name and message are required' })
  if (typeof name !== 'string' || typeof message !== 'string') return res.status(400).json({ error: 'Invalid input' })
  if (name.trim().length < 1 || name.trim().length > 30) return res.status(400).json({ error: 'Name must be 1-30 characters' })
  if (message.trim().length < 1 || message.trim().length > 500) return res.status(400).json({ error: 'Message must be 1-500 characters' })

  const filtered = filterMessage(message)
  if (!filtered.allowed) return res.status(400).json({ error: filtered.reason })

  const nameFiltered = filterMessage(name)
  if (!nameFiltered.allowed) return res.status(400).json({ error: 'Name contains inappropriate content' })

  try {
    const entry = addGuestbookEntry(name.trim(), (location || '').trim().slice(0, 50), message.trim())
    res.json(entry)
  } catch {
    res.status(500).json({ error: 'Failed to save entry' })
  }
})

// ---- SMS Signup API ----
app.post('/sms-signup', smsSignupLimiter, (req, res) => {
  const { phone } = req.body
  if (!phone || typeof phone !== 'string') return res.status(400).json({ error: 'Phone number is required' })

  const clean = phone.replace(/\D/g, '')
  if (clean.length !== 10) return res.status(400).json({ error: 'Enter a valid 10-digit phone number' })

  try {
    const entry = addSmsSignup(clean)
    res.json({ success: true, ...entry })
  } catch {
    // UNIQUE constraint means they already signed up
    res.json({ success: true, message: 'Already signed up!' })
  }
})

// ---- Admin API ----
// All routes gated by requireAdmin (X-Admin-Token: <ADMIN_TOKEN>).
// Set ADMIN_TOKEN via `fly secrets set ADMIN_TOKEN=...` before relying on it.
app.get('/admin/guestbook', requireAdmin, (req, res) => {
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '500')) || 500, 1), 5000)
  try {
    res.json(getGuestbookAll(limit))
  } catch {
    res.status(500).json({ error: 'Failed to load guestbook' })
  }
})

app.delete('/admin/guestbook/:id', requireAdmin, (req, res) => {
  try {
    const removed = deleteGuestbookEntry(req.params.id)
    if (!removed) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true, id: req.params.id })
  } catch {
    res.status(500).json({ error: 'Failed to delete entry' })
  }
})

app.get('/admin/sms-signups', requireAdmin, (_req, res) => {
  try {
    res.json(getAllSmsSignups())
  } catch {
    res.status(500).json({ error: 'Failed to load signups' })
  }
})

// ---- Express error handler (last) ----
// Catches errors from sync handlers and rejected promises that bubble up.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[express-error]', err)
  if (res.headersSent) return
  res.status(500).json({ error: 'Internal server error' })
})

const httpServer = createServer(app)
const io = new Server<ClientEvents, ServerEvents>(httpServer, {
  cors: {
    origin: CORS_ORIGIN,
    methods: ['GET', 'POST'],
  },
})

// ---- Online Users ----
const onlineUsers = new Map<string, User>() // screenName → User
const socketToUser = new Map<string, string>() // socketId → screenName

function getBuddyList(): BuddyInfo[] {
  return Array.from(onlineUsers.values()).map((u) => ({
    screenName: u.screenName,
    status: u.status,
    awayMessage: u.awayMessage,
  }))
}

function broadcastBuddyUpdate(user: User) {
  const info: BuddyInfo = {
    screenName: user.screenName,
    status: user.status,
    awayMessage: user.awayMessage,
  }
  io.emit('buddy-update', info)
}

// ---- Socket Handlers ----
io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id}`)

  // --- Sign On ---
  socket.on('sign-on', ({ screenName }) => {
    const trimmed = screenName.trim()

    // Validate screen name
    const validation = validateScreenName(trimmed)
    if (!validation.valid) {
      socket.emit('sign-on-error', { message: validation.reason || 'Invalid screen name' })
      return
    }

    // Check if name is taken by someone currently online
    if (onlineUsers.has(trimmed.toLowerCase())) {
      socket.emit('sign-on-error', { message: 'That screen name is already online' })
      return
    }

    // Check if user is muted
    if (isUserMuted(trimmed)) {
      socket.emit('sign-on-error', { message: 'This account has been temporarily suspended' })
      return
    }

    const user: User = {
      screenName: trimmed,
      status: 'online',
      awayMessage: null,
      socketId: socket.id,
      lastActive: Date.now(),
    }

    onlineUsers.set(trimmed.toLowerCase(), user)
    socketToUser.set(socket.id, trimmed.toLowerCase())
    touchScreenName(trimmed)

    console.log(`[sign-on] ${trimmed} (${onlineUsers.size} online)`)

    // Send success with current buddy list
    socket.emit('sign-on-success', {
      screenName: trimmed,
      buddyList: getBuddyList(),
    })

    // Notify everyone else
    socket.broadcast.emit('door-open', { screenName: trimmed })
    broadcastBuddyUpdate(user)
  })

  // --- Set Away ---
  socket.on('set-away', ({ message }) => {
    const key = socketToUser.get(socket.id)
    if (!key) return
    const user = onlineUsers.get(key)
    if (!user) return

    user.status = message ? 'away' : 'online'
    user.awayMessage = message
    broadcastBuddyUpdate(user)
  })

  // --- Send Message ---
  socket.on('send-message', ({ to, text }) => {
    const senderKey = socketToUser.get(socket.id)
    if (!senderKey) return
    const sender = onlineUsers.get(senderKey)
    if (!sender) return

    // Check mute
    if (isUserMuted(sender.screenName)) {
      socket.emit('message-blocked', { reason: 'Your account has been temporarily suspended' })
      return
    }

    // Rate limit
    const rateCheck = checkRateLimit(sender.screenName)
    if (!rateCheck.allowed) {
      socket.emit('message-blocked', { reason: rateCheck.reason || 'Rate limited' })
      return
    }

    // Word filter
    const filterCheck = filterMessage(text)
    if (!filterCheck.allowed) {
      socket.emit('message-blocked', { reason: filterCheck.reason || 'Message blocked' })
      return
    }

    // Save to database
    const msg = saveMessage(sender.screenName, to, text)

    // Send to recipient if online
    const recipientKey = to.toLowerCase()
    const recipient = onlineUsers.get(recipientKey)
    if (recipient) {
      io.to(recipient.socketId).emit('message', msg)
    }

    // Echo back to sender (so they see it in their window too)
    socket.emit('message', msg)

    // Update last active
    sender.lastActive = Date.now()
  })

  // --- Load History ---
  socket.on('load-history', ({ with: withUser }) => {
    const key = socketToUser.get(socket.id)
    if (!key) return
    const user = onlineUsers.get(key)
    if (!user) return

    const messages = loadHistory(user.screenName, withUser)
    socket.emit('history', { with: withUser, messages })
  })

  // --- Report User ---
  socket.on('report-user', ({ screenName, messageId, reason }) => {
    const reporterKey = socketToUser.get(socket.id)
    if (!reporterKey) return
    const reporter = onlineUsers.get(reporterKey)
    if (!reporter) return

    saveReport(reporter.screenName, screenName, messageId || null, reason)
    const reportCount = getReportsForUser(screenName)

    console.log(`[report] ${reporter.screenName} reported ${screenName} (${reportCount} total reports)`)

    // Check auto-mute
    const muted = checkAutoMute(screenName, reportCount)
    if (muted) {
      console.log(`[auto-mute] ${screenName} has been muted (${reportCount} reports)`)
      // Disconnect the muted user
      const mutedUser = onlineUsers.get(screenName.toLowerCase())
      if (mutedUser) {
        io.to(mutedUser.socketId).emit('sign-on-error', { message: 'Your account has been temporarily suspended due to reports' })
      }
    }

    socket.emit('user-reported', { success: true })
  })

  // --- Sign Off / Disconnect ---
  const handleDisconnect = () => {
    const key = socketToUser.get(socket.id)
    if (!key) return
    const user = onlineUsers.get(key)

    if (user) {
      console.log(`[sign-off] ${user.screenName} (${onlineUsers.size - 1} online)`)
      io.emit('door-close', { screenName: user.screenName })
      io.emit('buddy-offline', { screenName: user.screenName })
    }

    onlineUsers.delete(key)
    socketToUser.delete(socket.id)
  }

  socket.on('sign-off', handleDisconnect)
  socket.on('disconnect', handleDisconnect)
})

// ---- Start Server ----
httpServer.listen(PORT, () => {
  console.log(``)
  console.log(`  🏃 davvn AIM server`)
  console.log(`  ├─ http://localhost:${PORT}`)
  console.log(`  ├─ CORS: ${CORS_ORIGIN}`)
  console.log(`  ├─ admin: ${ADMIN_TOKEN ? 'enabled' : 'disabled (ADMIN_TOKEN not set)'}`)
  console.log(`  └─ waiting for connections...`)
  console.log(``)
})

// ---- Process-level safety nets ----
// Don't let a stray throw from a socket handler take the whole server
// down. Log loudly so we notice in `fly logs`.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason)
})
io.engine.on('connection_error', (err) => {
  console.error('[socket.io connection_error]', err.code, err.message)
})
