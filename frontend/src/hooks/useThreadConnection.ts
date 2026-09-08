import { useEffect, useRef, useState, useCallback } from 'react'
import type { Message, MessageType } from '../types'
import { apiFetch, API_HOST } from '../lib/api'

// Share the deployment's API origin unless explicitly overridden.
const WS_URL = import.meta.env.VITE_WS_URL || API_HOST.replace(/^http/, 'ws') + '/stream'

// Artifact event from WebSocket stream
export interface ArtifactEvent {
  action: 'created' | 'updated' | 'archived'
  artifact: {
    slug: string
    channelId: string
    type: string
    title?: string
    tldr: string
    status: string
    parentSlug?: string
    [key: string]: unknown
  }
}

interface UseThreadConnectionOptions {
  threadId: string | null
  onMessage: (message: Message) => void
  onMessageUpdate: (id: string, content: string) => void
  onArtifactEvent?: (event: ArtifactEvent) => void
  currentUser?: string
}

interface StreamingMessage {
  buffer: string
  startedAt: number
}

/**
 * Hook for managing thread connection to AWS durable agents.
 * Handles WebSocket streaming and HTTP message sending.
 */
export function useThreadConnection({
  threadId,
  onMessage,
  onMessageUpdate,
  onArtifactEvent,
  currentUser = 'user',
}: UseThreadConnectionOptions) {
  const [connected, setConnected] = useState(false)
  const [isWaitingForResponse, setIsWaitingForResponse] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const streamingMessages = useRef<Map<string, StreamingMessage>>(new Map())

  // Process incoming WebSocket messages (GASP wire format)
  // GASP format: i=id, m=metadata (start), a=append (delta), v=value (final), t=timestamp
  const processWsMessage = useCallback(
    (data: string) => {
      try {
        const lines = data.split('\n').filter(Boolean)
        for (const line of lines) {
          const frame = JSON.parse(line)
          console.log('Parsed GASP frame:', frame)

          // GASP wire format detection:
          // - Start frame: has 'i' and 'm' (metadata)
          // - Append frame: has 'i' and 'a' (append content)
          // - Set frame: has 'i', 't' (timestamp), and 'v' (final value)
          // - Error frame: has 'error'

          if (frame.error) {
            console.error('Stream error:', frame.error, frame.message)
            return
          }

          const msgId = frame.i
          if (!msgId) {
            console.log('Frame missing id:', frame)
            return
          }

          if (frame.m !== undefined) {
            // Start frame - new streaming message
            const msgType = frame.m?.type || 'agent'

            // Skip user messages from sync - we already show them optimistically
            if (msgType === 'user') {
              console.log('Skipping user message from sync:', msgId)
              return
            }

            streamingMessages.current.set(msgId, {
              buffer: '',
              startedAt: Date.now(),
            })
            onMessage({
              id: msgId,
              channelId: threadId!,
              type: msgType as MessageType,
              content: '',
              sender: 'agent',
              senderType: 'agent',
              timestamp: new Date().toISOString(),
            })
          } else if (frame.a !== undefined) {
            // Append frame - streaming delta
            const streaming = streamingMessages.current.get(msgId)
            if (streaming) {
              streaming.buffer += frame.a
              onMessageUpdate(msgId, streaming.buffer)
            } else {
              // Late join - create message and append
              streamingMessages.current.set(msgId, {
                buffer: frame.a,
                startedAt: Date.now(),
              })
              onMessage({
                id: msgId,
                channelId: threadId!,
                type: 'agent' as MessageType,
                content: frame.a,
                sender: 'agent',
                senderType: 'agent',
                timestamp: new Date().toISOString(),
              })
            }
          } else if (frame.v !== undefined) {
            // Set frame - final value
            const msgType = frame.v?.type || 'agent'

            // Skip user messages from sync - we already show them optimistically
            if (msgType === 'user') {
              console.log('Skipping user message set frame:', msgId)
              return
            }

            // Handle tool_call as a message in the conversation stream
            if (msgType === 'tool_call') {
              console.log('Tool call:', frame.v)
              onMessage({
                id: msgId,
                channelId: threadId!,
                type: 'tool_call' as MessageType,
                content: '', // Tool calls don't have text content
                sender: 'agent',
                senderType: 'agent',
                timestamp: frame.t || new Date().toISOString(),
                toolCallId: frame.v.id,
                toolName: frame.v.name,
                toolArgs: frame.v.args,
              })
              return
            }

            // Handle tool_result as a message in the conversation stream
            if (msgType === 'tool_result') {
              console.log('Tool result:', frame.v)
              onMessage({
                id: msgId,
                channelId: threadId!,
                type: 'tool_result' as MessageType,
                content: '', // Tool results use structured output
                sender: 'agent',
                senderType: 'agent',
                timestamp: frame.t || new Date().toISOString(),
                toolResultCallId: frame.v.call_id,
                toolResultStatus: frame.v.error ? 'error' : 'success',
                toolResultOutput: frame.v.content,
                toolResultError: frame.v.error,
              })
              return
            }

            // Handle agent_complete to mark turn as done
            if (msgType === 'agent_complete' || msgType === 'sdk_complete' || msgType === 'sdk_error') {
              console.log('Agent complete:', frame.v)
              setIsWaitingForResponse(false)
              return
            }

            // Skip tool_progress - these are transient and not needed for inline display
            if (msgType === 'tool_progress') {
              return
            }

            // Handle artifact events from board operations
            if (msgType === 'artifact') {
              console.log('Artifact event:', frame.v)
              if (onArtifactEvent && frame.v?.action && frame.v?.artifact) {
                onArtifactEvent({
                  action: frame.v.action,
                  artifact: frame.v.artifact,
                })
              }
              return
            }

            const finalContent = frame.v?.content || ''
            const streaming = streamingMessages.current.get(msgId)
            if (streaming) {
              onMessageUpdate(msgId, finalContent)
              streamingMessages.current.delete(msgId)
            } else {
              // Direct set without streaming
              onMessage({
                id: msgId,
                channelId: threadId!,
                type: msgType as MessageType,
                content: finalContent,
                sender: 'agent',
                senderType: 'agent',
                timestamp: frame.t || new Date().toISOString(),
              })
            }
          }
        }
      } catch (e) {
        // Not JSON, might be plain text response
        console.log('Non-JSON message:', data, e)
      }
    },
    [threadId, onMessage, onMessageUpdate, onArtifactEvent]
  )

  // Connect to WebSocket for streaming
  useEffect(() => {
    if (!threadId) {
      wsRef.current?.close()
      wsRef.current = null
      setConnected(false)
      return
    }

    // Include threadId in WebSocket URL as query param (required by AWS handler)
    const wsUrlWithThread = `${WS_URL}?threadId=${threadId}`
    const ws = new WebSocket(wsUrlWithThread)
    wsRef.current = ws

    ws.onopen = () => {
      setConnected(true)
      // Request sync to get message history
      ws.send(JSON.stringify({
        action: 'sync',
      }))
    }

    ws.onclose = () => {
      setConnected(false)
    }

    ws.onerror = (error) => {
      console.error('WebSocket error:', error)
      setConnected(false)
    }

    ws.onmessage = (event) => {
      console.log('WS received:', event.data)
      setIsWaitingForResponse(false)
      processWsMessage(event.data as string)
    }

    return () => {
      ws.close()
    }
  }, [threadId, processWsMessage])

  // Send a user message via HTTP POST
  const sendMessage = useCallback(
    async (content: string) => {
      if (!threadId) {
        console.error('No thread selected')
        return
      }

      // Optimistically add user message to UI
      const userMsgId = `user-${Date.now()}`
      onMessage({
        id: userMsgId,
        channelId: threadId,
        type: 'user' as MessageType,
        content,
        sender: currentUser,
        senderType: 'user',
        timestamp: new Date().toISOString(),
      })

      try {
        setIsWaitingForResponse(true)
        const response = await apiFetch(`/thread/${threadId}/message`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ content }),
        })

        if (!response.ok) {
          setIsWaitingForResponse(false)
          throw new Error(`Failed to send message: ${response.status}`)
        }

        const data = await response.json()

        // If response includes agent reply (non-streaming), add it
        if (data.response) {
          onMessage({
            id: data.msgId || `agent-${Date.now()}`,
            channelId: threadId,
            type: 'agent' as MessageType,
            content: data.response,
            sender: 'agent',
            senderType: 'agent',
            timestamp: new Date().toISOString(),
          })
        }
      } catch (error) {
        console.error('Failed to send message:', error)
        setIsWaitingForResponse(false)
        // Add error message to UI
        onMessage({
          id: `error-${Date.now()}`,
          channelId: threadId,
          type: 'error' as MessageType,
          content: `Failed to send message: ${error}`,
          sender: 'system',
          senderType: 'agent',
          timestamp: new Date().toISOString(),
        })
      }
    },
    [threadId, currentUser, onMessage]
  )

  return {
    connected,
    isWaitingForResponse,
    sendMessage,
  }
}
