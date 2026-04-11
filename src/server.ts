import 'dotenv/config'
import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import cors from 'cors'
import type { User, BuddyInfo, ClientEvents, ServerEvents } from './types.js'
import { saveMessage, loadHistory, saveReport, getReportsForUser, touchScreenName } from './db.js'
import { filterMessage, checkRateLimit, isUserMuted, checkAutoMute, validateScreenName } from './moderation.js'

const PORT = parseInt(process.env.PORT || '3001')
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173'

const app = express()
app.use(cors({ origin: CORS_ORIGIN }))

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
  console.log(`  └─ waiting for connections...`)
  console.log(``)
})
