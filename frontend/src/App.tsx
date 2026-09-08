import { useState, useEffect, useCallback, useMemo } from "react";
import { ChannelSwitcher } from "./components/ChannelSwitcher";
import {
  ThreadList,
  type ThreadWithState,
} from "./components/sidebar/ThreadList";
import { BoardPanel } from "./components/board";
import { ChannelList } from "./components/channel/ChannelList";
import { MessageList } from "./components/channel/MessageList";
import { MessageInput } from "./components/channel/MessageInput";
import { AgentRoster, type AgentType } from "./components/channel/AgentRoster";
import { AgentDetailPanel } from "./components/channel/AgentDetailPanel";
import { ChatHeader } from "./components/channel/ChatHeader";
import {
  useTymbalConnection,
  type ArtifactEvent,
  type RosterEvent,
  type RosterStateEvent,
  type CostInfo,
} from "./hooks/useTymbalConnection";
import { useUrlState } from "./hooks/useUrlState";
import { useTheme } from "./hooks/useTheme";
import { EmptyStateChannelCreation } from "./components/focus";
import { cn } from "./lib/utils";
import {
  API_HOST,
  apiFetch,
  checkAuth,
  logout,
  submitStructuredAskResponse,
  dismissStructuredAsk,
  type AuthSession,
} from "./lib/api";
import { LoginPage } from "./components/LoginPage";
import { OnboardingPage } from "./components/OnboardingPage";
import { AuthErrorPage } from "./components/AuthErrorPage";
import { DisclaimerPage } from "./components/DisclaimerPage";
import { OAuthCallbackPage } from "./components/OAuthCallbackPage";
import { OAuthErrorPage } from "./components/OAuthErrorPage";
import { InitializeRootChannelPage } from "./components/InitializeRootChannelPage";
import { SettingsModal, type SettingsSection } from "./components/settings";
import { MobileNav, type MobileTab } from "./components/MobileNav";
import { MobileMenu } from "./components/MobileMenu";
import { RuntimeStatusDropdown } from "./components/RuntimeStatusDropdown";
import miriadLogo from "./assets/miriad-logo.svg";

// Auth mode: 'dev' (show LoginPage) or 'workos' (redirect to /auth/login)
const AUTH_MODE = import.meta.env.VITE_AUTH_MODE || (import.meta.env.PROD ? "access" : "dev");
import type { Agent, Channel, Message } from "./types";
import type { RosterAgent } from "./components/channel/MentionAutocomplete";

export function App() {
  // Check for OAuth popup pages first (before any state initialization)
  // These are loaded in popups and should render immediately without the full app
  const pathname = window.location.pathname;
  const searchParams = new URLSearchParams(window.location.search);

  // OAuth error page: /oauth-error?error=...&description=...
  if (pathname === "/oauth-error") {
    return <OAuthErrorPage />;
  }

  // OAuth success callback: any path with ?app=...&connected=true
  // Backend redirects to /spaces/{spaceId}/channels/{channelId}?app={slug}&connected=true
  if (searchParams.get("connected") === "true" && searchParams.get("app")) {
    return <OAuthCallbackPage />;
  }

  // Auth state
  const [authSession, setAuthSession] = useState<
    AuthSession | null | undefined
  >(undefined); // undefined = checking

  // Onboarding state (for new WorkOS users)
  const [onboardingToken, setOnboardingToken] = useState<string | null>(null);
  const [suggestedName, setSuggestedName] = useState<string | undefined>(
    undefined,
  );

  // Auth error state (for OAuth errors)
  const [authError, setAuthError] = useState<string | null>(null);

  // URL-based routing state
  const {
    state: urlState,
    navigateToChannel,
    toggleBoard,
    closeBoard,
    focusArtifact,
    clearArtifactFocus,
  } = useUrlState();

  // Derive state from URL
  const selectedThread = urlState.channelId;
  const boardOpen = urlState.sidebarMode === "board";

  // Theme state
  const { theme, toggleTheme } = useTheme();

  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [threads, setThreads] = useState<ThreadWithState[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(true);
  const [channels] = useState<Channel[]>([]); // Placeholder for phase 2
  // Message cache: Map<channelId, Message[]> - persists across channel switches
  // Uses Map insertion order for LRU eviction (max 10 channels)
  const [messageCache, setMessageCache] = useState<Map<string, Message[]>>(
    new Map(),
  );
  const MESSAGE_CACHE_LIMIT = 10;
  // Derive current messages from cache
  const messages = selectedThread ? messageCache.get(selectedThread) || [] : [];
  // Get current user from auth session
  const currentUser = authSession?.user.callsign || "user";
  const [isCreatingThread, setIsCreatingThread] = useState(false);
  const [roster, setRoster] = useState<RosterAgent[]>([]);
  // Increment to trigger roster reload (e.g., when runtime status changes)
  const [rosterRefreshKey, setRosterRefreshKey] = useState(0);
  // Total channel cost (sum of all agents, including archived)
  const [totalChannelCost, setTotalChannelCost] = useState(0);
  // Track which agents are "working" (sent messages but no idle frame yet)
  const [workingAgents, setWorkingAgents] = useState<Set<string>>(new Set());
  const [leader, setLeader] = useState<string | undefined>(undefined);
  const [agentTypes, setAgentTypes] = useState<AgentType[]>([]);
  const [_isStartingWorkspace, setIsStartingWorkspace] = useState(false);
  // Track channel switching to show loading instead of empty state
  const [isSwitchingChannel, setIsSwitchingChannel] = useState(false);
  // Delayed spinner - only show after 500ms to avoid flash on fast loads
  const [showLoadingSpinner, setShowLoadingSpinner] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    const stored = localStorage.getItem("sidebar-open");
    return stored !== null ? JSON.parse(stored) : true;
  });
  const [firehoseMode, setFirehoseMode] = useState(() => {
    const stored = localStorage.getItem("firehose-mode");
    return stored !== null ? JSON.parse(stored) : false;
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('cloud');
  // Disconnected state: no runtimes online AND no API key configured
  const [isDisconnected, setIsDisconnected] = useState(false);
  // Artifact event counter - increment to trigger board refresh
  const [artifactEventTrigger, setArtifactEventTrigger] = useState(0);
  // Selected agent for detail panel (callsign or null)
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  // Summon picker open state (controlled from MessageInput button)
  const [summonOpen, setSummonOpen] = useState(false);
  // Pre-selected agent slug for summon picker (set from empty state)
  const [preSelectedAgentSlug, setPreSelectedAgentSlug] = useState<string | undefined>(undefined);
  // Channel switcher (Cmd-K) open state
  const [channelSwitcherOpen, setChannelSwitcherOpen] = useState(false);
  // Recently dismissed agents (for warning when mentioning them)
  const [dismissedAgents, setDismissedAgents] = useState<Set<string>>(new Set());
  // Mobile navigation tab state
  const [mobileTab, setMobileTab] = useState<MobileTab>("channels");

  // Check authentication on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);

    // Check for auth error in URL (OAuth errors redirect here)
    const error = params.get("error");
    if (error || window.location.pathname === "/auth-error") {
      setAuthError(error || "unknown");
      // Clear URL params but keep path for bookmarking
      window.history.replaceState({}, "", "/");
      return;
    }

    // Check for onboarding token in URL (new WorkOS users)
    const token = params.get("token");
    const name = params.get("name");

    if (token) {
      // New user needs onboarding
      setOnboardingToken(token);
      setSuggestedName(name || undefined);
      // Clear URL params
      window.history.replaceState({}, "", window.location.pathname);
      return;
    }

    checkAuth().then((session) => {
      if (session) {
        setAuthSession(session);
      } else if ((AUTH_MODE === "workos" || AUTH_MODE === "access")) {
        // In prod mode, redirect to backend login endpoint
        window.location.href = `${API_HOST}/auth/login`;
      } else {
        // In dev mode, show login page
        setAuthSession(null);
      }
    });
  }, []);

  // Handle successful login
  const handleLogin = () => {
    // Re-check auth to get full session
    checkAuth().then((session) => {
      setAuthSession(session);
    });
  };

  // Handle onboarding completion
  const handleOnboardingComplete = () => {
    setOnboardingToken(null);
    setSuggestedName(undefined);
    // Re-check auth to get full session
    checkAuth().then((session) => {
      setAuthSession(session);
    });
  };

  // Get the current thread's agent name for display
  const currentThread = threads.find((t) => t.id === selectedThread);

  // Message handlers - memoized to prevent reconnections
  const handleMessage = useCallback((msg: Message) => {
    // Handle container lifecycle status messages
    if (msg.type === "status") {
      if (msg.content === "container_starting") {
        setIsStartingWorkspace(true);
        return; // Don't add to message list
      }
      if (msg.content === "container_ready") {
        setIsStartingWorkspace(false);
        return; // Don't add to message list
      }
      if (msg.content === "container_error") {
        setIsStartingWorkspace(false);
        // Let the error message through to display in the message list
      }
    }

    // Regular message - add to cache for this channel
    // Clear switching state as soon as first message arrives
    setIsSwitchingChannel((wasSwitching) => {
      if (wasSwitching) {
        console.log(
          `[ChannelSwitch] First message arrived at ${performance.now().toFixed(2)}ms (id: ${msg.id})`,
        );
      }
      return false;
    });
    setMessageCache((cache) => {
      const channelId = msg.channelId;
      const existing = cache.get(channelId) || [];
      // Merge by ULID: update existing or add new, then sort by ULID
      const messageMap = new Map(existing.map((m) => [m.id, m]));
      messageMap.set(msg.id, msg);
      // ULIDs are lexicographically sortable (chronological order)
      const updated = Array.from(messageMap.values()).sort((a, b) =>
        a.id.localeCompare(b.id),
      );

      // Build new cache, maintaining insertion order for FIFO eviction
      const newCache = new Map(cache);
      // Delete and re-add to move to end (most recent)
      newCache.delete(channelId);
      newCache.set(channelId, updated);

      // Evict least recently used channels if over limit (LRU)
      // Map maintains insertion order, so first key is least recently accessed
      while (newCache.size > MESSAGE_CACHE_LIMIT) {
        const lruKey = newCache.keys().next().value;
        if (lruKey) {
          console.log(`[MessageCache] Evicting LRU channel: ${lruKey}`);
          newCache.delete(lruKey);
        }
      }

      return newCache;
    });

    // Any agent/tool response means container is ready
    if (msg.type === "agent" || msg.type === "tool_call") {
      setIsStartingWorkspace(false);
    }

    // Mark agent as "working" when they send actual content (will clear on idle frame)
    // Also clears "pending" state since we got our first frame
    // Only trigger on actual work output (text or tool calls), not on metadata like status updates
    if (msg.senderType === "agent" && msg.sender && (msg.type === "agent" || msg.type === "tool_call")) {
      setWorkingAgents((prev) => {
        if (prev.has(msg.sender)) return prev;
        const next = new Set(prev);
        next.add(msg.sender);
        return next;
      });
      // Clear pending state - got first frame
      setRoster((prev) => {
        const idx = prev.findIndex((a) => a.callsign === msg.sender);
        if (idx === -1 || !prev[idx].isPending) return prev;
        const updated = [...prev];
        updated[idx] = { ...updated[idx], isPending: false };
        return updated;
      });
    }

    // Update roster current.status when agent status message arrives
    if (
      msg.type === "status" &&
      msg.senderType === "agent" &&
      msg.sender &&
      typeof msg.content === "object" &&
      msg.content !== null &&
      "status" in msg.content
    ) {
      const statusText = (msg.content as { status: string }).status;
      setRoster((prev) => {
        const idx = prev.findIndex((a) => a.callsign === msg.sender);
        if (idx === -1) return prev;
        const updated = [...prev];
        updated[idx] = {
          ...updated[idx],
          current: { status: statusText },
        };
        return updated;
      });
    }
  }, []);

  const handleMessageUpdate = useCallback((id: string, content: string) => {
    setMessageCache((cache) => {
      // Find which channel has this message
      for (const [channelId, msgs] of cache.entries()) {
        const idx = msgs.findIndex((m) => m.id === id);
        if (idx !== -1) {
          const updated = [...msgs];
          updated[idx] = { ...updated[idx], content };
          const newCache = new Map(cache);
          newCache.set(channelId, updated);
          return newCache;
        }
      }
      return cache;
    });
  }, []);

  // Artifact event handler - triggers board refresh
  const handleArtifactEvent = useCallback((event: ArtifactEvent) => {
    console.log("Artifact event received:", event.action, event.artifact.slug);
    // Increment trigger to cause BoardPanel to refetch
    setArtifactEventTrigger((prev) => prev + 1);
  }, []);

  // Roster event handler - real-time roster updates
  const handleRosterEvent = useCallback((event: RosterEvent) => {
    console.log("Roster event received:", event.action, event.agent.callsign);
    if (event.action === "agent_joined") {
      // Add agent to roster
      setRoster((prev) => {
        // Avoid duplicates
        if (prev.some((a) => a.callsign === event.agent.callsign)) {
          return prev;
        }
        return [
          ...prev,
          {
            callsign: event.agent.callsign,
            agentType: event.agent.agentType,
            // isOnline based on runtime status
            isOnline: event.agent.runtimeStatus === "online",
            runtimeId: event.agent.runtimeId,
            runtimeName: event.agent.runtimeName,
            runtimeStatus: event.agent.runtimeStatus,
          },
        ];
      });
    } else if (event.action === "agent_dismissed") {
      // Remove agent from roster
      setRoster((prev) =>
        prev.filter((a) => a.callsign !== event.agent.callsign),
      );
      // Also clear working state for dismissed agent
      setWorkingAgents((prev) => {
        if (!prev.has(event.agent.callsign)) return prev;
        const next = new Set(prev);
        next.delete(event.agent.callsign);
        return next;
      });
    }
  }, []);

  // Agent idle handler - clears working state when agent finishes turn
  const handleAgentIdle = useCallback((sender: string) => {
    setWorkingAgents((prev) => {
      if (!prev.has(sender)) return prev;
      const next = new Set(prev);
      next.delete(sender);
      return next;
    });
  }, []);

  // Cost frame handler - sets absolute cost per agent (SDK reports cumulative totals)
  const handleCostFrame = useCallback((callsign: string, cost: CostInfo) => {
    // Update individual agent cost in roster (absolute value, not accumulated)
    // Then recalculate total channel cost from all agents
    setRoster((prev) => {
      const idx = prev.findIndex((a) => a.callsign === callsign);
      if (idx === -1) return prev; // Agent not in roster
      const updated = [...prev];
      updated[idx] = {
        ...updated[idx],
        sessionCost: cost.totalCostUsd,
      };
      // Recalculate total from updated roster
      const total = updated.reduce((sum, agent) => sum + (agent.sessionCost || 0), 0);
      setTotalChannelCost(total);
      return updated;
    });
  }, []);

  // Roster state event handler - updates agent online/offline/connecting state in real-time
  // Tracks lastHeartbeat for client-side offline timeout (60s threshold)
  const handleRosterStateEvent = useCallback((event: RosterStateEvent) => {
    console.log(
      "Roster state event:",
      event.callsign,
      event.state,
      event.lastHeartbeat,
    );
    // Close detail panel if dismissed agent was selected (via broadcast from another client)
    if (event.state === "dismissed") {
      setSelectedAgent((current) =>
        current === event.callsign ? null : current,
      );
      // Track dismissed agent for warning when user @mentions them
      setDismissedAgents((prev) => {
        const next = new Set(prev);
        next.add(event.callsign);
        return next;
      });
    }

    setRoster((prev) => {
      // Dismissed state - remove agent from roster (archived on backend)
      if (event.state === "dismissed") {
        return prev.filter((a) => a.callsign !== event.callsign);
      }

      const idx = prev.findIndex((a) => a.callsign === event.callsign);
      if (idx === -1) {
        // Agent not in roster yet - might be joining (new or unarchived), add them
        if (event.state === "online") {
          // Remove from dismissed set if they were archived (unarchive flow)
          setDismissedAgents((dismissed) => {
            if (!dismissed.has(event.callsign)) return dismissed;
            const next = new Set(dismissed);
            next.delete(event.callsign);
            return next;
          });
          return [
            ...prev,
            {
              callsign: event.callsign,
              isOnline: true,
            },
          ];
        }
        return prev; // offline/paused for unknown agent, ignore
      }
      // Update existing agent
      const updated = [...prev];
      if (event.state === "paused") {
        // Mute event - only set isPaused, preserve online state
        updated[idx] = {
          ...updated[idx],
          isPaused: true,
        };
      } else if (event.state === "resumed") {
        // Resume event - clear isPaused
        updated[idx] = {
          ...updated[idx],
          isPaused: false,
        };
      } else if (event.state === "online") {
        // Online event - runtime is connected, agent is ready
        // DO NOT clear isPaused - that's controlled by explicit pause/resume actions
        updated[idx] = {
          ...updated[idx],
          isOnline: true,
        };
      } else if (event.state === "pending") {
        // Pending event - message routed, awaiting first frame
        updated[idx] = {
          ...updated[idx],
          isPending: true,
          lastMessageRoutedAt: event.lastMessageRoutedAt ?? new Date().toISOString(),
        };
      } else if (event.state === "offline") {
        // Offline - runtime disconnected, but preserve muted flag
        updated[idx] = {
          ...updated[idx],
          isOnline: false,
          // isPaused preserved - muted agent that goes offline stays muted
        };
      }
      // Ignore 'connecting' state - no longer relevant with local runtimes
      return updated;
    });
  }, []);

  // Sync complete handler - clears switching state when no messages
  const handleSyncComplete = useCallback(() => {
    setIsSwitchingChannel(false);
  }, []);

  // Client-side pending timeout (10s) - clears pending if agent hasn't responded
  // Note: Agent online/offline is now based on runtime status, not heartbeat
  useEffect(() => {
    const PENDING_TIMEOUT_MS = 10_000; // 10 seconds
    const CHECK_INTERVAL_MS = 2_000; // Check every 2 seconds

    const checkTimeouts = () => {
      const now = Date.now();
      setRoster((prev) => {
        let changed = false;
        const updated = prev.map((agent) => {
          // Check pending timeout - clear pending if expired (agent didn't respond in time)
          if (agent.isPending && agent.lastMessageRoutedAt) {
            const routedTime = new Date(agent.lastMessageRoutedAt).getTime();
            const isPendingStale = now - routedTime > PENDING_TIMEOUT_MS;
            if (isPendingStale) {
              console.log(
                `[PendingTimeout] Agent ${agent.callsign} pending expired (routed at: ${agent.lastMessageRoutedAt})`,
              );
              changed = true;
              return { ...agent, isPending: false };
            }
          }
          return agent;
        });
        return changed ? updated : prev;
      });
    };

    const interval = setInterval(checkTimeouts, CHECK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  // Delayed loading spinner - only show after 500ms to avoid flash on fast loads
  useEffect(() => {
    if (isSwitchingChannel) {
      const timer = setTimeout(() => {
        setShowLoadingSpinner(true);
      }, 500);
      return () => clearTimeout(timer);
    } else {
      setShowLoadingSpinner(false);
    }
  }, [isSwitchingChannel]);

  // Get newest cached message ID for incremental sync
  // ULIDs are lexicographically sortable (chronological), so we use the ID directly
  const newestCachedMessageId = selectedThread
    ? (() => {
        const cachedMsgs = messageCache.get(selectedThread);
        if (cachedMsgs && cachedMsgs.length > 0) {
          // Messages are sorted by ULID, last one is newest
          return cachedMsgs[cachedMsgs.length - 1].id;
        }
        return undefined;
      })()
    : undefined;

  // Channel WebSocket connection for real-time streaming
  // Pass wsToken from auth session to avoid re-fetching on every channel switch
  const {
    connected,
    isWaitingForResponse,
    sendMessage,
    hasMoreMessages,
    isLoadingOlder,
    requestOlderMessages,
  } = useTymbalConnection({
    channelId: selectedThread,
    onMessage: handleMessage,
    onMessageUpdate: handleMessageUpdate,
    onArtifactEvent: handleArtifactEvent,
    onRosterEvent: handleRosterEvent,
    onRosterStateEvent: handleRosterStateEvent,
    onAgentIdle: handleAgentIdle,
    onCostFrame: handleCostFrame,
    onSyncComplete: handleSyncComplete,
    currentUser,
    wsToken: authSession?.wsToken,
    newestCachedMessageId,
  });

  // Set default agents (local Cikada runtime doesn't have /agents endpoint)
  useEffect(() => {
    // Default agent for local development
    const defaultAgents = [
      {
        id: "claude-code",
        name: "Claude Code",
        description: "Agentic coding assistant with file and terminal access",
      },
    ];
    setAgents(defaultAgents);
    // Map to AgentType format for picker
    setAgentTypes(
      defaultAgents.map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description,
      })),
    );
    setAgentsLoading(false);
  }, []);

  // Fetch channels from API when authenticated
  useEffect(() => {
    // Don't fetch until auth is confirmed
    if (!authSession) return;

    async function fetchChannels() {
      try {
        const response = await apiFetch(`${API_HOST}/channels`);
        if (!response.ok) {
          throw new Error(`Failed to fetch channels: ${response.status}`);
        }
        const data = await response.json();
        // Map API response to ThreadWithState interface
        // Channels API returns: { channels: [{ id, name, description, tagline, status, createdAt }] }
        const threadList: ThreadWithState[] = (data.channels || []).map(
          (c: {
            id: string;
            name: string;
            description?: string;
            tagline?: string;
            status?: string;
            createdAt: string;
            lastActiveAt?: string;
          }) => ({
            id: c.id,
            agentId: c.id,
            agentName: c.name,
            agentType: "channel",
            agentState: c.status === "running" ? "thinking" : "idle",
            createdAt: c.createdAt,
            lastActiveAt: c.lastActiveAt,
          }),
        );
        setThreads(threadList);

        // Auto-navigate to first non-root channel if:
        // 1. No channel is selected, OR
        // 2. URL channel doesn't exist in this space (e.g., switching spaces)
        const urlChannelExists = urlState.channelId &&
          threadList.some((t) => t.id === urlState.channelId);

        if ((!urlState.channelId || !urlChannelExists) && threadList.length > 0) {
          // Find first non-root channel (root is for system config, not user work)
          const firstUserChannel = threadList.find((t) => t.agentName !== "root");
          if (firstUserChannel) {
            navigateToChannel(firstUserChannel.id);
          }
        }
      } catch (error) {
        console.error("Failed to fetch channels:", error);
        // Keep empty list on error
      } finally {
        setThreadsLoading(false);
      }
    }
    fetchChannels();
  }, [authSession]);

  // Handle thread/channel changes
  useEffect(() => {
    // Reset cold start state when changing threads
    setIsStartingWorkspace(false);

    // Don't clear messages - they're cached per channel
    // Only show switching state if we don't have cached messages for this channel
    setRoster([]);
    setTotalChannelCost(0);
    setLeader(undefined);
    // Clear agent selection on channel switch
    setSelectedAgent(null);
    // Clear dismissed agents tracking on channel switch
    setDismissedAgents(new Set());
    // Auto-switch to thread tab on mobile when channel selected
    if (selectedThread) {
      setMobileTab("thread");
      // Check cache at the time of switch (not reactive to cache changes)
      setMessageCache((cache) => {
        const hasCachedMessages =
          cache.has(selectedThread) && cache.get(selectedThread)!.length > 0;
        if (!hasCachedMessages) {
          setIsSwitchingChannel(true);
          console.log(
            `[ChannelSwitch] Started switching to channel ${selectedThread} at ${performance.now().toFixed(2)}ms (no cache)`,
          );
          return cache; // Don't modify cache - no messages yet
        } else {
          console.log(
            `[ChannelSwitch] Switched to channel ${selectedThread} (cached ${cache.get(selectedThread)!.length} messages)`,
          );
          // Move to end of Map to mark as recently accessed (LRU)
          const messages = cache.get(selectedThread)!;
          const newCache = new Map(cache);
          newCache.delete(selectedThread);
          newCache.set(selectedThread, messages);
          return newCache;
        }
      });
    }

    // Note: Roster fetch moved to happen AFTER WebSocket connects (see below)
    // This prevents HTTP request from blocking WebSocket connection
  }, [selectedThread]);

  // Fetch roster, costs, and archived agents AFTER initial paint - delayed to not compete with message sync
  useEffect(() => {
    if (!selectedThread || !connected) return;

    const timeoutId = setTimeout(() => {
      async function fetchRosterAndCosts() {
        console.log(
          `[ChannelSwitch] Starting roster fetch at ${performance.now().toFixed(2)}ms`,
        );
        try {
          // Fetch roster, costs, and archived agents in parallel
          const [rosterResponse, costsResponse, archivedResponse] = await Promise.all([
            apiFetch(`${API_HOST}/channels/${selectedThread}/roster`),
            apiFetch(`${API_HOST}/channels/${selectedThread}/costs`),
            apiFetch(`${API_HOST}/channels/${selectedThread}/agents/archived`),
          ]);

          if (!rosterResponse.ok) {
            throw new Error(`Failed to fetch roster: ${rosterResponse.status}`);
          }
          const rosterData = await rosterResponse.json();

          // Parse costs response (may fail for new channels with no costs)
          let costsByCallsign = new Map<string, number>();
          let totalCost = 0;
          if (costsResponse.ok) {
            const costsData = await costsResponse.json();
            if (costsData.tally && Array.isArray(costsData.tally)) {
              for (const t of costsData.tally) {
                costsByCallsign.set(t.callsign, t.totalCostUsd);
                totalCost += t.totalCostUsd;
              }
            }
          }
          // Update total channel cost (includes all agents, even archived)
          setTotalChannelCost(totalCost);

          // Parse archived agents response
          if (archivedResponse.ok) {
            const archivedData = await archivedResponse.json();
            if (archivedData.agents && Array.isArray(archivedData.agents)) {
              const archivedCallsigns = new Set<string>(
                archivedData.agents.map((a: { callsign: string }) => a.callsign)
              );
              setDismissedAgents(archivedCallsigns);
            }
          }

          console.log(
            `[ChannelSwitch] Roster fetch complete at ${performance.now().toFixed(2)}ms`,
          );
          // Map backend RosterEntry to frontend RosterAgent format
          if (rosterData.roster && Array.isArray(rosterData.roster)) {
            const rosterAgents: RosterAgent[] = rosterData.roster.map(
              (r: {
                callsign: string;
                agentType: string;
                status: string;
                callbackUrl?: string;
                tunnelHash?: string;
                lastHeartbeat?: string;
                current?: { status?: string };
                runtimeId?: string | null;
                runtimeName?: string;
                runtimeStatus?: 'online' | 'offline';
              }) => ({
                callsign: r.callsign,
                // isOnline: runtime is online (agent can receive messages)
                isOnline: r.runtimeStatus === "online",
                // Paused/muted status from API
                isPaused: r.status === "paused",
                // Tunnel hash for HTTP exposure
                tunnelHash: r.tunnelHash,
                // Agent type for visual identification
                agentType: r.agentType,
                // Last heartbeat for client-side timeout tracking
                lastHeartbeat: r.lastHeartbeat,
                // Initialize with persisted cost (if any)
                sessionCost: costsByCallsign.get(r.callsign) ?? 0,
                // Current agent state from set_status calls
                current: r.current,
                // Runtime binding (null = cloud)
                runtimeId: r.runtimeId,
                runtimeName: r.runtimeName,
                runtimeStatus: r.runtimeStatus,
              }),
            );
            setRoster(rosterAgents);
            // Clear working agents on channel switch (fresh start)
            setWorkingAgents(new Set());
          }
        } catch (error) {
          console.error("Failed to fetch roster:", error);
        }
      }
      fetchRosterAndCosts();
    }, rosterRefreshKey > 0 ? 0 : 250); // No delay on manual refresh, delay on initial load

    return () => clearTimeout(timeoutId);
  }, [selectedThread, connected, rosterRefreshKey]);

  // Update thread state based on isWaitingForResponse
  useEffect(() => {
    if (!selectedThread) return;
    setThreads((prev) =>
      prev.map((t) =>
        t.id === selectedThread
          ? { ...t, agentState: isWaitingForResponse ? "thinking" : "idle" }
          : t,
      ),
    );
  }, [selectedThread, isWaitingForResponse]);

  // Compute roster with isWorking state merged in
  const rosterWithWorkingState = useMemo(() => {
    return roster.map((agent) => ({
      ...agent,
      isWorking: workingAgents.has(agent.callsign),
    }));
  }, [roster, workingAgents]);

  // Sidebar toggle keyboard shortcut (Cmd+B / Ctrl+B)
  // Board toggle keyboard shortcut (Cmd+Shift+B / Ctrl+Shift+B)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "b") {
        e.preventDefault();
        if (e.shiftKey) {
          toggleBoard();
        } else {
          setSidebarOpen((prev: boolean) => !prev);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [toggleBoard]);

  // Persist sidebar state to localStorage
  useEffect(() => {
    localStorage.setItem("sidebar-open", JSON.stringify(sidebarOpen));
  }, [sidebarOpen]);

  // Persist firehose mode to localStorage
  useEffect(() => {
    localStorage.setItem("firehose-mode", JSON.stringify(firehoseMode));
  }, [firehoseMode]);

  // Cmd-K keyboard shortcut for channel switcher
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd-K (Mac) or Ctrl-K (Windows/Linux)
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setChannelSwitcherOpen((prev) => !prev);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Handle channel selection from switcher
  const handleSwitchChannel = useCallback(
    (channelId: string) => {
      navigateToChannel(channelId);
    },
    [navigateToChannel],
  );

  // Create a new channel (displayed as "thread" in UI) - legacy version
  const handleCreateThread = useCallback(
    async (agentId: string, name?: string) => {
      setIsCreatingThread(true);
      try {
        const response = await apiFetch(`${API_HOST}/channels`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: name || agentId,
            description: `Channel for ${agentId}`,
          }),
        });

        if (!response.ok) {
          throw new Error(`Failed to create channel: ${response.status}`);
        }

        const data = await response.json();
        const agent = agents.find((a) => a.id === agentId);
        const newThread: ThreadWithState = {
          id: data.channel.id,
          agentId: agentId,
          agentName: name || data.channel.name || agentId,
          agentType: agent?.name || agentId,
          agentState: "idle",
          createdAt: data.channel.createdAt || new Date().toISOString(),
        };

        setThreads((prev) => [...prev, newThread]);
        navigateToChannel(newThread.id);
      } catch (error) {
        console.error("Failed to create channel:", error);
      } finally {
        setIsCreatingThread(false);
      }
    },
    [agents, navigateToChannel],
  );

  // Create a new channel with focus area
  const handleCreateChannel = useCallback(
    async (name: string, focusSlug: string | null) => {
      setIsCreatingThread(true);
      try {
        const response = await apiFetch(`${API_HOST}/channels`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            focusSlug: focusSlug || undefined,
          }),
        });

        if (!response.ok) {
          throw new Error(`Failed to create channel: ${response.status}`);
        }

        const data = await response.json();
        const newThread: ThreadWithState = {
          id: data.channel.id,
          agentId: data.channel.id,
          agentName: data.channel.name || name,
          agentType: focusSlug || "channel",
          agentState: "idle",
          createdAt: data.channel.createdAt || new Date().toISOString(),
        };

        setThreads((prev) => [...prev, newThread]);
        navigateToChannel(newThread.id);
      } catch (error) {
        console.error("Failed to create channel:", error);
        throw error; // Re-throw so modal can handle it
      } finally {
        setIsCreatingThread(false);
      }
    },
    [navigateToChannel],
  );

  const handleSelectThread = useCallback(
    (threadId: string) => {
      navigateToChannel(threadId);
    },
    [navigateToChannel],
  );

  const handleSendMessage = useCallback(
    async (content: string, attachments?: File[]) => {
      if (!selectedThread) return;

      // Upload attachments first (inverted flow) and collect slugs
      let attachSlugs: string[] | undefined;
      if (attachments && attachments.length > 0) {
        const uploadResults = await Promise.all(
          attachments.map(async (file) => {
            const formData = new FormData();
            formData.append("file", file);
            formData.append("slug", file.name);
            formData.append("tldr", `Attachment: ${file.name}`);
            formData.append("sender", authSession?.user?.callsign || "user");
            // Note: no attachToMessageId - we'll pass slugs to message endpoint

            try {
              const response = await apiFetch(
                `/channels/${selectedThread}/assets`,
                {
                  method: "POST",
                  body: formData,
                }
              );

              if (!response.ok) {
                const error = await response.json();
                console.error("Failed to upload attachment:", error);
                return null;
              }

              const data = await response.json();
              return data.slug as string; // Backend returns final slug (may be auto-suffixed)
            } catch (err) {
              console.error("Failed to upload attachment:", err);
              return null;
            }
          })
        );

        // Filter out failed uploads
        attachSlugs = uploadResults.filter((slug): slug is string => slug !== null);
      }

      // Send message with attachment slugs
      await sendMessage(content, attachSlugs);

      // Optimistically move this channel to the top of the list (most recently active)
      setThreads((prev) => {
        const idx = prev.findIndex((t) => t.id === selectedThread);
        if (idx <= 0) return prev; // Already at top or not found
        const thread = prev[idx];
        const updated = { ...thread, lastActiveAt: new Date().toISOString() };
        return [updated, ...prev.slice(0, idx), ...prev.slice(idx + 1)];
      });
    },
    [selectedThread, sendMessage, authSession?.user?.callsign],
  );

  // Placeholder for channel selection (phase 2)
  const handleSelectChannel = useCallback((id: string) => {
    console.log("Channel selection coming in phase 2:", id);
  }, []);

  // Handle agent added to roster
  const handleAgentAdded = useCallback((agent: RosterAgent) => {
    setRoster((prev) => [...prev, agent]);
  }, []);

  // Handle agent dismissed from roster (optimistic update - API call made by panel)
  const handleAgentDismiss = useCallback((callsign: string) => {
    // Remove from local roster immediately
    setRoster((prev) => prev.filter((a) => a.callsign !== callsign));
    // Track dismissed agent for warning when user @mentions them
    setDismissedAgents((prev) => {
      const next = new Set(prev);
      next.add(callsign);
      return next;
    });
    // Close panel if dismissed agent was selected
    if (selectedAgent === callsign) {
      setSelectedAgent(null);
    }
  }, [selectedAgent]);

  // Handle agent selected in roster (toggle behavior)
  const handleAgentSelect = useCallback((callsign: string) => {
    setSelectedAgent((prev) => (prev === callsign ? null : callsign));
  }, []);

  // Handle agent panel close
  const handleAgentPanelClose = useCallback(() => {
    setSelectedAgent(null);
  }, []);

  // Handle structured ask form submission
  const handleStructuredAskSubmit = useCallback(
    async (messageId: string, response: Record<string, unknown>) => {
      if (!selectedThread) return;
      try {
        await submitStructuredAskResponse(
          selectedThread,
          messageId,
          response,
          currentUser
        );
      } catch (error) {
        console.error("Failed to submit structured ask response:", error);
      }
    },
    [selectedThread, currentUser]
  );

  // Handle structured ask form cancellation
  const handleStructuredAskCancel = useCallback(
    async (messageId: string) => {
      if (!selectedThread) return;
      try {
        await dismissStructuredAsk(selectedThread, messageId, currentUser);
      } catch (error) {
        console.error("Failed to dismiss structured ask:", error);
      }
    },
    [selectedThread, currentUser]
  );

  // Handle agent mute (optimistic update)
  const handleAgentMute = useCallback((callsign: string) => {
    setRoster((prev) => {
      const idx = prev.findIndex((a) => a.callsign === callsign);
      if (idx === -1) return prev;
      const updated = [...prev];
      updated[idx] = { ...updated[idx], isPaused: true };
      return updated;
    });
  }, []);

  // Handle agent unmute (optimistic update)
  const handleAgentUnmute = useCallback((callsign: string) => {
    setRoster((prev) => {
      const idx = prev.findIndex((a) => a.callsign === callsign);
      if (idx === -1) return prev;
      const updated = [...prev];
      updated[idx] = { ...updated[idx], isPaused: false };
      return updated;
    });
  }, []);

  // Get selected agent data from roster
  const selectedAgentData = selectedAgent
    ? rosterWithWorkingState.find((a) => a.callsign === selectedAgent)
    : null;

  // Show auth error page if there was an OAuth error
  if (authError) {
    const handleRetryAuth = () => {
      setAuthError(null);
      if ((AUTH_MODE === "workos" || AUTH_MODE === "access")) {
        window.location.href = `${API_HOST}/auth/login`;
      }
    };
    return <AuthErrorPage error={authError} onRetry={handleRetryAuth} />;
  }

  // Show onboarding page for new WorkOS users
  if (onboardingToken) {
    return (
      <OnboardingPage
        suggestedName={suggestedName}
        onboardingToken={onboardingToken}
        onComplete={handleOnboardingComplete}
        apiHost={API_HOST}
      />
    );
  }

  // Show loading while checking auth
  if (authSession === undefined) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    );
  }

  // Show login page if not authenticated (dev mode only - prod redirects to /auth/login)
  if (authSession === null) {
    return <LoginPage onLogin={handleLogin} apiHost={API_HOST} />;
  }

  // Show disclaimer page if user hasn't accepted
  if (!authSession.user.disclaimerAcceptedVersion) {
    const handleDisclaimerAccept = () => {
      // Re-check auth to get updated user with disclaimer version
      checkAuth().then((session) => {
        setAuthSession(session);
        // Navigate to home after accepting
        window.location.href = "/";
      });
    };
    return <DisclaimerPage onAccept={handleDisclaimerAccept} />;
  }

  // Initialize root channel page (for debugging onboarding/curation)
  if (pathname === "/initialize-root-channel") {
    return (
      <InitializeRootChannelPage
        onComplete={() => {
          window.location.href = "/";
        }}
      />
    );
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      {/* Unified header - spans full width */}
      <header className="h-12 flex items-center gap-2 md:gap-3 px-3 md:px-5 border-b border-border bg-card flex-shrink-0">
        {/* Branding */}
        <img src={miriadLogo} alt="Miriad" className="h-6 w-6" />
        <span className="font-semibold text-[#FF6600] text-base tracking-[0.05em]">
          MIRIAD
        </span>

        {/* Mobile: Channel name inline after logo */}
        {selectedThread && (
          <span className="md:hidden font-medium text-foreground text-base truncate max-w-[120px]">
            #{currentThread?.agentName || "channel"}
          </span>
        )}

        {/* Desktop-only: show when sidebar collapsed */}
        {selectedThread && !sidebarOpen && (
          <span className="hidden md:inline font-medium text-foreground">
            <span className="text-[#ccc] mr-3">—</span>
            #{currentThread?.agentName || "channel"}
          </span>
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Runtime status dropdown */}
        {authSession?.spaceId && (
          <RuntimeStatusDropdown
            apiHost={API_HOST}
            spaceId={authSession.spaceId}
            settingsOpen={settingsOpen}
            onOpenSettings={(section?: SettingsSection) => {
              setSettingsSection(section ?? 'cloud')
              setSettingsOpen(true)
            }}
            onRuntimeStatusChange={() => {
              // Runtime came online/offline - reload roster to update agent online states
              setRosterRefreshKey((k) => k + 1)
            }}
            onDisconnectedStateChange={setIsDisconnected}
          />
        )}

        {/* Hamburger menu (shown on both mobile and desktop) */}
        <MobileMenu
          currentUser={currentUser}
          theme={theme}
          onToggleTheme={toggleTheme}
          onOpenSettings={() => setSettingsOpen(true)}
          onLogout={logout}
        />
      </header>

      {/* Main content area - add bottom padding on mobile for nav bar */}
      <div className="flex flex-1 min-h-0 overflow-hidden pb-14 md:pb-0 relative">
        {/* Disconnected overlay - blocks interaction when no runtime and no API key */}
        {isDisconnected && !settingsOpen && (
          <div
            className="absolute inset-0 bg-background/70 z-40 pointer-events-auto"
            aria-hidden="true"
          />
        )}
        {/* Sidebar - hidden on mobile, shows as full-screen when channels tab active */}
        <aside
          className={cn(
            "flex flex-col bg-card transition-all duration-200 overflow-hidden",
            // Desktop: always has border, toggle width based on sidebarOpen
            "md:border-r md:border-border",
            sidebarOpen ? "md:w-[220px]" : "md:w-0 md:border-r-0",
            // Mobile: full-screen when channels tab, hidden otherwise (no border on mobile)
            mobileTab === "channels" ? "w-full" : "w-0",
            "md:relative" // Desktop: relative positioning
          )}
        >
          <div className="flex-1 overflow-y-auto">
            <ThreadList
              threads={threads}
              agents={agents}
              selectedThread={selectedThread}
              isCreatingThread={isCreatingThread}
              onSelectThread={handleSelectThread}
              onCreateThread={handleCreateThread}
              onCreateChannel={handleCreateChannel}
              apiHost={API_HOST}
            />
            <ChannelList
              channels={channels}
              selected={null}
              onSelect={handleSelectChannel}
            />
          </div>
        </aside>

        {/* Main chat area - hidden on mobile unless thread tab active */}
        <main
          className={cn(
            "flex-1 flex flex-col min-w-0 min-h-0 bg-background overflow-hidden",
            // Mobile: show only when thread tab active
            mobileTab === "thread" ? "flex" : "hidden md:flex"
          )}
        >
          {isCreatingThread ? (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-muted-foreground">Creating thread...</p>
            </div>
          ) : selectedThread ? (
            <>
              {/* Chat panel header */}
              <ChatHeader
                isThinking={isWaitingForResponse}
                boardOpen={boardOpen}
                onToggleBoard={toggleBoard}
                channelCost={totalChannelCost}
                sidebarOpen={sidebarOpen}
                onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
                firehoseMode={firehoseMode}
                onToggleFirehose={() => setFirehoseMode(!firehoseMode)}
              />
              <MessageList
                messages={messages}
                threadName={currentThread?.agentName}
                threadAgentType={currentThread?.agentType}
                apiHost={API_HOST}
                channelId={selectedThread || ""}
                spaceId={authSession?.spaceId}
                roster={rosterWithWorkingState}
                isSwitching={isSwitchingChannel}
                isLoading={showLoadingSpinner}
                firehoseMode={firehoseMode}
                hasMoreMessages={hasMoreMessages}
                isLoadingOlder={isLoadingOlder}
                onRequestOlderMessages={requestOlderMessages}
                onSelectStarterAgent={(agentSlug) => {
                  setPreSelectedAgentSlug(agentSlug);
                  setSummonOpen(true);
                }}
                onStructuredAskSubmit={handleStructuredAskSubmit}
                onStructuredAskCancel={handleStructuredAskCancel}
              />
              {/* Input area with detail panel + roster bar above message input */}
              <div className="border-t border-border bg-card">
                {/* Agent detail panel - appears above roster when agent selected */}
                {selectedAgentData && selectedThread && (
                  <AgentDetailPanel
                    key="agent-detail-panel"
                    agent={selectedAgentData}
                    channelId={selectedThread}
                    apiHost={API_HOST}
                    onClose={handleAgentPanelClose}
                    onDismiss={handleAgentDismiss}
                    onMute={handleAgentMute}
                    onUnmute={handleAgentUnmute}
                  />
                )}
                {/* Roster bar - horizontal row, acts as tabs */}
                <div className="px-4 pt-3 pb-2">
                  <AgentRoster
                    roster={rosterWithWorkingState}
                    leader={leader}
                    agentTypes={agentTypes}
                    channelId={selectedThread || undefined}
                    channelName={currentThread?.agentName}
                    spaceId={authSession?.spaceId}
                    apiHost={API_HOST}
                    onAgentAdded={handleAgentAdded}
                    onAgentDismiss={handleAgentDismiss}
                    onAgentSelect={handleAgentSelect}
                    selectedAgent={selectedAgent}
                    canManageAgents={!!selectedThread}
                    summonOpen={summonOpen}
                    onSummonClose={() => {
                      setSummonOpen(false);
                      setPreSelectedAgentSlug(undefined);
                    }}
                    preSelectedAgentSlug={preSelectedAgentSlug}
                    messages={messages}
                    onStructuredAskSubmit={handleStructuredAskSubmit}
                    onStructuredAskCancel={handleStructuredAskCancel}
                  />
                </div>
                {/* Message input below roster */}
                <MessageInput
                  onSend={handleSendMessage}
                  disabled={!connected}
                  roster={rosterWithWorkingState}
                  channelId={selectedThread || undefined}
                  apiHost={API_HOST}
                  onSummon={() => setSummonOpen(true)}
                  dismissedAgents={dismissedAgents}
                />
              </div>
            </>
          ) : (
            <>
              {agentsLoading || threadsLoading ? (
                <div className="flex-1 flex items-center justify-center">
                  <p className="text-muted-foreground">Loading...</p>
                </div>
              ) : (
                <EmptyStateChannelCreation
                  onCreate={handleCreateChannel}
                  apiHost={API_HOST}
                />
              )}
            </>
          )}
        </main>

        {/* Board panel - desktop: normal side panel, mobile: full-screen when board tab */}
        <div
          className={cn(
            // Mobile: full-screen when board tab active, hidden otherwise
            mobileTab === "board" ? "flex w-full" : "hidden md:flex",
            // Desktop: show based on boardOpen
            boardOpen ? "md:flex" : "md:hidden"
          )}
        >
          <BoardPanel
            channelId={selectedThread}
            isOpen={boardOpen || mobileTab === "board"}
            onClose={closeBoard}
            apiHost={API_HOST}
            spaceId={authSession?.spaceId}
            refreshTrigger={artifactEventTrigger}
            selectedArtifact={urlState.artifactSlug}
            onSelectArtifact={focusArtifact}
            onClearSelection={clearArtifactFocus}
          />
        </div>
      </div>

      {/* Mobile bottom navigation - hidden on md+ */}
      <MobileNav
        activeTab={mobileTab}
        onTabChange={setMobileTab}
        hasChannel={!!selectedThread}
      />

      {/* Settings modal */}
      <SettingsModal
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        apiHost={API_HOST}
        spaceId={authSession?.spaceId}
        initialSection={settingsSection}
      />

      {/* Channel switcher (Cmd-K) */}
      <ChannelSwitcher
        isOpen={channelSwitcherOpen}
        onClose={() => setChannelSwitcherOpen(false)}
        channels={threads}
        selectedChannelId={selectedThread}
        onSelectChannel={handleSwitchChannel}
      />
    </div>
  );
}
